// What the apply feature needs from outside. Platform packages implement these; the composition roots provide them.
import type { Command, Commit, Patch, PatchManifest, RunReport, StepFailed } from "@app/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** The installed app. */
export interface InstallationShape {
  /** The installed version, e.g. "0.1.11". */
  readonly version: Effect.Effect<string, StepFailed>;
  /**
   * Replace the installed app with the built one at `built`, keeping a backup, then run `options.installed` (which
   * records the install). Fails if the installed version is no longer `installed` (the one read when the run
   * started), or if the app is running. With `options.relaunch`, the app's process with that pid is asked to quit
   * first, and the installed app is opened again after the install is recorded; failing to open it is reported in
   * the note, but the install and its record stay.
   */
  readonly install: (
    built: string,
    installed: string,
    options?: { readonly relaunch?: number; readonly installed?: Effect.Effect<void, StepFailed> },
  ) => Effect.Effect<string, StepFailed>;
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

/** What a sync of the published patches did. */
export interface Synced {
  /** Where the published repository was cloned from: the patches repository's `origin`. */
  readonly url: string;
  /** The clone's commit before, or null when this sync made the clone. */
  readonly from: string | null;
  readonly to: string;
  /** Whether the clone couldn't fast-forward and was reset to the published branch. */
  readonly reset: boolean;
}

/**
 * The published patches: a clone, kept by the patcher and edited by nothing else, of the patches repository's
 * `origin`. Updates use it, so the repository authors work in (on any branch, with any changes) never holds them up.
 */
export interface PublishedPatchesShape {
  /** The patches folder in the clone (it may not exist yet). */
  readonly folder: Effect.Effect<string, StepFailed>;
  /**
   * Bring the clone to `origin`'s `branch`: clone it the first time, then fetch and fast-forward, or reset when it
   * can't fast-forward. Fails if the patches repository has no `origin`, or it can't be reached.
   */
  readonly sync: (branch: string) => Effect.Effect<Synced, StepFailed>;
}
export class PublishedPatches extends Context.Service<PublishedPatches, PublishedPatchesShape>()(
  "@app/apply/services/PublishedPatches",
) {}

/** Hears about a run as it goes: called with the whole report after every change. */
export interface ProgressShape {
  readonly report: (report: RunReport) => Effect.Effect<void>;
}
export class Progress extends Context.Service<Progress, ProgressShape>()("@app/apply/services/Progress") {}
