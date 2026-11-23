// What the window and the CLI share: the user data folder, its settings, the real services, and each operation.
import {
  capture,
  Installation,
  openWorkspace,
  run,
  type PatchWriter,
  type Resolver,
  type Shell,
  type Source,
} from "@app/apply";
import type { CaptureRequest, PatchManifest, RunReport, Settings, Stack } from "@app/contracts";
import { fileLibrary, filePatchWriter, fileStackStore, loadSettings, saveReport } from "@app/files";
import { before, library, Library, parsePatchId, saveStack, selected, type StackStore } from "@app/stack";
import { commandResolver, commandShell, gitSource, macInstallation } from "@app/system";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** The user data folder: `--userdata <folder>` (or `--data <folder>`, the starter's test harness's flag), else `fallback`. */
export const userdataFolder = (argv: ReadonlyArray<string>, fallback: string): string => {
  const flag = argv.findIndex((each) => each === "--userdata" || each === "--data");
  return (flag === -1 ? undefined : argv[flag + 1]) ?? fallback;
};

/** Where the user data folder is when none is given: under the home folder, so it outlives T3 Code upgrades. */
export const defaultUserdata = (home: string): string => `${home}/.t3/userdata/patcher`;

export class NoSettings extends Schema.TaggedError<NoSettings>()("NoSettings", {}) {
  override get message(): string {
    return "no settings: run `python3 scripts/patcher.py init`";
  }
}

/** The settings file's path; the files package keeps settings there. */
export const settingsFile = Effect.fn("settingsFile")(function* (userdata: string) {
  return (yield* Path.Path).join(userdata, "settings.json");
});

/** The settings saved in `userdata`; NoSettings if there are none yet. */
export const settingsIn = Effect.fn("settingsIn")(function* (userdata: string) {
  const exists = yield* (yield* FileSystem.FileSystem)
    .exists(yield* settingsFile(userdata))
    .pipe(Effect.orElseSucceed(() => false));
  if (!exists) return yield* new NoSettings();
  return yield* loadSettings(userdata);
});

/** The patches and the stack: all that listing and reordering patches needs. */
export const stackServices = (userdata: string, settings: Settings): Layer.Layer<Library | StackStore> =>
  Layer.merge(fileLibrary(settings.patches), fileStackStore(userdata)).pipe(Layer.provide(NodeServices.layer));

export type Services = Library | StackStore | PatchWriter | Source | Shell | Resolver | Installation;

/** Every real service for `settings`: the patches and stack, git, commands and the installed app. */
export const servicesFor = (userdata: string, settings: Settings): Layer.Layer<Services> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const logs = path.join(settings.work, "logs");
      return Layer.mergeAll(
        filePatchWriter(settings.patches),
        gitSource({ work: settings.work, repository: settings.target.repository }),
        commandShell(logs),
        commandResolver({ command: settings.resolver, logs }),
        macInstallation({ installed: settings.target.installed, backups: path.join(settings.work, "backups") }),
      );
    }),
  ).pipe(Layer.provide(NodeServices.layer), Layer.merge(stackServices(userdata, settings)));

const patchNamed = Effect.fn("patchNamed")(function* (id: string) {
  const patches = yield* (yield* Library).patches;
  return patches.find((patch) => patch.manifest.id === id);
});

/** Save a changed stack; returns the patches as they now stand. */
export const changeStack = Effect.fn("changeStack")(function* (stack: Stack) {
  yield* saveStack(stack);
  return yield* library;
});

/** Apply the patches that are on, in stack order, and keep the report as the last run. */
export const applyStack = Effect.fn("applyStack")(function* (userdata: string, settings: Settings, install: boolean) {
  const patches = yield* (yield* Library).patches;
  const { stack } = yield* library;
  const evidence = (yield* Path.Path).join(settings.work, "evidence");
  const report: RunReport = yield* run(settings.target, selected(stack, patches), install, { evidence });
  yield* saveReport(userdata, report);
  return report;
});

/** Open the workspace for patch `raw` (new or existing): the patches before it applied. Returns its folder. */
export const workspaceFor = Effect.fn("workspaceFor")(function* (settings: Settings, raw: string) {
  const id = yield* parsePatchId(raw);
  const patches = yield* (yield* Library).patches;
  const { stack } = yield* library;
  return yield* openWorkspace(settings.target, before(stack, patches, id), yield* patchNamed(id), id);
});

/** Save the changes in a patch's workspace as the patch. Returns its manifest. */
export const capturePatch = Effect.fn("capturePatch")(function* (settings: Settings, request: CaptureRequest) {
  const patch = yield* capture(settings.target, request, yield* patchNamed(request.id));
  const manifest: PatchManifest = patch.manifest;
  return manifest;
});

/** The installed app's version. */
export const installedVersion = Effect.gen(function* () {
  return yield* (yield* Installation).version;
});
