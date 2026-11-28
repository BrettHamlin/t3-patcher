import {
  type CaptureRequest,
  type Command,
  type InstalledRecord,
  type Journey,
  type Patch,
  type PatchManifest,
  type RunReport,
  type Step,
  StepFailed,
  type StepKind,
  type Target,
  type UpdateItem,
} from "@app/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { Installation, PatchWriter, Progress, Resolver, Shell, Source, type Workspace } from "./services.ts";

export * from "./services.ts";

/** Folders the run writes into, from the composition root. */
export interface RunFolders {
  /** Journey evidence goes in <evidence>/<patch id>/<journey name>/. */
  readonly evidence: string;
}

/** How an update runs the stack. */
export interface RunOptions {
  /** The app version to build, when it isn't the installed one (a new release). */
  readonly version?: string;
  /** The pid of the running app, which the install step quits and opens again. */
  readonly relaunch?: number;
  /** What the run updates, for its report. */
  readonly updating?: ReadonlyArray<UpdateItem>;
  /**
   * Whether patches rebased onto this version are saved back to the patches folder (default true). An update's
   * patches come from a published clone, which nothing but a sync changes, so its run has no save step.
   */
  readonly save?: boolean;
  /** Records an install of `patches` at `version`, right after the app is replaced (before it's opened again). */
  readonly record?: (version: string, patches: ReadonlyArray<Patch>) => Effect.Effect<void, StepFailed>;
}

const withVersion = (text: string, version: string): string => text.replaceAll("{version}", version);

const slot = (id: string): string => `workspace-${id}`;

const builtApp = (workspace: Workspace, target: Target): string => `${workspace.path}/${target.built}`;

/** A clean checkout in `name` of the tag for `wanted`, or for the installed version when none is wanted. */
const openInstalled = Effect.fn("openInstalled")(function* (target: Target, name: string, wanted?: string) {
  const installed = yield* (yield* Installation).version;
  const version = wanted ?? installed;
  const tag = withVersion(target.tag, version);
  const workspace = yield* (yield* Source).open(tag, name);
  return { installed, version, tag, workspace };
});

/** Apply `patch`'s diff, resolving any conflicts; fails if some are left. Returns the files that were resolved. */
const applyResolved = Effect.fn("applyResolved")(function* (workspace: Workspace, patch: Patch) {
  const conflicted = yield* workspace.apply(patch.diff);
  if (conflicted.length === 0) return conflicted;
  yield* (yield* Resolver).resolve(workspace.path, patch.manifest, conflicted);
  const left = yield* workspace.conflicts;
  if (left.length > 0) return yield* new StepFailed({ reason: `conflicts left in ${left.join(", ")}` });
  return conflicted;
});

/** Apply `patch` (resolving conflicts) and commit it. Returns the resolved files and the commit's diff. */
const applyCommitted = Effect.fn("applyCommitted")(function* (workspace: Workspace, patch: Patch) {
  const resolved = yield* applyResolved(workspace, patch);
  const diff = yield* workspace.commit(`${patch.manifest.id}: ${patch.manifest.title}`);
  return { resolved, diff };
});

const named = (id: string) => (error: StepFailed) => new StepFailed({ reason: `${id}: ${error.reason}` });

/** What later steps of a run use, once the source is open. */
interface Opened {
  /** The installed version when the run started. */
  readonly installed: string;
  /** The version being built. */
  readonly version: string;
  readonly workspace: Workspace;
  /** Patches whose diff or base changed, rebased onto this version, in stack order. */
  readonly saves: Ref.Ref<ReadonlyArray<Patch>>;
}

type Needs = Installation | Resolver | Shell | PatchWriter;

interface Action {
  readonly kind: StepKind;
  readonly name: string;
  /** Shared resource key (e.g. log filename stem) that serializes matching actions within a concurrent phase. */
  readonly lockKey?: string;
  /** Does the step; succeeds with its note. */
  readonly perform: (opened: Opened) => Effect.Effect<string, StepFailed, Needs>;
}

