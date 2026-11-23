// SKELETON: signatures agreed between the packages; the bodies are being written.
import type { CaptureRequest, Patch, RunReport, StepFailed, Target } from "@app/contracts";
import * as Effect from "effect/Effect";

import type { Installation, PatchWriter, Progress, Resolver, Shell, Source } from "./services.ts";

export * from "./services.ts";

/** Folders the run writes into, from the composition root. */
export interface RunFolders {
  /** Journey evidence goes in <evidence>/<patch id>/<journey name>/. */
  readonly evidence: string;
}

/**
 * Apply `patches`, in order, over a clean checkout of the installed version; run the target's checks and each
 * patch's checks; build; run each patch's journeys; save patches whose diff changed (rebased onto this version);
 * then, if `install`, replace the installed app. Stops at the first step that fails; later steps are skipped.
 */
export const run = (
  _target: Target,
  _patches: ReadonlyArray<Patch>,
  _install: boolean,
  _folders: RunFolders,
): Effect.Effect<RunReport, never, Installation | Source | Resolver | Shell | PatchWriter | Progress> =>
  Effect.die("not written yet");

/**
 * A workspace for making or changing patch `id`: a checkout of the installed version with `preceding` applied and
 * committed, then `id`'s own diff (if it exists) applied and left uncommitted to edit. Returns its folder.
 */
export const openWorkspace = (
  _target: Target,
  _preceding: ReadonlyArray<Patch>,
  _existing: Patch | undefined,
  _id: string,
): Effect.Effect<string, StepFailed, Installation | Source | Resolver> => Effect.die("not written yet");

/** Save the uncommitted changes in `id`'s workspace as the patch: new, or replacing `existing`'s diff. */
export const capture = (
  _target: Target,
  _request: CaptureRequest,
  _existing: Patch | undefined,
): Effect.Effect<Patch, StepFailed, Installation | Source | PatchWriter> => Effect.die("not written yet");
