// What the apply feature needs from outside. Platform packages implement these; the composition roots provide them.
import type { Command, Commit, Patch, PatchManifest, RunReport, StepFailed } from "@app/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** The installed app. */
export interface InstallationShape {
  /** The installed version, e.g. "0.1.11". */
  readonly version: Effect.Effect<string, StepFailed>;
  /** Replace the installed app with the built one at `built`, keeping a backup. Fails if the app is running. */
  readonly install: (built: string) => Effect.Effect<string, StepFailed>;
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
}

export interface SourceShape {
  /**
   * A clean checkout of `tag` in the folder named `slot`: fetched from the target's repository, reset and cleaned
   * (ignored files such as installed packages are kept, so builds stay fast).
   */
  readonly open: (tag: string, slot: string) => Effect.Effect<Workspace, StepFailed>;
  /** The checkout already in `slot`, as it is. Fails if there is none. */
  readonly existing: (slot: string) => Effect.Effect<Workspace, StepFailed>;
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

/** Hears about a run as it goes: called with the whole report after every change. */
export interface ProgressShape {
  readonly report: (report: RunReport) => Effect.Effect<void>;
}
export class Progress extends Context.Service<Progress, ProgressShape>()("@app/apply/services/Progress") {}
