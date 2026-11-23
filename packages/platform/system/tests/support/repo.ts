// Real folders and real git for the tests: an upstream repository with two release tags.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export type Services = ChildProcessSpawner | FileSystem.FileSystem | Path.Path;

/** Runs a program to the end and returns its stdout; dies if it exits non-zero. */
export const sh = (cwd: string, command: string, args: ReadonlyArray<string>): Effect.Effect<string, never, Services> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          cwd,
          env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
          extendEnv: true,
          stdin: "ignore",
        }),
      );
      const [out, err, code] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
        { concurrency: "unbounded" },
      );
      if (code !== 0) return yield* Effect.die(`${command} ${args.join(" ")} failed (exit ${code}): ${err}`);
      return out;
    }),
  ).pipe(Effect.orDie);

export const git = (cwd: string, ...args: ReadonlyArray<string>): Effect.Effect<string, never, Services> =>
  sh(cwd, "git", ["-c", "user.name=test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false", ...args]);

/** A new folder (its real path), removed when the scope closes. */
export const temporary: Effect.Effect<string, never, FileSystem.FileSystem | Scope.Scope> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "system-" }));
}).pipe(Effect.orDie);

export const write = (file: string, content: string): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, content);
  }).pipe(Effect.orDie);

export const read = (file: string): Effect.Effect<string, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(file)).pipe(Effect.orDie);

export const exists = (file: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) => fs.exists(file)).pipe(Effect.orDie);

export const V1 = "one\ntwo\nthree\n";
export const V11 = "one\ntwo upstream\nthree\n";
export const PATCHED = "one\ntwo patched\nthree\n";

export interface Upstream {
  readonly folder: string;
  readonly v1: string;
  readonly v11: string;
  /** A diff made on v1.0.0: changes the line v1.1.0 also changes, and adds new.txt. */
  readonly conflicting: string;
  /** A diff made on v1.0.0 that touches only other.txt, which v1.1.0 leaves alone. */
  readonly clean: string;
}

/** `<root>/upstream`: v1.0.0 with a.txt, other.txt and a .gitignore; v1.1.0 changes a.txt's second line. */
export const upstream = (root: string): Effect.Effect<Upstream, never, Services> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const folder = path.join(root, "upstream");
    const file = (name: string) => path.join(folder, name);
    yield* write(file("a.txt"), V1);
    yield* git(folder, "init", "--quiet", "--initial-branch=main");
    yield* write(file("other.txt"), "left\nalone\n");
    yield* write(file(".gitignore"), "ignored/\n");
    yield* git(folder, "add", "-A");
    yield* git(folder, "commit", "--quiet", "-m", "v1.0.0");
    yield* git(folder, "tag", "v1.0.0");
    const v1 = (yield* git(folder, "rev-parse", "HEAD")).trim();

    yield* write(file("a.txt"), PATCHED);
    yield* write(file("new.txt"), "new\n");
    yield* git(folder, "add", "-A");
    const conflicting = yield* git(folder, "diff", "--cached", "--binary", "--full-index", "HEAD");
    yield* git(folder, "reset", "--quiet", "--hard");
    yield* git(folder, "clean", "-fdq");
    yield* write(file("other.txt"), "left\nchanged\n");
    yield* git(folder, "add", "-A");
    const clean = yield* git(folder, "diff", "--cached", "--binary", "--full-index", "HEAD");
    yield* git(folder, "reset", "--quiet", "--hard");

    yield* write(file("a.txt"), V11);
    yield* git(folder, "commit", "--quiet", "-am", "v1.1.0");
    yield* git(folder, "tag", "v1.1.0");
    const v11 = (yield* git(folder, "rev-parse", "HEAD")).trim();
    // The patches' blobs were only staged, never committed: drop them, so clones (which copy loose objects) lack them.
    yield* git(folder, "gc", "--quiet", "--prune=now");
    return { folder, v1, v11, conflicting, clean };
  });

/** Applies `diff` with `git apply` to a fresh clone of `repository` at `tag`, and returns `file`'s content. */
export const applyElsewhere = (
  folder: string,
  repository: string,
  tag: string,
  diff: string,
  file: string,
): Effect.Effect<string, never, Services> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* sh(path.dirname(folder), "git", ["clone", "--quiet", repository, folder]);
    yield* sh(folder, "git", ["checkout", "--quiet", "--detach", tag]);
    const patch = `${folder}.patch`;
    yield* write(patch, diff);
    yield* sh(folder, "git", ["apply", patch]);
    return yield* read(path.join(folder, file));
  });
