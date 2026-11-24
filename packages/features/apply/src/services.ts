// What the apply feature needs from outside. Platform packages implement these; the composition roots provide them.
import type { Command, Commit, Patch, PatchManifest, RunReport, StepFailed } from "@app/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** The installed app. */
export interface InstallationShape {
  /** The installed version, e.g. "0.1.11". */
  readonly version: Effect.Effect<string, StepFailed>;
  /**
   * Replace the installed app with the built one at `built`, keeping a backup. Fails if the installed version is no
   * longer `installed` (the one read when the run started), or if the app is running. With `relaunch`, the app's
   * process with that pid is asked to quit first, and the installed app is opened again afterwards.
   */
  readonly install: (built: string, installed: string, relaunch?: number) => Effect.Effect<string, StepFailed>;
}
export class Installation extends Context.Service<Installation, InstallationShape>()("@app/apply/services/Installation") {}

/** A checkout of the app's source, in a folder of its own. */
export interface Workspace {
  /** The checkout's folder. */
  readonly path: string;
  /** The upstream commit the checkout started from (the tag's commit). */
  readonly base: Commit;
  /**
   * Apply a diff to the working tree, merging three ways where it doesn't apply as is. Returns the files left with
   * conflicts (conflict markers, or a `<file>.rej` beside them); empty when it applied.
   */
  readonly apply: (diff: string) => Effect.Effect<ReadonlyArray<string>, StepFailed>;
  /** Files that still have conflicts: unmerged, containing conflict markers, or with a `.rej` file. */
  readonly conflicts: Effect.Effect<ReadonlyArray<string>, StepFailed>;
  /** Commit every change in the working tree; returns that commit's diff (binary, full index). */
  readonly commit: (message: string) => Effect.Effect<string, StepFailed>;
  /** The uncommitted changes, including new files, as a diff (binary, full index); empty if none. */
  readonly pending: Effect.Effect<string, StepFailed>;
  /** Record that this checkout is ready for authoring, made for installed `version`, at the current HEAD. */
  readonly markReady: (version: string) => Effect.Effect<void, StepFailed>;
}

export interface SourceShape {
  /**
   * A clean checkout of `tag` in the folder named `slot`: fetched from the target's repository, reset and cleaned
   * (ignored files such as installed packages are kept, so builds stay fast). Clears the slot's ready mark.
   */
  readonly open: (tag: string, slot: string) => Effect.Effect<Workspace, StepFailed>;
  /**
   * The checkout already in `slot`, as it is, with the version it was marked ready for. Fails if there is none, or
   * if it wasn't marked ready since it was last opened (or its HEAD moved since).
   */
  readonly existing: (slot: string) => Effect.Effect<{ readonly workspace: Workspace; readonly version: string }, StepFailed>;
}
export class Source extends Context.Service<Source, SourceShape>()("@app/apply/services/Source") {}

/** Resolves a patch's conflicts in a workspace (an agent, by default). */
export interface ResolverShape {
  readonly resolve: (
    workspace: string,
    patch: PatchManifest,
    files: ReadonlyArray<string>,
  ) => Effect.Effect<void, StepFailed>;
}
export class Resolver extends Context.Service<Resolver, ResolverShape>()("@app/apply/services/Resolver") {}

/** Runs shell commands. A failing command (non-zero exit) fails with the end of its output. */
export interface ShellShape {
  readonly run: (
    folder: string,
    command: Command,
    env: Readonly<Record<string, string>>,
  ) => Effect.Effect<void, StepFailed>;
}
export class Shell extends Context.Service<Shell, ShellShape>()("@app/apply/services/Shell") {}

/** Saves a patch (manifest and diff) to the patches folder. */
export interface PatchWriterShape {
  readonly write: (patch: Patch) => Effect.Effect<void, StepFailed>;
}
export class PatchWriter extends Context.Service<PatchWriter, PatchWriterShape>()("@app/apply/services/PatchWriter") {}

/** The git repository the patches folder is in, published from a branch of its `origin` remote. */
export interface PatchRepositoryShape {
  /**
   * Fast-forward the repository to `origin`'s `branch`; returns the commits before and after. Fails, changing
   * nothing, if it has local changes, isn't on `branch`, or has commits `origin` doesn't (it can't fast-forward).
   */
  readonly pull: (branch: string) => Effect.Effect<{ readonly from: string; readonly to: string }, StepFailed>;
}
export class PatchRepository extends Context.Service<PatchRepository, PatchRepositoryShape>()(
  "@app/apply/services/PatchRepository",
) {}

/** Hears about a run as it goes: called with the whole report after every change. */
export interface ProgressShape {
  readonly report: (report: RunReport) => Effect.Effect<void>;
}
export class Progress extends Context.Service<Progress, ProgressShape>()("@app/apply/services/Progress") {}
