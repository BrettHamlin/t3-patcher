import {
  type Command,
  Commit,
  type Journey,
  type Patch,
  PatchId,
  type RunReport,
  StepFailed,
  type Target,
} from "@app/contracts";
import { Installation, PatchWriter, Progress, Resolver, Shell, Source, type Workspace } from "@app/apply";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

/** A diff that conflicts when applied: the files it leaves, and whether the resolver clears them. */
export interface Conflict {
  readonly files: ReadonlyArray<string>;
  readonly resolves: boolean;
}

export interface FakeOptions {
  readonly version?: string;
  /** Diffs that conflict when applied. */
  readonly conflicts?: ReadonlyMap<string, Conflict>;
  /** Shell commands (by name) that fail. */
  readonly failing?: ReadonlySet<string>;
  readonly installFails?: boolean;
  /** The installed version after the first time it's read, if the app is updated during a run. */
  readonly installedLater?: string;
  /** Workspaces already in their slots (by slot name), marked ready. */
  readonly existing?: ReadonlyMap<string, ExistingWorkspace>;
}

/** A workspace left in its slot by an earlier openWorkspace. */
export interface ExistingWorkspace {
  /** The version it was marked ready for. */
  readonly version: string;
  /** Its uncommitted changes; empty if none. */
  readonly pending: string;
  /** Files it still has conflicts in. */
  readonly conflicts?: ReadonlyArray<string>;
}

export interface ShellCall {
  readonly folder: string;
  readonly command: Command;
  readonly env: Readonly<Record<string, string>>;
}

export const base = (): Effect.Effect<Commit, Schema.SchemaError> => commit("b");

export const commit = (digit: string): Effect.Effect<Commit, Schema.SchemaError> =>
  Schema.decodeEffect(Commit)(digit.repeat(40));

/** What a resolved conflict makes of a diff once committed. */
export const resolvedDiff = (diff: string): string => `${diff}+resolved`;

/** A patch whose diff is `diff:<id>`, made against `baseCommit`. */
export const patch = Effect.fn("patch")(function* (
  id: string,
  options: {
    readonly baseCommit: Commit;
    readonly checks?: ReadonlyArray<Command>;
    readonly journeys?: ReadonlyArray<Journey>;
    readonly version?: number;
  },
) {
  const patchId = yield* Schema.decodeEffect(PatchId)(id);
  const manifest = {
    id: patchId,
    title: `Title ${id}`,
    summary: `Summary ${id}`,
    version: options.version ?? 1,
    base: { version: "0.1.10", commit: options.baseCommit },
    checks: options.checks ?? [],
    journeys: options.journeys ?? [{ name: `${id}-journey`, proves: "it works", run: `run ${id}-journey` }],
  };
  const made: Patch = { manifest, diff: `diff:${id}` };
  return made;
});

export const target = (overrides: Partial<Pick<Target, "checks" | "build">> = {}): Target => ({
  name: "T3 Code",
  repository: "https://example.com/t3code.git",
  tag: "v{version}",
  installed: "/Applications/T3 Code.app",
  built: "release/T3 Code.app",
  checks: overrides.checks ?? [{ name: "typecheck", run: "bun typecheck --tag {version}" }],
  build: overrides.build ?? [{ name: "build", run: "bun build {version}" }],
  env: { CI: "1" },
});

const setIn = <A>(ref: Ref.Ref<ReadonlyMap<string, A>>, key: string, value: A) =>
  Ref.update(ref, (map) => new Map([...map, [key, value]]));

const forget = <A>(ref: Ref.Ref<ReadonlyMap<string, A>>, key: string) =>
  Ref.update(ref, (map) => new Map([...map].filter(([at]) => at !== key)));

const slotPath = (slot: string): string => `/work/${slot}`;