const appliedPatchesJson = (patches: ReadonlyArray<Patch>): string =>
  JSON.stringify(
    patches.map(({ manifest }) => ({
      id: manifest.id,
      title: manifest.title,
      summary: manifest.summary,
      version: manifest.version,
    })),
  );

const commandEnv = (
  target: Target,
  opened: Opened,
  patches: ReadonlyArray<Patch>,
): Readonly<Record<string, string>> => ({
  ...target.env,
  T3_PATCHER_VERSION: opened.version,
  T3_PATCHER_SOURCE: opened.workspace.path,
  T3_PATCHER_PATCHES: appliedPatchesJson(patches),
});

const shellStep = (
  kind: StepKind,
  name: string,
  command: (opened: Opened) => Command,
  env: (opened: Opened) => Readonly<Record<string, string>>,
  lockKey?: string,
): Action => ({
  kind,
  name,
  ...(lockKey === undefined ? {} : { lockKey }),
  perform: (opened) =>
    Shell.use((shell) => shell.run(opened.workspace.path, command(opened), env(opened))).pipe(Effect.as("")),
});

const patchStep = (patch: Patch, save: boolean): Action => ({
  kind: "patch",
  name: patch.manifest.id,
  perform: Effect.fn("patchStep")(function* (opened: Opened) {
    const { resolved, diff } = yield* applyCommitted(opened.workspace, patch);
    const applied = resolved.length === 0 ? "applied" : `resolved conflicts in ${resolved.join(", ")}`;
    if (diff === patch.diff && patch.manifest.base.commit === opened.workspace.base) return applied;
    const manifest: PatchManifest = {
      ...patch.manifest,
      base: { version: opened.version, commit: opened.workspace.base },
    };
    yield* Ref.update(opened.saves, (saves) => [...saves, { manifest, diff }]);
    return `${applied}; ${save ? "to be saved" : "rebased"} for ${opened.version}`;
  }),
});

const logLockKey = (commandName: string): string => commandName.replace(/[^A-Za-z0-9._-]+/g, "-");

const journeyStep = (
  target: Target,
  folders: RunFolders,
  patches: ReadonlyArray<Patch>,
  patch: Patch,
  journey: Journey,
): Action => {
  const id = patch.manifest.id;
  return shellStep(
    "journey",
    `${id}: ${journey.name}`,
    () => ({ name: journey.name, run: journey.run }),
    (opened) => ({
      ...commandEnv(target, opened, patches),
      T3_PATCHER_APP: builtApp(opened.workspace, target),
      T3_PATCHER_EVIDENCE: `${folders.evidence}/${id}/${journey.name}`,
    }),
    logLockKey(journey.name),
  );
};

const saveStep = (): Action => ({
  kind: "save",
  name: "save patches",
  perform: Effect.fn("saveStep")(function* (opened: Opened) {
    const saves = yield* Ref.get(opened.saves);
    if (saves.length === 0) return "nothing to save";
    const writer = yield* PatchWriter;
    yield* Effect.forEach(saves, (patch) => writer.write(patch), { discard: true });
    return `saved ${saves.map((patch) => patch.manifest.id).join(", ")}`;
  }),
});

const installStep = (target: Target, patches: ReadonlyArray<Patch>, options: RunOptions): Action => ({
  kind: "install",
  name: "install",
  perform: (opened) =>
    Installation.use((installation) =>
      installation.install(builtApp(opened.workspace, target), opened.installed, {
        ...(options.relaunch === undefined ? {} : { relaunch: options.relaunch }),
        ...(options.record === undefined ? {} : { installed: options.record(opened.version, patches) }),
      }),
    ),
});

const targetCommand = (command: Command) => (opened: Opened): Command => ({
  ...command,
  run: withVersion(command.run, opened.version),
});

/** Actions run in turn (`atOnce` 1), or up to `atOnce` side by side, actions sharing a lock key still in turn. */
interface Stage {
  readonly atOnce: number;
  readonly actions: ReadonlyArray<Action>;
}

/** Lanes that run side by side, each its stages in turn. */
interface Phase {
  readonly lanes: ReadonlyArray<ReadonlyArray<Stage>>;
}

