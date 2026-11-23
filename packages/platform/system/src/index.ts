// STUB (desktop worktree): the agreed signatures only, so the app compiles. The system worktree's bodies replace it.
import { Installation, Resolver, Shell, Source } from "@app/apply";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

type Needs = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path;

export const gitSource = (_options: { readonly work: string; readonly repository: string }): Layer.Layer<Source, never, Needs> =>
  Layer.effect(Source)(Effect.die("not written yet"));

export const commandShell = (_logs: string): Layer.Layer<Shell, never, Needs> =>
  Layer.effect(Shell)(Effect.die("not written yet"));

export const commandResolver = (_options: { readonly command: string; readonly logs: string }): Layer.Layer<Resolver, never, Needs> =>
  Layer.effect(Resolver)(Effect.die("not written yet"));

export const macInstallation = (_options: { readonly installed: string; readonly backups: string }): Layer.Layer<Installation, never, Needs> =>
  Layer.effect(Installation)(Effect.die("not written yet"));
