import { Installation } from "@app/apply";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { couldnt, lastLines, run, stepFailed } from "./process.ts";

const regex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The installed macOS app at `installed`; replaced apps are kept in `backups`. */
export const macInstallation = (input: {
  readonly installed: string;
  readonly backups: string;
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

      return {
        version,
        install: Effect.fn("Installation.install")(function* (built: string) {
          const running = yield* run(spawner, "pgrep", ["-f", regex(path.join(input.installed, "Contents", "MacOS") + "/")]);
          if (running.code === 0) return yield* stepFailed(`quit ${name} first`);
          if (!(yield* exists(built))) return yield* stepFailed(`no built app at ${built}`);
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
          return `installed; the previous app is at ${backup}`;
        }),
      };
    }),
  );