const inTurn = (actions: ReadonlyArray<Action>): Phase => ({ lanes: [[{ atOnce: 1, actions }]] });

/** Patch checks mostly find their tests already passed in the target's checks, so they're cheap side by side. */
const CHECKS_AT_ONCE = 8;
/** Each journey drives its own app; five at once fit in 16 GB beside the checks. */
const JOURNEYS_AT_ONCE = 5;

const phaseActions = (phase: Phase): ReadonlyArray<Action> =>
  phase.lanes.flatMap((lane) => lane.flatMap((stage) => stage.actions));

interface IndexedAction {
  readonly index: number;
  readonly action: Action;
}

interface IndexedStage {
  readonly atOnce: number;
  readonly items: ReadonlyArray<IndexedAction>;
}

interface CancelWaiter {
  readonly index: number;
  readonly cancel: () => void;
}

const groupByLockKey = (items: ReadonlyArray<IndexedAction>): ReadonlyArray<ReadonlyArray<IndexedAction>> => {
  const chains: Array<Array<IndexedAction>> = [];
  const byKey = new Map<string, Array<IndexedAction>>();
  for (const item of items) {
    const key = item.action.lockKey;
    if (key === undefined) {
      chains.push([item]);
    } else {
      const existing = byKey.get(key);
      if (existing === undefined) {
        const chain = [item];
        byKey.set(key, chain);
        chains.push(chain);
      } else {
        existing.push(item);
      }
    }
  }
  return chains;
};

/**
 * Every phase after the source, in order. With setup, nothing after it writes the source tree, so the checks run in
 * one lane while the build and journeys run in another; without it (older settings), every step runs in turn.
 */
const phases = (
  target: Target,
  patches: ReadonlyArray<Patch>,
  install: boolean,
  folders: RunFolders,
  options: RunOptions,
): ReadonlyArray<Phase> => {
  const save = options.save ?? true;
  const env = (opened: Opened) => commandEnv(target, opened, patches);
  const shell = (kind: StepKind) => (command: Command) => shellStep(kind, command.name, targetCommand(command), env);
  const checks: Stage = { atOnce: 1, actions: target.checks.map(shell("check")) };
  const patchChecks: Stage = {
    atOnce: CHECKS_AT_ONCE,
    actions: patches.flatMap((patch) =>
      patch.manifest.checks.map((check) =>
        shellStep("check", `${patch.manifest.id}: ${check.name}`, () => check, env, logLockKey(check.name)),
      ),
    ),
  };
  const build: Stage = { atOnce: 1, actions: target.build.map(shell("build")) };
  const journeys: Stage = {
    atOnce: JOURNEYS_AT_ONCE,
    actions: patches.flatMap((patch) =>
      patch.manifest.journeys.map((journey) => journeyStep(target, folders, patches, patch, journey)),
    ),
  };
  const verified: ReadonlyArray<Phase> =
    target.setup.length === 0
      ? [inTurn([checks, patchChecks, build, journeys].flatMap((stage) => stage.actions))]
      : [inTurn(target.setup.map(shell("setup"))), { lanes: [[checks, patchChecks], [build, journeys]] }];
  return [
    inTurn(patches.map((patch) => patchStep(patch, save))),
    ...verified,
    ...(save ? [inTurn([saveStep()])] : []),
    ...(install ? [inTurn([installStep(target, patches, options)])] : []),
  ];
};

const planned = (kind: StepKind, name: string): Step => ({ kind, name, status: "pending", note: "" });

const changed = (report: RunReport, index: number, change: (step: Step, at: number) => Step): RunReport => ({
  ...report,
  steps: report.steps.map((step, at) => (at < index ? step : change(step, at))),
});

/**
 * Apply `patches`, in order, over a clean checkout of the installed version (or `options.version`); run the target's
 * setup; run the target's checks and each patch's checks (alongside the build and journeys when there's setup); build;
 * run each patch's journeys; save patches whose diff changed (rebased onto this version); then, if `install`, replace
 * the installed app. A failing step stops every later one, so nothing is installed.
 */
