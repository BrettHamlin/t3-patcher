// What the window and the CLI share: the user data folder, its settings, the real services, and each operation.
import {
  capture,
  Installation,
  installedRecord,
  openWorkspace,
  Progress,
  PublishedPatches,
  type Synced,
  run,
  updates,
  type PatchWriter,
  type RunOptions,
  type Resolver,
  type Shell,
  type Source,
} from "@app/apply";
import {
  FEED_BRANCH,
  StepFailed,
  type CaptureRequest,
  type InstalledRecord,
  type Patch,
  type PatchManifest,
  type RunReport,
  type Settings,
  type Stack,
  type Step,
} from "@app/contracts";
import {
  fileLibrary,
  filePatchWriter,
  fileStackStore,
  loadInstalled,
  loadSettings,
  saveInstalled,
  saveReport,
} from "@app/files";
import {
  appended,
  arranged,
  before,
  library,
  Library,
  parsePatchId,
  saveStack,
  selected,
  StackStore,
} from "@app/stack";
import { commandResolver, commandShell, gitPublishedPatches, gitSource, macInstallation } from "@app/system";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

export class Busy extends Schema.TaggedError<Busy>()("Busy", { pid: Schema.Number }) {
  override get message(): string {
    return `another run is going (pid ${this.pid})`;
  }
}

/** Whether process `pid` is running: signal 0 checks without sending; EPERM means it runs as someone else. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/** Take the lock file for this process: create it holding the pid, or take it over from a process that has ended. */
const takeLock = Effect.fn("takeLock")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory((yield* Path.Path).dirname(file), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    const taken = yield* fs.writeFileString(file, `${process.pid}\n`, { flag: "wx" }).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.succeed(false),
      ),
    );
    if (taken) return;
    const pid = Number.parseInt(yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => "")), 10);
    if (attempt > 0 || (Number.isInteger(pid) && pid > 0 && alive(pid))) return yield* new Busy({ pid });
    yield* fs.remove(file, { force: true });
  }
});

/** Remove the lock file if this process still holds it. */
const dropLock = Effect.fn("dropLock")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const held = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  if (held.trim() === String(process.pid)) yield* fs.remove(file, { force: true });
});

/**
 * Run `effect` holding `<work>/patcher.lock`, so the window and the CLI never use the work folder's checkouts at once.
 * Fails with Busy while another live process holds it.
 */
export const locked = <A, E, R>(
  work: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Busy | PlatformError.PlatformError, R | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const file = (yield* Path.Path).join(work, "patcher.lock");
    return yield* Effect.acquireUseRelease(
      takeLock(file),
      () => effect,
      () => dropLock(file).pipe(Effect.ignore),
    );
  });

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

export type Services = Library | StackStore | PatchWriter | Source | Shell | Resolver | Installation | PublishedPatches;

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
        gitPublishedPatches({ source: settings.patches, clone: path.join(settings.work, "published") }),
      );
    }),
  ).pipe(Layer.provide(NodeServices.layer), Layer.merge(stackServices(userdata, settings)));

const patchNamed = Effect.fn("patchNamed")(function* (id: string) {
  const patches = yield* (yield* Library).patches;
  return patches.find((patch) => patch.manifest.id === id);
});

/** Save a changed stack, holding the lock so it can't interleave with a run or a capture; returns the patches. */
export const changeStack = Effect.fn("changeStack")(function* (work: string, stack: Stack) {
  return yield* locked(
    work,
    Effect.gen(function* () {
      yield* saveStack(stack);
      return yield* library;
    }),
  );
});

/**
 * What an installed record says besides what was installed: where updates come from, and how to run them (none when
 * the patcher wasn't run from a checkout with scripts/patcher.py).
 */
export interface RecordSource {
  readonly feed: string;
  readonly update: InstalledRecord["update"];
}

/** Saves the installed record of an install; the install step runs it right after replacing the app. */
const recorder =
  (userdata: string, source: RecordSource) =>
  (version: string, patches: ReadonlyArray<Patch>): Effect.Effect<void, StepFailed> =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* saveInstalled(userdata, installedRecord(version, patches, now, source.feed, source.update));
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.mapError((failure) => new StepFailed({ reason: failure.message })),
    );

/**
 * Apply the patches that are on, in stack order, and keep the report as the last run. An install saves the
 * installed record as soon as the app is replaced. Holds the lock throughout.
 */
