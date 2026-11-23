// The main process: the composition root for real services. Usage: electron . [--userdata <folder>]
import { Progress } from "@app/apply";
import { Answer, CaptureRequest, LibraryView, PatchManifest, PatcherChannel, RunReport, Stack } from "@app/contracts";
import { loadReport } from "@app/files";
import { library } from "@app/stack";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { app, autoUpdater as nativeUpdater, BrowserWindow, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";

import {
  applyStack,
  capturePatch,
  changeStack,
  defaultUserdata,
  servicesFor,
  settingsIn,
  stackServices,
  userdataFolder,
  workspaceFor,
} from "./services.ts";

class AlreadyRunning extends Schema.TaggedError<AlreadyRunning>()("AlreadyRunning", {}) {
  override get message(): string {
    return "a run is already going";
  }
}

class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", { what: Schema.String }) {
  override get message(): string {
    return this.what;
  }
}

/** Run `effect` and send its result as an Answer: the value, or what went wrong in words. */
const respond = <A, I>(
  schema: Schema.Codec<A, I>,
  effect: Effect.Effect<A, { readonly message: string }>,
): Promise<unknown> =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (failure) => ({ ok: false as const, error: failure.message }),
        onSuccess: (value) => ({ ok: true as const, value }),
      }),
      Effect.catchDefect(() => Effect.succeed({ ok: false as const, error: "something went wrong in the app" })),
      Effect.flatMap(Schema.encodeEffect(Answer(schema))),
      Effect.orElseSucceed(() => ({ ok: false, error: "the answer couldn't be sent" })),
    ),
  );

const decodeStack = Schema.decodeUnknownEffect(Stack);
const decodeCapture = Schema.decodeUnknownEffect(CaptureRequest);
const encodeReport = Schema.encodeEffect(RunReport);

const node = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

const serve = (window: BrowserWindow, userdata: string, running: Ref.Ref<boolean>): void => {
  const settings = node(settingsIn(userdata));
  // Each report of a run, as it changes, goes to the window.
  const progress = Layer.succeed(Progress)({
    report: Effect.fn("Progress.report")(function* (report) {
      const encoded = yield* encodeReport(report).pipe(Effect.option);
      if (Option.isSome(encoded) && !window.isDestroyed()) window.webContents.send(PatcherChannel.report, encoded.value);
    }),
  });

  ipcMain.handle(PatcherChannel.library, () =>
    respond(
      LibraryView,
      Effect.gen(function* () {
        const found = yield* settings;
        return yield* library.pipe(Effect.provide(stackServices(userdata, found)));
      }),
    ),
  );

  ipcMain.handle(PatcherChannel.saveStack, (_event, data: unknown) =>
    respond(
      LibraryView,
      Effect.gen(function* () {
        const stack = yield* decodeStack(data).pipe(Effect.mapError(() => new BadRequest({ what: "not a stack" })));
        const found = yield* settings;
        return yield* changeStack(stack).pipe(Effect.provide(stackServices(userdata, found)));
      }),
    ),
  );

  ipcMain.handle(PatcherChannel.apply, (_event, install: unknown) =>
    respond(
      RunReport,
      Effect.gen(function* () {
        const found = yield* settings;
        if (!(yield* Ref.getAndSet(running, true))) {
          return yield* applyStack(userdata, found, install === true).pipe(
            Effect.provide(Layer.mergeAll(servicesFor(userdata, found), progress, NodeServices.layer)),
            Effect.ensuring(Ref.set(running, false)),
          );
        }
        return yield* new AlreadyRunning();
      }),
    ),
  );

  ipcMain.handle(PatcherChannel.lastReport, () =>
    respond(Schema.NullOr(RunReport), node(loadReport(userdata)).pipe(Effect.map(Option.getOrNull))),
  );

  ipcMain.handle(PatcherChannel.workspace, (_event, id: unknown) =>
    respond(
      Schema.String,
      Effect.gen(function* () {
        const found = yield* settings;
        return yield* workspaceFor(found, typeof id === "string" ? id : "").pipe(
          Effect.provide(Layer.merge(servicesFor(userdata, found), NodeServices.layer)),
        );
      }),
    ),
  );

  ipcMain.handle(PatcherChannel.capture, (_event, data: unknown) =>
    respond(
      PatchManifest,
      Effect.gen(function* () {
        const request = yield* decodeCapture(data).pipe(
          Effect.mapError(() => new BadRequest({ what: "a patch needs a valid name, a title and a summary" })),
        );
        const found = yield* settings;
        return yield* capturePatch(found, request).pipe(
          Effect.provide(Layer.merge(servicesFor(userdata, found), NodeServices.layer)),
        );
      }),
    ),
  );
};

const open = async (): Promise<void> => {
  await app.whenReady();
  const userdata = userdataFolder(process.argv, defaultUserdata(app.getPath("home")));
  const window = new BrowserWindow({
    width: 900,
    height: 820,
    title: "T3 Patcher",
    webPreferences: {
      preload: `${import.meta.dirname}/preload.cjs`,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  serve(window, userdata, Ref.makeUnsafe(false));
  await window.loadFile(`${import.meta.dirname}/renderer/index.html`);
};

// Updates: a packaged app built with an update feed (scripts/package.py, $BSTACK_UPDATE_URL) checks it at start,
// downloads a newer version (electron-updater checks its SHA-512) and installs it when the app quits. Each step is a
// line on stdout, which the update test reads; `update ready` means quitting now installs it.
const checkForUpdates = async (): Promise<void> => {
  if (!app.isPackaged) return;
  autoUpdater.on("update-available", (info) => process.stdout.write(`update available: ${info.version}\n`));
  autoUpdater.on("update-not-available", () => process.stdout.write("update not available\n"));
  autoUpdater.on("update-downloaded", (info) => {
    process.stdout.write(`update downloaded: ${info.version}\n`);
    // On macOS, Squirrel still has to fetch and stage the update before quitting installs it.
    if (process.platform === "darwin") {
      nativeUpdater.once("update-downloaded", () => process.stdout.write(`update ready: ${info.version}\n`));
    } else {
      process.stdout.write(`update ready: ${info.version}\n`);
    }
  });
  autoUpdater.on("error", (error) => process.stdout.write(`update error: ${error.message}\n`));
  const result = await autoUpdater.checkForUpdates();
  // The download runs on after the check returns; awaiting it keeps a failed download inside the catch below.
  await result?.downloadPromise;
};

app.on("window-all-closed", () => app.quit());
open().catch(() => app.exit(1));
checkForUpdates().catch((error: unknown) => {
  process.stdout.write(`update error: ${error instanceof Error ? error.message : "unknown"}\n`);
});
