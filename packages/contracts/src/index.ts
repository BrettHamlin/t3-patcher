import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { uiId } from "./ui.ts";

const Text = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

/** A patch's name: lowercase letters, digits and '-', starting with a letter or digit. Only decoding makes one. */
export const PatchId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/)),
  Schema.brand("PatchId"),
);
export type PatchId = typeof PatchId.Type;

/** A full git commit hash. */
export const Commit = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{40}$/)), Schema.brand("Commit"));
export type Commit = typeof Commit.Type;

/** A shell command run in the app's source folder: a check, a build step or a journey. */
export const Command = Schema.Struct({ name: Text, run: Text });
export type Command = typeof Command.Type;

/** A journey: a command that drives the built app the way a user would, and what it proves. */
export const Journey = Schema.Struct({ name: Text, proves: Text, run: Text });
export type Journey = typeof Journey.Type;

/** A patch's version: a whole number from 1, raised by its author with each published change. */
export const PatchVersion = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));
export type PatchVersion = typeof PatchVersion.Type;

/**
 * patches/<id>/patch.json. `base` is the app version and upstream commit the diff was last made against. A manifest
 * without `version` is version 1.
 */
export const PatchManifest = Schema.Struct({
  id: PatchId,
  title: Text,
  summary: Text,
  version: PatchVersion.pipe(Schema.withDecodingDefaultKey(Effect.succeed(1))),
  base: Schema.Struct({ version: Text, commit: Commit }),
  checks: Schema.Array(Command),
  journeys: Schema.Array(Journey).pipe(Schema.check(Schema.isMinLength(1))),
});
export type PatchManifest = typeof PatchManifest.Type;

/** A patch: its manifest and its diff (patches/<id>/changes.patch), applied over the app's source. */
export interface Patch {
  readonly manifest: PatchManifest;
  readonly diff: string;
}

/** The order patches apply in, and which are on. Kept in the user data folder. */
export const StackEntry = Schema.Struct({ id: PatchId, enabled: Schema.Boolean });
export type StackEntry = typeof StackEntry.Type;
export const Stack = Schema.Struct({ entries: Schema.Array(StackEntry) });
export type Stack = typeof Stack.Type;

/** The app being patched: where its source is, how an installed version names its tag, how to check and build it. */
export const Target = Schema.Struct({
  name: Text,
  /** A git URL or folder with the app's history and release tags. */
  repository: Text,
  /** The tag for an installed version; `{version}` is replaced, e.g. "v{version}". */
  tag: Text,
  /** The installed app (a macOS .app folder). */
  installed: Text,
  /** The built app, relative to the source folder. */
  built: Text,
  /** Run after every patch is applied, before building. `{version}` is replaced in each. */
  checks: Schema.Array(Command),
  /** Build steps, in order. `{version}` is replaced in each. */
  build: Schema.Array(Command),
  /** Added to every command's environment. */
  env: Schema.Record(Schema.String, Schema.String),
});
export type Target = typeof Target.Type;

/** <user data>/patcher/settings.json. */
export const Settings = Schema.Struct({
  /** The folder of patches (patches/<id>/). */
  patches: Text,
  /** Where source checkouts, builds, logs, evidence and backups go. */
  work: Text,
  /** Shell text run in the source folder when a patch conflicts; $T3_PATCHER_PROMPT names a file explaining the task. */
  resolver: Text,
  target: Target,
});
export type Settings = typeof Settings.Type;

export const StepKind = Schema.Literals(["pull", "source", "patch", "check", "build", "journey", "save", "install"]);
export type StepKind = typeof StepKind.Type;
export const StepStatus = Schema.Literals(["pending", "running", "passed", "failed", "skipped"]);
export type StepStatus = typeof StepStatus.Type;

export const Step = Schema.Struct({ kind: StepKind, name: Text, status: StepStatus, note: Schema.String });
export type Step = typeof Step.Type;

/**
 * Something an update changes: the app ("T3 Code") or a patch (its id), from one version to another; `to` is
 * "removed" for an installed patch the update leaves out.
 */