/** In-memory services that record what the feature asked of them, in order. */
export const fakes = Effect.fn("fakes")(function* (options: FakeOptions = {}) {
  const version = options.version ?? "0.1.11";
  const baseCommit = yield* base();
  const events = yield* Ref.make<ReadonlyArray<string>>([]);
  const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([]);
  const written = yield* Ref.make<ReadonlyArray<Patch>>([]);
  const reports = yield* Ref.make<ReadonlyArray<RunReport>>([]);
  const installed = yield* Ref.make<ReadonlyArray<string>>([]);
  const versionRead = yield* Ref.make(false);
  const log = (event: string) => Ref.update(events, (all) => [...all, event]);

  // Per workspace folder: diffs applied since the last commit, files still conflicted, and the version it's ready for.
  const left = [...(options.existing ?? new Map<string, ExistingWorkspace>())];
  const pending = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<string>>>(
    new Map(left.map(([slot, found]) => [slotPath(slot), found.pending === "" ? [] : [found.pending]])),
  );
  const conflicted = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<string>>>(
    new Map(left.map(([slot, found]) => [slotPath(slot), found.conflicts ?? []])),
  );
  const ready = yield* Ref.make<ReadonlyMap<string, string>>(
    new Map(left.map(([slot, found]) => [slotPath(slot), found.version])),
  );

  const workspace = (path: string): Workspace => ({
    path,
    base: baseCommit,
    apply: Effect.fn("fake.apply")(function* (diff: string) {
      yield* log(`apply ${diff} in ${path}`);
      const before = (yield* Ref.get(pending)).get(path) ?? [];
      yield* setIn(pending, path, [...before, diff]);
      const files = options.conflicts?.get(diff)?.files ?? [];
      yield* setIn(conflicted, path, files);
      return files;
    }),
    conflicts: Ref.get(conflicted).pipe(Effect.map((map) => map.get(path) ?? [])),
    commit: Effect.fn("fake.commit")(function* (message: string) {
      yield* log(`commit ${message} in ${path}`);
      const diffs = (yield* Ref.get(pending)).get(path) ?? [];
      yield* setIn(pending, path, []);
      return diffs.join("\n");
    }),
    pending: Ref.get(pending).pipe(Effect.map((map) => (map.get(path) ?? []).join("\n"))),
    markReady: Effect.fn("fake.markReady")(function* (readyFor: string) {
      yield* log(`ready ${readyFor} in ${path}`);
      yield* setIn(ready, path, readyFor);
    }),
  });

  const layer = Layer.mergeAll(
    Layer.succeed(Installation)({
      version: Ref.getAndSet(versionRead, true).pipe(
        Effect.map((read) => (read ? (options.installedLater ?? version) : version)),
      ),
      install: Effect.fn("fake.install")(function* (built: string, from: string, relaunch?: number) {
        yield* log(`install ${built} (${from})${relaunch === undefined ? "" : ` relaunching ${relaunch}`}`);
        if (options.installFails === true) return yield* new StepFailed({ reason: "T3 Code is running" });
        const now = options.installedLater ?? version;
        if (from !== now) {
          return yield* new StepFailed({ reason: `T3 Code is now ${now}, not ${from}: run again` });
        }
        yield* Ref.update(installed, (all) => [...all, built]);
        return `installed ${built}`;
      }),
    }),
    Layer.succeed(Source)({
      open: Effect.fn("fake.open")(function* (tag: string, slot: string) {
        yield* log(`open ${tag} in ${slot}`);
        yield* setIn(pending, slotPath(slot), []);
        yield* setIn(conflicted, slotPath(slot), []);
        yield* forget(ready, slotPath(slot));
        return workspace(slotPath(slot));
      }),
      existing: Effect.fn("fake.existing")(function* (slot: string) {
        yield* log(`existing ${slot}`);
        const readyFor = (yield* Ref.get(ready)).get(slotPath(slot));
        if (readyFor === undefined) return yield* new StepFailed({ reason: `no workspace ready in ${slot}` });
        return { workspace: workspace(slotPath(slot)), version: readyFor };
      }),
    }),
    Layer.succeed(Resolver)({
      resolve: Effect.fn("fake.resolve")(function* (folder, manifest, files) {
        yield* log(`resolve ${manifest.id} (${files.join(", ")}) in ${folder}`);
        const diffs = (yield* Ref.get(pending)).get(folder) ?? [];
        const last = diffs.at(-1);
        if (last === undefined || options.conflicts?.get(last)?.resolves !== true) return;
        yield* setIn(pending, folder, [...diffs.slice(0, -1), resolvedDiff(last)]);
        yield* setIn(conflicted, folder, []);
      }),
    }),
    Layer.succeed(Shell)({
      run: Effect.fn("fake.run")(function* (folder, command, env) {
        yield* log(`run ${command.name}`);
        yield* Ref.update(shellCalls, (all) => [...all, { folder, command, env }]);
        if (options.failing?.has(command.name) === true) {
          return yield* new StepFailed({ reason: `${command.name} exited 1` });
        }
      }),
    }),
    Layer.succeed(PatchWriter)({
      write: Effect.fn("fake.write")(function* (saved: Patch) {
        yield* log(`write ${saved.manifest.id}`);
        yield* Ref.update(written, (all) => [...all, saved]);
      }),
    }),
    Layer.succeed(Progress)({
      report: (report) => Ref.update(reports, (all) => [...all, report]),
    }),
  );
  return { layer, events, shellCalls, written, reports, installed, baseCommit };
});
