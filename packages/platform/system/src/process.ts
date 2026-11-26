import { StepFailed } from "@app/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

export type Spawner = ChildProcessSpawner["Service"];

export const stepFailed = (reason: string): StepFailed => new StepFailed({ reason });

/** The last `count` lines of `text`, without trailing blank lines. */
export const lastLines = (text: string, count = 20): string => text.trimEnd().split("\n").slice(-count).join("\n");

export interface Output {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const text = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.mkString(Stream.decodeText(stream));

/** Runs `command` with `args` to the end and returns its exit code and output. Fails only if it can't be run. */
export const run = (
  spawner: Spawner,
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>>; readonly stdin?: string } = {},
): Effect.Effect<Output, StepFailed> =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          cwd: options.cwd,
          env: { ...options.env },
          extendEnv: true,
          stdin: options.stdin === undefined ? "ignore" : Stream.encodeText(Stream.make(options.stdin)),
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], {
        concurrency: "unbounded",
      });
      return { code, stdout, stderr };
    }),
  ).pipe(Effect.mapError((error) => stepFailed(`couldn't run ${command}: ${error.message}`)));

const shellEnv = (extra: Readonly<Record<string, string>>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "ELECTRON_RUN_AS_NODE" && key !== "T3_PATCHER_PREPULLED" && value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
};

/**
 * Runs `script` with /bin/sh in `folder`. Its output (stdout and stderr together) goes to `log` as it comes and is
 * returned with the exit code. Waits for the output only briefly after the shell exits, so a background process
 * holding the output open doesn't hold up the run.
 */
export const runLogged = (
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  input: {
    readonly folder: string;
    readonly script: string;
    readonly env: Readonly<Record<string, string>>;
    readonly log: string;
  },
): Effect.Effect<{ readonly code: number; readonly output: string }, StepFailed> =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("/bin/sh", ["-c", input.script], {
          cwd: input.folder,
          env: shellEnv(input.env),
          extendEnv: false,
          stdin: "ignore",
        }),
      );
      const kept: Array<string> = [];
      const drain = yield* handle.all.pipe(
        Stream.decodeText,
        Stream.tap((chunk) => Effect.sync(() => kept.push(chunk))),
        Stream.encodeText,
        Stream.run(fs.sink(input.log)),
        Effect.forkScoped,
      );
      const code = yield* handle.exitCode;
      yield* Fiber.join(drain).pipe(Effect.timeoutOption("2 seconds"));
      return { code, output: kept.join("") };
    }),
  ).pipe(Effect.mapError((error) => stepFailed(`couldn't run ${input.script}: ${error.message}`)));

/** A StepFailed saying what couldn't be done, for `Effect.mapError`. */
export const couldnt = (what: string) => (): StepFailed => stepFailed(`couldn't ${what}`);