export const UpdateItem = Schema.Struct({ name: Text, from: Text, to: Text });
export type UpdateItem = typeof UpdateItem.Type;

/** One run of the stack over the installed version, step by step. An update's run says what it updates. */
export const RunReport = Schema.Struct({
  version: Schema.String,
  install: Schema.Boolean,
  updating: Schema.optionalKey(Schema.Array(UpdateItem)),
  steps: Schema.Array(Step),
});
export type RunReport = typeof RunReport.Type;

/** Where patch updates are published: this repository's main branch. */
export const FEED_URL = "https://raw.githubusercontent.com/BrettHamlin/t3-patcher/main/patches/index.json";
/** The branch the feed is published from; `update` pulls it. */
export const FEED_BRANCH = "main";

/** A patch as the feed lists it. */
export const FeedEntry = Schema.Struct({ id: PatchId, title: Text, summary: Text, version: PatchVersion });
export type FeedEntry = typeof FeedEntry.Type;

/** patches/index.json: every patch in the folder, sorted by id. Written by `t3-patcher index`. */
export const Feed = Schema.Struct({ patches: Schema.Array(FeedEntry) });
export type Feed = typeof Feed.Type;

/**
 * <user data>/installed.json: what the last install put in place, where updates are published, and how the app runs
 * the patcher's `update`: an absolute command, its folder, and the PATH the patcher ran with, since the app runs it
 * without a shell and with its own PATH.
 */
export const InstalledRecord = Schema.Struct({
  t3Version: Text,
  patches: Schema.Array(Schema.Struct({ id: PatchId, version: PatchVersion })),
  installedAt: Text,
  feed: Text,
  /** Missing when the install wasn't run from a checkout with scripts/patcher.py: update from the command line. */
  update: Schema.optionalKey(
    Schema.Struct({
      command: Schema.Array(Text).pipe(Schema.check(Schema.isMinLength(1))),
      cwd: Text,
      path: Text,
    }),
  ),
});
export type InstalledRecord = typeof InstalledRecord.Type;

/** What the user can see about the patches: each one, in stack order. */
export const LibraryView = Schema.Struct({ stack: Stack, patches: Schema.Array(PatchManifest) });
export type LibraryView = typeof LibraryView.Type;

/** A request to save the changes in a patch's workspace as the patch. */
export const CaptureRequest = Schema.Struct({ id: PatchId, title: Text, summary: Text });
export type CaptureRequest = typeof CaptureRequest.Type;

/** A step that couldn't finish, and why. */
export class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", { reason: Schema.String }) {
  override get message(): string {
    return this.reason;
  }
}

/** Patches, the stack, settings or a report couldn't be read or saved. */
export class StorageFailed extends Schema.TaggedError<StorageFailed>()("StorageFailed", { what: Schema.String }) {
  override get message(): string {
    return `couldn't read or save ${this.what}`;
  }
}

export class InvalidPatchId extends Schema.TaggedError<InvalidPatchId>()("InvalidPatchId", {}) {
  override get message(): string {
    return "patch names are lowercase letters, digits and '-', up to 48";
  }
}

/** The answer to a bridge request: the value, or what went wrong in words. */
export const Answer = <A extends Schema.Top>(value: A) =>
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), value }),
    Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
  ]);

export * from "./ipc.ts";
export type { UiId } from "./ui.ts";

/** The stack: the patches in order, and changing the order and which are on. */
export const StackUi = {
  list: uiId("stack-list"),
  patch: uiId("stack-patch"),
  toggle: uiId("stack-toggle"),
  up: uiId("stack-up"),
  down: uiId("stack-down"),
  message: uiId("stack-message"),
} as const;

/** Applying the stack over the installed app. */
export const RunUi = {
  install: uiId("run-install"),
  apply: uiId("run-apply"),
  steps: uiId("run-steps"),
  outcome: uiId("run-outcome"),
} as const;

/** Making or changing a patch: its workspace, then capturing the changes. */
export const AuthorUi = {
  id: uiId("author-id"),
  title: uiId("author-title"),
  summary: uiId("author-summary"),
  open: uiId("author-open"),
  capture: uiId("author-capture"),
  message: uiId("author-message"),
} as const;