export const run: (
  target: Target,
  patches: ReadonlyArray<Patch>,
  install: boolean,
  folders: RunFolders,
  options?: RunOptions,
) => Effect.Effect<RunReport, never, Installation | Source | Resolver | Shell | PatchWriter | Progress> = Effect.fn("run")(
  function* (target, patches, install, folders, options = {}) {
    const progress = yield* Progress;
    const planPhases = phases(target, patches, install, folders, options);
    const rest = planPhases.flatMap(phaseActions);
    const steps = [planned("source", `${target.name} source`), ...rest.map((action) => planned(action.kind, action.name))];
    const report = yield* Ref.make<RunReport>(
      options.updating === undefined
        ? { version: "", install, steps }
        : { version: "", install, updating: options.updating, steps },
    );
    // Lanes update the report side by side: reports go to Progress one at a time, and one that a newer report has
    // overtaken is dropped.
    let made = 0;
    let sent = 0;
    let delivering = false;
    const queued: Array<() => void> = [];
    const takeTurn = Effect.callback<void>((resume) => {
      if (!delivering) {
        delivering = true;
        resume(Effect.void);
      } else {
        queued.push(() => resume(Effect.void));
      }
    });
    const passTurn = Effect.sync(() => {
      const next = queued.shift();
      if (next === undefined) delivering = false;
      else next();
    });
    const update = (f: (report: RunReport) => RunReport) =>
      Ref.modify(report, (current): [readonly [RunReport, number], RunReport] => {
        const next = f(current);
        made += 1;
        return [[next, made], next];
      }).pipe(
        Effect.flatMap(([next, order]) =>
          Effect.acquireUseRelease(
            takeTurn,
            () =>
              Effect.suspend(() => {
                if (order < sent) return Effect.void;
                sent = order;
                return progress.report(next);
              }),
            () => passTurn,
          ),
        ),
        Effect.uninterruptible,
      );
    const at = (index: number, change: (step: Step) => Step) =>
      update((current) => changed(current, index, (step, position) => (position === index ? change(step) : step)));

    /** Run step `index`: running, then passed with its note, or failed with every later step skipped. */
    const perform = <A, R>(index: number, effect: Effect.Effect<A, StepFailed, R>, note: (a: A) => string) =>
      at(index, (step) => ({ ...step, status: "running" })).pipe(
        Effect.andThen(effect),
        Effect.tapError((error) =>
          update((current) =>
            changed(current, index, (step, position) =>
              position === index ? { ...step, status: "failed", note: error.reason } : { ...step, status: "skipped", note: "" },
            ),
          ),
        ),
        Effect.tap((value) => at(index, (step) => ({ ...step, status: "passed", note: note(value) }))),
      );

    /**
     * Run a phase's lanes side by side. A step that fails shows it at once and stops every later step in plan order
     * (running ones are stopped); earlier ones still finish. Stopped and unstarted steps are skipped, and the run fails
     * with the first failure in plan order.
     */
    const performConcurrent = Effect.fn("performConcurrent")(function* (
      lanes: ReadonlyArray<ReadonlyArray<IndexedStage>>,
      opened: Opened,
    ) {
      let earliestFailure = Number.MAX_SAFE_INTEGER;
      const failures = new Map<number, StepFailed>();
      const waiters = new Set<CancelWaiter>();

      const waitEarlierFailure = (index: number) =>
        Effect.callback<{ readonly _tag: "Cancelled" }>((resume) => {
          if (earliestFailure < index) {
            resume(Effect.succeed({ _tag: "Cancelled" }));
            return;
          }
          const entry: CancelWaiter = {
            index,
            cancel: () => resume(Effect.succeed({ _tag: "Cancelled" })),
          };
          waiters.add(entry);
          return Effect.sync(() => {
            waiters.delete(entry);
          });
        });

      const runOne = Effect.fn("runOne")(function* ({ index, action }: IndexedAction) {
        if (earliestFailure < index) return;
        yield* update((current) =>
          changed(current, index, (step, position) =>
            position === index && step.status === "pending" ? { ...step, status: "running" } : step,
          ),
        );
        // An earlier step may have failed while that report was delivered.
        if (earliestFailure < index) return;
        const outcome = yield* Effect.raceFirst(
          action.perform(opened).pipe(Effect.result),
          waitEarlierFailure(index),
        );
        if (outcome._tag === "Cancelled") return;
        if (outcome._tag === "Success") {
          if (earliestFailure < index) return;
          yield* at(index, (step) => ({ ...step, status: "passed", note: outcome.success }));
          return;
        }
        failures.set(index, outcome.failure);
        if (index < earliestFailure) earliestFailure = index;
        // Later steps stop before the failure is reported, which can take a while.
        for (const waiter of waiters) {
          if (waiter.index > index) {
            waiters.delete(waiter);
            waiter.cancel();
          }
        }
        yield* at(index, (step) => ({ ...step, status: "failed", note: outcome.failure.reason }));
      });

      const runStage = (stage: IndexedStage) =>
        stage.atOnce === 1
          ? Effect.forEach(stage.items, runOne, { discard: true })
          : Effect.forEach(groupByLockKey(stage.items), (chain) => Effect.forEach(chain, runOne, { discard: true }), {
              concurrency: stage.atOnce,
              discard: true,
            });
      yield* Effect.forEach(lanes, (lane) => Effect.forEach(lane, runStage, { discard: true }), {
        concurrency: "unbounded",
        discard: true,
      });

      if (failures.size === 0) return;
      const firstIndex = Math.min(...failures.keys());
      const firstError = failures.get(firstIndex);
      if (firstError === undefined) return;
      yield* update((current) =>
        changed(current, firstIndex, (step) =>
          step.status === "passed" || step.status === "failed" ? step : { ...step, status: "skipped", note: "" },
        ),
      );
      return yield* firstError;
    });

    yield* update((current) => current);
    yield* Effect.gen(function* () {
      const source = yield* perform(
        0,
        openInstalled(target, "stack", options.version).pipe(
          Effect.tap(({ version }) => Ref.update(report, (current) => ({ ...current, version }))),
        ),
        ({ version, tag }) => `${version} (${tag})`,
      );
      const opened: Opened = {
        installed: source.installed,
        version: source.version,
        workspace: source.workspace,
        saves: yield* Ref.make<ReadonlyArray<Patch>>([]),
      };
      let nextIndex = 1;
      for (const phase of planPhases) {
        const lanes = phase.lanes.map((lane) =>
          lane.map((stage) => {
            const items = stage.actions.map((action, offset) => ({ index: nextIndex + offset, action }));
            nextIndex += stage.actions.length;
            return { atOnce: stage.atOnce, items };
          }),
        );
        const only = lanes.length === 1 && lanes[0]?.length === 1 ? lanes[0][0] : undefined;
        if (only !== undefined && (only.atOnce === 1 || only.items.length <= 1)) {
          yield* Effect.forEach(only.items, ({ index, action }) => perform(index, action.perform(opened), (note) => note), {
            discard: true,
          });
        } else {
          yield* performConcurrent(lanes, opened);
        }
      }
    }).pipe(Effect.catchTag("StepFailed", () => Effect.void));
    return yield* Ref.get(report);
  },
);

