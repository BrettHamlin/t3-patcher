import { Installation } from "@app/apply";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { couldnt, lastLines, run, stepFailed } from "./process.ts";

const regex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether process `pid` is running: signal 0 checks without sending; EPERM means it runs as someone else. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/** Ask process `pid` to quit (SIGTERM); false if it had already gone. */
const terminate = (pid: number): boolean => {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
};

/**
 * The installed macOS app at `installed`; replaced apps are kept in `backups`. An install that relaunches waits up to
 * `quitTimeout` (default 60 seconds) for the app to quit.
 */
export const macInstallation = (input: {
  readonly installed: string;
  readonly backups: string;
  readonly quitTimeout?: Duration.Input;
}): Layer.Layer<Installation, never, ChildProcessSpawner | FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Installation)(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const name = path.basename(input.installed, ".app");

      const version = run(spawner, "plutil", [
        "-extract",
        "CFBundleShortVersionString",
        "raw",
        "-o",
        "-",
        path.join(input.installed, "Contents", "Info.plist"),
      ]).pipe(
        Effect.map((output) => (output.code === 0 ? output.stdout.trim() : "")),
        Effect.orElseSucceed(() => ""),
        Effect.filterOrFail(
          (read) => read !== "",
          () => stepFailed(`couldn't read the installed version of ${input.installed}`),
        ),
      );

      const exists = (target: string) => fs.exists(target).pipe(Effect.mapError(couldnt(`read ${target}`)));
      const ditto = (from: string, to: string) =>
        run(spawner, "ditto", [from, to]).pipe(
          Effect.flatMap((output) =>
            output.code === 0
              ? Effect.void
              : Effect.fail(stepFailed(`couldn't copy ${from} to ${to}: ${lastLines(output.stderr, 5)}`)),
          ),
        );
      // A rename on the same volume; otherwise a copy, then the original removed.
      const move = (from: string, to: string) =>
        fs.rename(from, to).pipe(
          Effect.catch(() =>
            ditto(from, to).pipe(
              Effect.andThen(fs.remove(from, { recursive: true }).pipe(Effect.mapError(couldnt(`remove ${from}`)))),
            ),
          ),
        );

      const backupPath = Effect.gen(function* () {
        const installedVersion = yield* version;
        yield* fs.makeDirectory(input.backups, { recursive: true }).pipe(Effect.mapError(couldnt(`make ${input.backups}`)));
        for (let n = 1; ; n += 1) {
          const candidate = path.join(input.backups, `${name}-${installedVersion}-${n}.app`);
          if (!(yield* exists(candidate))) return candidate;
        }
      });

      const executables = regex(path.join(input.installed, "Contents", "MacOS") + "/");
      const running = run(spawner, "pgrep", ["-f", executables]).pipe(Effect.map((output) => output.code === 0));
      const timeout = Duration.fromInputUnsafe(input.quitTimeout ?? "60 seconds");

      /** SIGTERM to `pid`, then wait until it and every process running the app's executables have exited. */
      const quit = Effect.fn("Installation.quit")(function* (pid: number) {
        terminate(pid);
        const gone = yield* Effect.gen(function* () {
          while (alive(pid) || (yield* running)) yield* Effect.sleep("200 millis");
        }).pipe(Effect.timeoutOption(timeout));
        if (Option.isNone(gone)) return yield* stepFailed(`${name} didn't quit within ${Duration.format(timeout)}`);
      });

      const reopen = run(spawner, "open", ["-a", input.installed]).pipe(
        Effect.flatMap((output) =>
          output.code === 0
            ? Effect.void
            : Effect.fail(stepFailed(`couldn't open ${input.installed}: ${lastLines(output.stderr, 5)}`)),
        ),
      );

      const swap = Effect.fn("Installation.swap")(function* (built: string) {
        if (yield* running) return yield* stepFailed(`quit ${name} first`);
        const backup = yield* backupPath;
        yield* move(input.installed, backup);
        yield* ditto(built, input.installed).pipe(
          Effect.tapError(() =>
            fs.remove(input.installed, { recursive: true, force: true }).pipe(
              Effect.ignore,
              Effect.andThen(move(backup, input.installed).pipe(Effect.ignore)),
            ),
          ),
        );
        return backup;
      });

      return {
        version,
        install: Effect.fn("Installation.install")(function* (built: string, expected: string, relaunch?: number) {
          const installedVersion = yield* version;
          if (installedVersion !== expected) {
            return yield* stepFailed(`${name} is now ${installedVersion}, not ${expected}: apply again`);
          }
          if (!(yield* exists(built))) return yield* stepFailed(`no built app at ${built}`);
          if (relaunch === undefined) {
            return `installed; the previous app is at ${yield* swap(built)}`;
          }
          yield* quit(relaunch);
          // Whatever happens to the swap, the app (new, or the old one put back) opens again.
          const backup = yield* swap(built).pipe(
            Effect.matchEffect({
              onFailure: (failure) => reopen.pipe(Effect.ignore, Effect.andThen(Effect.fail(failure))),
              onSuccess: (done) => reopen.pipe(Effect.as(done)),
            }),
          );
          return `installed and reopened; the previous app is at ${backup}`;
        }),
      };
    }),
  );
