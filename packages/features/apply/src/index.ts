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
   * patches come from a published clone, which nothing but a sync changes.
   */
  readonly save?: boolean;
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
  /** Does the step; succeeds with its note. */
  readonly perform: (opened: Opened) => Effect.Effect<string, StepFailed, Needs>;
}

const commandEnv = (target: Target, opened: Opened): Readonly<Record<string, string>> => ({
  ...target.env,
  T3_PATCHER_VERSION: opened.version,
  T3_PATCHER_SOURCE: opened.workspace.path,
});

const shellStep = (kind: StepKind, name: string, command: (opened: Opened) => Command, env: (opened: Opened) => Readonly<Record<string, string>>): Action => ({
  kind,
  name,
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

const journeyStep = (target: Target, folders: RunFolders, patch: Patch, journey: Journey): Action => {
  const id = patch.manifest.id;
  return shellStep(
    "journey",
    `${id}: ${journey.name}`,
    () => ({ name: journey.name, run: journey.run }),
    (opened) => ({
      ...commandEnv(target, opened),
      T3_PATCHER_APP: builtApp(opened.workspace, target),
      T3_PATCHER_EVIDENCE: `${folders.evidence}/${id}/${journey.name}`,
    }),
  );
};

const saveStep = (save: boolean): Action => ({
  kind: "save",
  name: "save patches",
  perform: Effect.fn("saveStep")(function* (opened: Opened) {
    const saves = yield* Ref.get(opened.saves);
    if (saves.length === 0) return "nothing to save";
    const ids = saves.map((patch) => patch.manifest.id).join(", ");
    if (!save) return `${ids} rebased for ${opened.version}; not saved: publish rebased patches from a workspace`;
    const writer = yield* PatchWriter;
    yield* Effect.forEach(saves, (patch) => writer.write(patch), { discard: true });
    return `saved ${saves.map((patch) => patch.manifest.id).join(", ")}`;
  }),
});

const installStep = (target: Target, relaunch: number | undefined): Action => ({
  kind: "install",
  name: "install",
  perform: (opened) =>
    Installation.use((installation) =>
      installation.install(builtApp(opened.workspace, target), opened.installed, relaunch),
    ),
});

const targetCommand = (command: Command) => (opened: Opened): Command => ({
  ...command,
  run: withVersion(command.run, opened.version),
});

/** Every step after the source, in order. */
const actions = (
  target: Target,
  patches: ReadonlyArray<Patch>,
  install: boolean,
  folders: RunFolders,
  relaunch: number | undefined,
  save: boolean,
): ReadonlyArray<Action> => {
  const env = (opened: Opened) => commandEnv(target, opened);
  return [
    ...patches.map((patch) => patchStep(patch, save)),
    ...target.checks.map((check) => shellStep("check", check.name, targetCommand(check), env)),
    ...patches.flatMap((patch) =>
      patch.manifest.checks.map((check) => shellStep("check", `${patch.manifest.id}: ${check.name}`, () => check, env)),
    ),
    ...target.build.map((command) => shellStep("build", command.name, targetCommand(command), env)),
    ...patches.flatMap((patch) => patch.manifest.journeys.map((journey) => journeyStep(target, folders, patch, journey))),
    saveStep(save),
    ...(install ? [installStep(target, relaunch)] : []),
  ];
};

const planned = (kind: StepKind, name: string): Step => ({ kind, name, status: "pending", note: "" });

const changed = (report: RunReport, index: number, change: (step: Step, at: number) => Step): RunReport => ({
  ...report,
  steps: report.steps.map((step, at) => (at < index ? step : change(step, at))),
});

/**
 * Apply `patches`, in order, over a clean checkout of the installed version (or `options.version`); run the target's
 * checks and each patch's checks; build; run each patch's journeys; save patches whose diff changed (rebased onto
 * this version); then, if `install`, replace the installed app. Stops at the first step that fails; later steps are
 * skipped, so nothing is installed.
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
    const rest = actions(target, patches, install, folders, options.relaunch, options.save ?? true);
    const steps = [planned("source", `${target.name} source`), ...rest.map((action) => planned(action.kind, action.name))];
    const report = yield* Ref.make<RunReport>(
      options.updating === undefined
        ? { version: "", install, steps }
        : { version: "", install, updating: options.updating, steps },
    );
    const update = (f: (report: RunReport) => RunReport) =>
      Ref.updateAndGet(report, f).pipe(Effect.flatMap((next) => progress.report(next)));
    const at = (index: number, change: (step: Step) => Step) =>
      update((current) => changed(current, index, (step, position) => (position === index ? change(step) : step)));

    /** Run step `index`: running, then passed with its note, or failed with every later step skipped. */
    const perform = <A, R>(index: number, effect: Effect.Effect<A, StepFailed, R>, note: (a: A) => string) =>
      at(index, (step) => ({ ...step, status: "running" })).pipe(
        Effect.andThen(effect),
        Effect.tapError((error) =>
          update((current) =>
            changed(current, index, (step, position) =>
              position === index ? { ...step, status: "failed", note: error.reason } : { ...step, status: "skipped" },
            ),
          ),
        ),
        Effect.tap((value) => at(index, (step) => ({ ...step, status: "passed", note: note(value) }))),
      );

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
      yield* Effect.forEach(rest, (action, index) => perform(index + 1, action.perform(opened), (note) => note), {
        discard: true,
      });
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

/**
 * The installed record after `report`'s run installed `patches`: undefined unless the run installed and every step
 * passed.
 */
export const installedRecord = (
  report: RunReport,
  patches: ReadonlyArray<Patch>,
  installedAt: string,
  feed: string,
  update: InstalledRecord["update"],
): InstalledRecord | undefined => {
  if (!report.install || !report.steps.every((step) => step.status === "passed")) return undefined;
  return {
    t3Version: report.version,
    patches: patches.map(({ manifest }) => ({ id: manifest.id, version: manifest.version })),
    installedAt,
    feed,
    update,
  };
};

/**
 * What an update changes, for its report: the app, when `t3.to` isn't the installed version, then each patch that is
 * on whose version isn't the one installed (from the installed record, else the patch as it was before the pull).
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
      return from === undefined || from === manifest.version
        ? []
        : [{ name: manifest.id, from: String(from), to: String(manifest.version) }];
    }),
  ];
};