/**
 * A workspace for making or changing patch `id`: a checkout of the installed version with `preceding` applied and
 * committed, then `id`'s own diff (if it exists) applied and left uncommitted to edit, marked ready for that version.
 * Fails, leaving it as it is, if the workspace already there has changes that `existing` doesn't hold. Returns its
 * folder.
 */
export const openWorkspace: (
  target: Target,
  preceding: ReadonlyArray<Patch>,
  existing: Patch | undefined,
  id: string,
) => Effect.Effect<string, StepFailed, Installation | Source | Resolver> = Effect.fn("openWorkspace")(
  function* (target, preceding, existing, id) {
    const found = yield* (yield* Source)
      .existing(slot(id))
      .pipe(Effect.catchTag("StepFailed", () => Effect.undefined));
    if (found !== undefined) {
      const draft = yield* found.workspace.pending;
      if (draft.trim() !== "" && draft !== existing?.diff) {
        return yield* new StepFailed({
          reason: `the workspace for ${id} has changes that aren't captured: capture them, or delete ${found.workspace.path} to start over`,
        });
      }
    }
    const { version, workspace } = yield* openInstalled(target, slot(id));
    yield* Effect.forEach(
      preceding,
      (patch) => applyCommitted(workspace, patch).pipe(Effect.mapError(named(patch.manifest.id))),
      { discard: true },
    );
    if (existing !== undefined) {
      yield* applyResolved(workspace, existing).pipe(Effect.mapError(named(existing.manifest.id)));
    }
    yield* workspace.markReady(version);
    return workspace.path;
  },
);