export const applyStack = Effect.fn("applyStack")(function* (
  userdata: string,
  settings: Settings,
  install: boolean,
  source: RecordSource,
) {
  const evidence = (yield* Path.Path).join(settings.work, "evidence");
  return yield* locked(
    settings.work,
    Effect.gen(function* () {
      const patches = yield* (yield* Library).patches;
      const { stack } = yield* library;
      const chosen = selected(stack, patches);
      const report: RunReport = yield* run(settings.target, chosen, install, { evidence }, {
        record: recorder(userdata, source),
      });
      yield* saveReport(userdata, report);
      return report;
    }),
  );
});

/** How `update` is asked to run: the app version to build, and the running app's pid to quit and open again. */
export interface UpdateRequest {
  readonly t3?: string;
  readonly relaunch?: number;
}

const short = (commit: string): string => commit.slice(0, 7);

const pull = (status: Step["status"], note: string): Step => ({ kind: "pull", name: "patches", status, note });

/** The pull step's note: what the sync of the published clone did. */
export const syncedNote = (synced: Synced): string => {
  if (synced.from === null) return `cloned ${synced.url} at ${short(synced.to)}`;
  if (synced.from === synced.to) return `up to date at ${short(synced.to)}`;
  return `${short(synced.from)} → ${short(synced.to)}${synced.reset ? " (reset to the published branch)" : ""}`;
};

const libraryIn = (folder: string) => fileLibrary(folder).pipe(Layer.provide(NodeServices.layer));

/**
 * Update: sync the published patches (a clone of the patches repository's origin, under the work folder, which
 * nothing else edits) to their published branch; patches that are new there join the stack on. Then apply the
 * stack, with the published patches, and install it, building `request.t3` if given, else the installed version.
 * Patches rebased onto that version aren't saved: the clone stays as published. Each report is saved as the last run
 * as it changes, so the app can follow it; the first step is the pull. Nothing is installed unless every step
 * passes; the install saves the installed record right after replacing the app. Holds the lock throughout.
 */
export const updateStack = Effect.fn("updateStack")(function* (
  userdata: string,
  settings: Settings,
  request: UpdateRequest,
  source: RecordSource,
) {
  const evidence = (yield* Path.Path).join(settings.work, "evidence");
  return yield* locked(
    settings.work,
    Effect.gen(function* () {
      const progress = yield* Progress;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tell = Effect.fn("tell")(function* (report: RunReport) {
        yield* progress.report(report);
        yield* saveReport(userdata, report).pipe(
          Effect.ignore,
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      });
      yield* tell({ version: "", install: true, steps: [pull("running", "")] });
      const published = yield* PublishedPatches;
      const pulled = yield* Effect.gen(function* () {
        const folder = yield* published.folder;
        // Before the sync: the published patches last used, or, the first time, the patches folder.
        const last = (yield* fs.exists(folder).pipe(Effect.orElseSucceed(() => false))) ? folder : settings.patches;
        const was = yield* library.pipe(Effect.provide(libraryIn(last)));
        const synced = yield* published.sync(FEED_BRANCH);
        return { folder, was, synced };
      }).pipe(Effect.result);
      if (Result.isFailure(pulled)) {
        const reason = pulled.failure._tag === "StepFailed" ? pulled.failure.reason : pulled.failure.message;
        const failed: RunReport = { version: "", install: true, steps: [pull("failed", reason)] };
        yield* tell(failed);
        return failed;
      }
      const { folder, was, synced } = pulled.success;
      const pulledStep = pull("passed", syncedNote(synced));
      const publishedLibrary = libraryIn(folder);
      const patches = yield* Library.use((found) => found.patches).pipe(Effect.provide(publishedLibrary));
      const stack = yield* saveStack(was.stack).pipe(Effect.provide(publishedLibrary));
      const chosen = selected(stack, patches);
      const installed = yield* (yield* Installation).version.pipe(Effect.orElseSucceed(() => "unknown"));
      const updating = updates({
        app: settings.target.name,
        t3: { from: installed, to: request.t3 ?? installed },
        installed: Option.getOrUndefined(yield* loadInstalled(userdata).pipe(Effect.orElseSucceed(() => Option.none()))),
        before: was.patches,
        patches: chosen,
      });
      const withPull = (report: RunReport): RunReport => ({ ...report, steps: [pulledStep, ...report.steps] });
      const prefixed = Layer.succeed(Progress)({ report: Effect.fn("Progress.report")((report) => tell(withPull(report))) });
      const options: RunOptions = {
        updating,
        save: false,
        record: recorder(userdata, source),
        ...(request.t3 === undefined ? {} : { version: request.t3 }),
        ...(request.relaunch === undefined ? {} : { relaunch: request.relaunch }),
      };
      const report = withPull(
        yield* run(settings.target, chosen, true, { evidence }, options).pipe(Effect.provide(prefixed)),
      );
      yield* saveReport(userdata, report);
      return report;
    }),
  );
});

/** `searchPath` (a PATH value) with each folder once, where it first appears. */
export const distinctPath = (searchPath: string): string =>
  [...new Set(searchPath.split(":").filter((folder) => folder !== ""))].join(":");

/** The first `name` in the folders of `searchPath` (a PATH value), as an absolute path; undefined if none has it. */
export const onPath = Effect.fn("onPath")(function* (name: string, searchPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const folder of searchPath.split(":")) {
    if (!path.isAbsolute(folder)) continue;
    const candidate = path.join(folder, name);
    const info = yield* fs.stat(candidate).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "File") return candidate;
  }
  return undefined;
});

