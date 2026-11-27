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
  PatchManifest,
  StepFailed,
  type CaptureRequest,
  type InstalledRecord,
  type Patch,
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
  loadReport,
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
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { defaultVerifyWorkers, parseVerifyWorkers } from "./text.ts";

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
 * Fails with Busy while another live process holds it, unless `inheritedOwnerPid` names the parent holding it for us.
 */
export const locked = <A, E, R>(
  work: string,
  effect: Effect.Effect<A, E, R>,
  inheritedOwnerPid?: number,
): Effect.Effect<A, E | Busy | PlatformError.PlatformError, R | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = (yield* Path.Path).join(work, "patcher.lock");
    if (inheritedOwnerPid !== undefined && inheritedOwnerPid > 0 && alive(inheritedOwnerPid)) {
      const held = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      if (held.trim() === String(inheritedOwnerPid)) return yield* effect;
    }
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

const hostVerifyWorkers = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const probe = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("sysctl", ["-n", "hw.logicalcpu", "hw.memsize"], { stdin: "ignore" }),
      );
      const [out, code] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return code === 0 ? out : "";
    }),
  ).pipe(Effect.orElseSucceed(() => ""));
  const [coresRaw = "", memRaw = ""] = probe.trim().split(/\s+/);
  const cores = Number.parseInt(coresRaw, 10);
  const memoryBytes = Number.parseInt(memRaw, 10);
  return Number.isFinite(cores) && Number.isFinite(memoryBytes) ? defaultVerifyWorkers(cores, memoryBytes) : 1;
});

/** Reads `verify_workers` from `<home>/.config/b-stack/config.toml`, else this machine's default; undefined when invalid. */
export const resolvedVerifyWorkers = Effect.fn("resolvedVerifyWorkers")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fallback = yield* hostVerifyWorkers;
  const file = path.join(home, ".config/b-stack/config.toml");
  const text = (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))
    ? yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
    : "";
  return parseVerifyWorkers(text, fallback);
});