const placeholderJourney = (id: string): Journey => ({
  name: `${id}_works`,
  proves: "Write what this journey proves.",
  run: `echo 'Write this journey: patches/${id}/patch.json' >&2; exit 1`,
});

/** Save the uncommitted changes in `id`'s workspace as the patch: new, or replacing `existing`'s diff. */
export const capture: (
  target: Target,
  request: CaptureRequest,
  existing: Patch | undefined,
) => Effect.Effect<Patch, StepFailed, Source | PatchWriter> = Effect.fn("capture")(
  function* (_target, request, existing) {
    const { workspace, version } = yield* (yield* Source).existing(slot(request.id));
    const left = yield* workspace.conflicts;
    if (left.length > 0) {
      return yield* new StepFailed({ reason: `conflicts left in ${left.join(", ")}: resolve them before capturing` });
    }
    const diff = yield* workspace.pending;
    if (diff.trim() === "") {
      return yield* new StepFailed({ reason: `nothing changed in the workspace for ${request.id}` });
    }
    const patch: Patch = {
      manifest: {
        id: request.id,
        title: request.title,
        summary: request.summary,
        version: existing?.manifest.version ?? 1,
        base: { version, commit: workspace.base },
        checks: existing?.manifest.checks ?? [],
        journeys: existing?.manifest.journeys ?? [placeholderJourney(request.id)],
      },
      diff,
    };
    yield* (yield* PatchWriter).write(patch);
    return patch;
  },
);

/** The installed record of `patches` installed at app `version`; without `update` when there's no command for it. */
export const installedRecord = (
  version: string,
  patches: ReadonlyArray<Patch>,
  installedAt: string,
  feed: string,
  update: InstalledRecord["update"],
): InstalledRecord => ({
  t3Version: version,
  patches: patches.map(({ manifest }) => ({
    id: manifest.id,
    title: manifest.title,
    summary: manifest.summary,
    version: manifest.version,
  })),
  installedAt,
  feed,
  ...(update === undefined ? {} : { update }),
});

/**
 * What an update changes, for its report: the app, when `t3.to` isn't the installed version; each patch that is on
 * whose version isn't the one installed (from the installed record, else the patch as it was before the pull), or,
 * with an installed record, that the record lacks (added, from ""); then each patch the installed record has that the
 * update leaves out, as "removed".
 */
export const updates = (input: {
  readonly app: string;
  readonly t3: { readonly from: string; readonly to: string };
  readonly installed: InstalledRecord | undefined;
  readonly before: ReadonlyArray<PatchManifest>;
  readonly patches: ReadonlyArray<Patch>;
}): ReadonlyArray<UpdateItem> => {
  const was = (id: string): number | undefined =>
    (input.installed?.patches ?? input.before).find((each) => each.id === id)?.version;
  const app: ReadonlyArray<UpdateItem> =
    input.t3.from === input.t3.to ? [] : [{ name: input.app, from: input.t3.from, to: input.t3.to }];
  return [
    ...app,
    ...input.patches.flatMap(({ manifest }): ReadonlyArray<UpdateItem> => {
      const from = was(manifest.id);
      if (from === undefined) {
        return input.installed === undefined ? [] : [{ name: manifest.id, from: "", to: String(manifest.version) }];
      }
      return from === manifest.version ? [] : [{ name: manifest.id, from: String(from), to: String(manifest.version) }];
    }),
    ...(input.installed?.patches ?? [])
      .filter((kept) => !input.patches.some(({ manifest }) => manifest.id === kept.id))
      .map((kept) => ({ name: kept.id, from: String(kept.version), to: "removed" })),
  ];
};