/**
 * How the app runs this repository's `update` with `userdata`: python3 (absolute, found on `searchPath`) running
 * scripts/patcher.py in `repository`, with `searchPath` (each folder once) as its PATH. The app runs it without a
 * shell, with that PATH, so an update it starts finds the same python3 and tools and records the same again.
 */
export const updateCommand = Effect.fn("updateCommand")(function* (
  repository: string,
  userdata: string,
  searchPath: string,
) {
  const path = yield* Path.Path;
  const kept = distinctPath(searchPath);
  const python = (yield* onPath("python3", kept)) ?? "/usr/bin/python3";
  const command = [python, path.join(repository, "scripts", "patcher.py"), "update", "--userdata", path.resolve(userdata)];
  const update: InstalledRecord["update"] = { command, cwd: repository, path: kept };
  return update;
});

/**
 * How the app runs `update` for these settings: from the checkout that holds the patches folder (its nearest
 * folder with .git), when that checkout has scripts/patcher.py; else none, and updates run from the command line.
 */
export const updateSource = Effect.fn("updateSource")(function* (
  settings: Settings,
  userdata: string,
  searchPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  let folder = path.resolve(settings.patches);
  while (!(yield* exists(path.join(folder, ".git"))) && path.dirname(folder) !== folder) folder = path.dirname(folder);
  if (!(yield* exists(path.join(folder, "scripts", "patcher.py")))) return undefined;
  return yield* updateCommand(folder, userdata, searchPath);
});

/** Open the workspace for patch `raw` (new or existing): the patches before it applied. Returns its folder. */
export const workspaceFor = Effect.fn("workspaceFor")(function* (settings: Settings, raw: string) {
  const id = yield* parsePatchId(raw);
  return yield* locked(
    settings.work,
    Effect.gen(function* () {
      const patches = yield* (yield* Library).patches;
      const { stack } = yield* library;
      return yield* openWorkspace(settings.target, before(stack, patches, id), yield* patchNamed(id), id);
    }),
  );
});

/**
 * Save the changes in a patch's workspace as the patch. A new patch goes last in the stack, on: its workspace had
 * every patch that is on applied. Returns its manifest.
 */
export const capturePatch = Effect.fn("capturePatch")(function* (settings: Settings, request: CaptureRequest) {
  return yield* locked(
    settings.work,
    Effect.gen(function* () {
      const existing = yield* patchNamed(request.id);
      const patch = yield* capture(settings.target, request, existing);
      if (existing === undefined) {
        const patches = yield* (yield* Library).patches;
        yield* saveStack(appended(arranged(patches, yield* (yield* StackStore).load), request.id));
      }
      const manifest: PatchManifest = patch.manifest;
      return manifest;
    }),
  );
});

/** The installed app's version. */
export const installedVersion = Effect.gen(function* () {
  return yield* (yield* Installation).version;
});

/**
 * electron-builder downloads Electron into <home>/Library/Caches/electron whatever the environment says, so that
 * folder becomes a link to `cache` (on the work folder's drive). A real folder already there is left alone: says
 * how to move it. Returns the line to print.
 */
export const linkElectronCache = Effect.fn("linkElectronCache")(function* (home: string, cache: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const link = path.join(home, "Library", "Caches", "electron");
  const target = yield* fs.readLink(link).pipe(Effect.option);
  if (Option.isSome(target)) return `electron download cache: ${link} -> ${target.value} (kept)`;
  if (yield* fs.exists(link)) {
    return `electron download cache: ${link} is a folder on this drive; move its contents to ${cache}, delete it, and run init --force to link it`;
  }
  yield* fs.makeDirectory(cache, { recursive: true });
  yield* fs.makeDirectory(path.dirname(link), { recursive: true });
  yield* fs.symlink(cache, link);
  return `electron download cache: linked ${link} -> ${cache}`;
});
