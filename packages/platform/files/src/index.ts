// STUB (desktop worktree): the agreed signatures only, so the app compiles. The files worktree's bodies replace it.
import { PatchWriter } from "@app/apply";
import type { RunReport, Settings, StorageFailed } from "@app/contracts";
import { Library, StackStore } from "@app/stack";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import type * as Path from "effect/Path";

type Needs = FileSystem.FileSystem | Path.Path;

export const fileLibrary = (_folder: string): Layer.Layer<Library, never, Needs> =>
  Layer.effect(Library)(Effect.die("not written yet"));

export const filePatchWriter = (_folder: string): Layer.Layer<PatchWriter, never, Needs> =>
  Layer.effect(PatchWriter)(Effect.die("not written yet"));

export const fileStackStore = (_userdata: string): Layer.Layer<StackStore, never, Needs> =>
  Layer.effect(StackStore)(Effect.die("not written yet"));

export const loadSettings = (_userdata: string): Effect.Effect<Settings, StorageFailed, Needs> => Effect.die("not written yet");

export const saveSettings = (_userdata: string, _settings: Settings): Effect.Effect<void, StorageFailed, Needs> =>
  Effect.die("not written yet");

export const loadReport = (_userdata: string): Effect.Effect<Option.Option<RunReport>, StorageFailed, Needs> =>
  Effect.die("not written yet");

export const saveReport = (_userdata: string, _report: RunReport): Effect.Effect<void, StorageFailed, Needs> =>
  Effect.die("not written yet");

export const defaultSettings = (_input: { readonly patches: string; readonly work: string }): Settings => {
  throw new Error("not written yet");
};