/** Every real service for `settings`: the patches and stack, git, commands and the installed app. */
export const servicesFor = (userdata: string, settings: Settings): Layer.Layer<Services> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const logs = path.join(settings.work, "logs");
      const home = Option.getOrElse(
        yield* Config.option(Config.String("HOME")).pipe(Effect.orElseSucceed(() => Option.none<string>())),
        () => "",
      );
      const verifyWorkers =
        (home === "" ? undefined : yield* resolvedVerifyWorkers(home)) ?? (yield* hostVerifyWorkers);
      const shellDefaults = {
        BSTACK_VERIFY_WORKERS: String(verifyWorkers),
        npm_config_prefer_offline: "true",
      };
      return Layer.mergeAll(
        filePatchWriter(settings.patches),
        gitSource({ work: settings.work, repository: settings.target.repository }),
        commandShell(logs, shellDefaults),
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

export const PrePulled = Schema.Struct({
  folder: Schema.String,
  before: Schema.Array(PatchManifest),
  synced: Schema.Struct({
    url: Schema.String,
    from: Schema.NullOr(Schema.String),
    to: Schema.String,
    reset: Schema.Boolean,
  }),
  lockPid: Schema.optionalKey(Schema.Int),
});
export type PrePulled = typeof PrePulled.Type;

export const PREPULLED_ENV = "T3_PATCHER_PREPULLED";
const prepulledJson = Schema.fromJsonString(PrePulled);
export const decodePrePulled = Schema.decodeUnknownEffect(prepulledJson);
const encodePrePulled = Schema.encodeEffect(prepulledJson);

/** Reads and removes `T3_PATCHER_PREPULLED` from `process.env` so no child process inherits stale handoff data. */
export const consumePrePulledEnv = (): string | undefined => {
  const raw = process.env[PREPULLED_ENV];
  delete process.env[PREPULLED_ENV];
  return raw;
};

/** How `update` is asked to run: the app version to build, the running app's pid to quit and open again, and any pre-synced published state. */
export interface UpdateRequest {
  readonly t3?: string;
  readonly relaunch?: number;
  readonly prePulled?: PrePulled;
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

/** The git checkout holding `patchesFolder`, when it has `scripts/patcher.py`. */
const patcherCheckout = Effect.fn("patcherCheckout")(function* (patchesFolder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  let folder = path.resolve(patchesFolder);
  while (!(yield* exists(path.join(folder, ".git"))) && path.dirname(folder) !== folder) {
    folder = path.dirname(folder);
  }
  const script = path.join(folder, "scripts", "patcher.py");
  return (yield* exists(script)) ? { checkout: folder, script } : undefined;
});

const pullPublished = Effect.fn("pullPublished")(function* (settings: Settings) {
  const fs = yield* FileSystem.FileSystem;
  const published = yield* PublishedPatches;
  const folder = yield* published.folder;
  // Before the sync: the published patches last used, or, the first time, the patches folder.
  const last = (yield* fs.exists(folder).pipe(Effect.orElseSucceed(() => false))) ? folder : settings.patches;
  const was = yield* library.pipe(Effect.provide(libraryIn(last)));
  const synced = yield* published.sync(FEED_BRANCH);
  const pulled: PrePulled = { folder, before: [...was.patches], synced };
  return pulled;
});

const applyPulled = Effect.fn("applyPulled")(function* (
  userdata: string,
  settings: Settings,
  request: UpdateRequest,
  source: RecordSource,
  pulled: PrePulled,
  tell: (report: RunReport) => Effect.Effect<void>,
) {
  const evidence = (yield* Path.Path).join(settings.work, "evidence");
  const pulledStep = pull("passed", syncedNote(pulled.synced));
  const publishedLibrary = libraryIn(pulled.folder);
  const storeLayer = fileStackStore(userdata).pipe(Layer.provide(NodeServices.layer));
  const patches = yield* Library.use((found) => found.patches).pipe(Effect.provide(publishedLibrary));
  const saved = yield* StackStore.use((store) => store.load).pipe(Effect.provide(storeLayer));
  const stack = yield* saveStack(saved).pipe(Effect.provide(Layer.merge(publishedLibrary, storeLayer)));
  const chosen = selected(stack, patches);
  const installed = yield* (yield* Installation).version.pipe(Effect.orElseSucceed(() => "unknown"));
  const updating = updates({
    app: settings.target.name,
    t3: { from: installed, to: request.t3 ?? installed },
    installed: Option.getOrUndefined(yield* loadInstalled(userdata).pipe(Effect.orElseSucceed(() => Option.none()))),
    before: pulled.before,
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
  const report = withPull(yield* run(settings.target, chosen, true, { evidence }, options).pipe(Effect.provide(prefixed)));
  yield* saveReport(userdata, report);
  return report;
});

const reporter = Effect.fn("reporter")(function* (userdata: string) {
  const progress = yield* Progress;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return Effect.fn("tell")(function* (report: RunReport) {
    yield* progress.report(report);
    yield* saveReport(userdata, report).pipe(
      Effect.ignore,
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  });
});

const pullAndReport = Effect.fn("pullAndReport")(function* (
  settings: Settings,
  tell: (report: RunReport) => Effect.Effect<void>,
) {
  yield* tell({ version: "", install: true, steps: [pull("running", "")] });
  const pulled = yield* pullPublished(settings).pipe(Effect.result);
  if (Result.isFailure(pulled)) {
    const reason = pulled.failure._tag === "StepFailed" ? pulled.failure.reason : pulled.failure.message;
    const failed: RunReport = { version: "", install: true, steps: [pull("failed", reason)] };
    yield* tell(failed);
    return Result.fail(failed);
  }
  return Result.succeed(pulled.success);
});

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
  return yield* locked(
    settings.work,
    Effect.gen(function* () {
      const tell = yield* reporter(userdata);
      if (request.prePulled !== undefined) {
        return yield* applyPulled(userdata, settings, request, source, request.prePulled, tell);
      }
      const pulled = yield* pullAndReport(settings, tell);
      return Result.isFailure(pulled)
        ? pulled.failure
        : yield* applyPulled(userdata, settings, request, source, pulled.success, tell);
    }),
    request.prePulled?.lockPid,
  );
});

export interface PublishedUpdateInput {
  readonly userdata: string;
  readonly settings: Settings;
  readonly request: UpdateRequest;
  readonly source: RecordSource;
  readonly runningRepository: string;
  readonly searchPath: string;
  readonly pythonCommand?: string;
  readonly onOutput?: {
    readonly stdout: (chunk: string) => Effect.Effect<void>;
    readonly stderr: (chunk: string) => Effect.Effect<void>;
  };
}

export type PublishedUpdateOutcome =
  | { readonly kind: "in-process"; readonly report: RunReport }
  | { readonly kind: "handed-off"; readonly code: number }
  | { readonly kind: "failed-before-cli"; readonly report: RunReport; readonly code: number };

/**
 * Syncs `<work>/published` to the published branch first while holding `<work>/patcher.lock`; when that clone holds its
 * own `scripts/patcher.py` (and this process wasn't already handed `prePulled`), invalidates any stale CLI bundle if
 * the commit changed and runs `scripts/patcher.py` from `<work>/published` under the same lock so changes to
 * `t3-patcher` itself always build and run automatically.
 */
export const runPublishedUpdate = Effect.fn("runPublishedUpdate")(function* (input: PublishedUpdateInput) {
  const path = yield* Path.Path;
  const resolvedUserdata = path.resolve(input.userdata);
  if (input.request.prePulled !== undefined) {
    const report = yield* updateStack(resolvedUserdata, input.settings, input.request, input.source);
    const inProcess: PublishedUpdateOutcome = { kind: "in-process", report };
    return inProcess;
  }
  const fs = yield* FileSystem.FileSystem;
  const tell = yield* reporter(resolvedUserdata);
  return yield* locked(
    input.settings.work,
    Effect.gen(function* () {
      const pulled = yield* pullAndReport(input.settings, tell);
      if (Result.isFailure(pulled)) {
        const done: PublishedUpdateOutcome = { kind: "in-process", report: pulled.failure };
        return done;
      }
      const targetPatcher = yield* patcherCheckout(pulled.success.folder);
      if (targetPatcher === undefined) {
        const report = yield* applyPulled(
          resolvedUserdata,
          input.settings,
          input.request,
          input.source,
          pulled.success,
          tell,
        );
        const done: PublishedUpdateOutcome = { kind: "in-process", report };
        return done;
      }
      if (pulled.success.synced.from !== pulled.success.synced.to) {
        yield* fs
          .remove(path.join(targetPatcher.checkout, "apps", "desktop", "dist", "cli.cjs"), { force: true })
          .pipe(Effect.ignore);
      }
      const runningBin = path.join(path.resolve(input.runningRepository), "node_modules", ".bin");
      const cleanedPath = distinctPath(input.searchPath)
        .split(":")
        .filter((entry) => entry !== runningBin)
        .join(":");
      const python = input.pythonCommand ?? (yield* onPath("python3", cleanedPath)) ?? "/usr/bin/python3";
      const encodedPrePulled = yield* encodePrePulled({ ...pulled.success, lockPid: process.pid });
      const childArgs = [
        targetPatcher.script,
        "update",
        "--userdata",
        resolvedUserdata,
        ...(input.request.t3 === undefined ? [] : ["--t3", input.request.t3]),
        ...(input.request.relaunch === undefined ? [] : ["--relaunch", String(input.request.relaunch)]),
      ];
      const writeStdout =
        input.onOutput?.stdout ?? ((chunk: string) => Effect.sync(() => void process.stdout.write(chunk)));
      const writeStderr =
        input.onOutput?.stderr ?? ((chunk: string) => Effect.sync(() => void process.stderr.write(chunk)));
      const spawned = yield* Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const handle = yield* spawner.spawn(
            ChildProcess.make(python, childArgs, {
              cwd: targetPatcher.checkout,
              env: { PATH: cleanedPath, [PREPULLED_ENV]: encodedPrePulled },
              extendEnv: true,
              stdin: "ignore",
            }),
          );
          const kept: Array<string> = [];
          const outDrain = yield* handle.stdout.pipe(
            Stream.decodeText,
            Stream.runForEach((chunk) => Effect.sync(() => kept.push(chunk)).pipe(Effect.andThen(writeStdout(chunk)))),
            Effect.forkScoped,
          );
          const errDrain = yield* handle.stderr.pipe(
            Stream.decodeText,
            Stream.runForEach((chunk) => Effect.sync(() => kept.push(chunk)).pipe(Effect.andThen(writeStderr(chunk)))),
            Effect.forkScoped,
          );
          const code = yield* handle.exitCode;
          yield* Fiber.joinAll([outDrain, errDrain]).pipe(Effect.timeoutOption("2 seconds"));
          return { code, output: kept.join("") };
        }),
      ).pipe(Effect.result);
      const outcome = Result.isSuccess(spawned)
        ? spawned.success
        : { code: 1, output: `couldn't run ${python}: ${spawned.failure.message}` };
      if (outcome.code !== 0) {
        const saved = yield* loadReport(resolvedUserdata).pipe(Effect.orElseSucceed(() => Option.none<RunReport>()));
        if (Option.isNone(saved) || !saved.value.steps.some((step) => step.status === "failed")) {
          const lines = outcome.output.trimEnd().split("\n").slice(-20).join("\n");
          const reason = lines === "" ? `published patcher exited with code ${outcome.code}` : lines;
          const failed: RunReport = { version: "", install: true, steps: [pull("failed", reason)] };
          yield* tell(failed);
          const beforeCli: PublishedUpdateOutcome = { kind: "failed-before-cli", report: failed, code: outcome.code };
          return beforeCli;
        }
      }
      const handedOff: PublishedUpdateOutcome = { kind: "handed-off", code: outcome.code };
      return handedOff;
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
  const found = yield* patcherCheckout(settings.patches);
  if (found === undefined) return undefined;
  return yield* updateCommand(found.checkout, userdata, searchPath);
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
