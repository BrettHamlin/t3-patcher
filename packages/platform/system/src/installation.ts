import { Installation } from "@app/apply";
import type { StepFailed } from "@app/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { couldnt, lastLines, run, stepFailed } from "./process.ts";

const regex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ProcessArgs = Schema.Struct({
  argv: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
});
const decodeProcessArgs = Schema.decodeUnknownOption(Schema.fromJsonString(ProcessArgs));

/** Reads a macOS process's NUL-delimited argv and environment from KERN_PROCARGS2, preserving spaces in paths. */
const READ_PROCARGS = [
  "import ctypes, json, sys",
  "pid = int(sys.argv[1])",
  'libc = ctypes.CDLL("/usr/lib/libc.dylib")',
  "mib = (ctypes.c_int * 3)(1, 49, pid)",
  "size = ctypes.c_size_t(0)",
  "if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0 or size.value < 4: sys.exit(1)",
  "buf = ctypes.create_string_buffer(size.value)",
  "if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0: sys.exit(1)",
  "raw = buf.raw[:size.value]",
  'argc = int.from_bytes(raw[:4], "little")',
  "rest = raw[4:]",
  'at = rest.find(b"\\x00")',
  "if at < 0: sys.exit(1)",
  "while at < len(rest) and rest[at] == 0: at += 1",
  'parts = rest[at:].split(b"\\x00")',
  'argv = [part.decode("utf-8", "replace") for part in parts[:argc]]',
  "env = {}",
  "for item in parts[argc:]:",
  "  if not item: continue",
  '  text = item.decode("utf-8", "replace")',
  '  eq = text.find("=")',
  "  if eq > 0: env[text[:eq]] = text[eq + 1:]",
  'print(json.dumps({"argv": argv, "env": env}))',
].join("\n");

/** Spawns a detached session so the relaunched headless server outlives the patcher without keeping its loop open. */
const SPAWN_DETACHED = [
  "import subprocess, sys",
  "subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)",
].join("\n");

const isHeadlessServerArgs = (args: ReadonlyArray<string>): boolean =>
  args[0] === "serve" ||
  (args.some((arg) => /(?:^|\/)bin\.[cm]?js$/.test(arg)) && !args.includes("--bootstrap-fd"));

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
  /** The command that opens the installed app again, its path appended (default `open -a`). */
  readonly opener?: readonly [string, ...Array<string>];
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

      const [opener, ...openArgs] = input.opener ?? ["open", "-a"];
      const reopen = run(spawner, opener, [...openArgs, input.installed]).pipe(
        Effect.flatMap((output) =>
          output.code === 0
            ? Effect.void
            : Effect.fail(stepFailed(`couldn't open ${input.installed}: ${lastLines(output.stderr, 5)}`)),
        ),
      );

      const macOsPrefix = `${path.join(input.installed, "Contents", "MacOS")}/`;
      /** When `pid` is a headless server run from `<installed>/Contents/MacOS/`, how to start it the same way again. */
      const headlessRelaunch = Effect.fn("Installation.headlessRelaunch")(function* (pid: number) {
        const proc = yield* run(spawner, "python3", ["-c", READ_PROCARGS, String(pid)]).pipe(
          Effect.orElseSucceed(() => ({ code: 1, stdout: "", stderr: "" })),
        );
        if (proc.code !== 0) return Option.none<Effect.Effect<void, StepFailed>>();
        const parsed = decodeProcessArgs(proc.stdout.trim());
        if (Option.isNone(parsed)) return Option.none<Effect.Effect<void, StepFailed>>();
        const at = parsed.value.argv.findIndex((arg) => arg.startsWith(macOsPrefix));
        const executable = at === -1 ? undefined : parsed.value.argv[at];
        const args = at === -1 ? [] : parsed.value.argv.slice(at + 1);
        if (executable === undefined || !isHeadlessServerArgs(args)) {
          return Option.none<Effect.Effect<void, StepFailed>>();
        }
        const cwdOutput = yield* run(spawner, "lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).pipe(
          Effect.orElseSucceed(() => ({ code: 1, stdout: "", stderr: "" })),
        );
        const cwd =
          cwdOutput.code === 0
            ? cwdOutput.stdout
                .split("\n")
                .find((line) => line.startsWith("n"))
                ?.slice(1)
            : undefined;
        return Option.some(
          run(spawner, "python3", ["-c", SPAWN_DETACHED, executable, ...args], {
            ...(cwd === undefined || cwd === "" ? {} : { cwd }),
            env: { ...parsed.value.env, ELECTRON_RUN_AS_NODE: "1" },
          }).pipe(
            Effect.flatMap((output) =>
              output.code === 0
                ? Effect.void
                : Effect.fail(stepFailed(`couldn't open ${input.installed}: ${lastLines(output.stderr, 5)}`)),
            ),
          ),
        );
      });

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
        install: Effect.fn("Installation.install")(function* (
          built: string,
          expected: string,
          options: { readonly relaunch?: number; readonly installed?: Effect.Effect<void, StepFailed> } = {},
        ) {
          const installedVersion = yield* version;
          if (installedVersion !== expected) {
            return yield* stepFailed(`${name} is now ${installedVersion}, not ${expected}: apply again`);
          }
          if (!(yield* exists(built))) return yield* stepFailed(`no built app at ${built}`);
          const recorded = (options.installed ?? Effect.void).pipe(
            Effect.mapError((failure) => stepFailed(`installed, but couldn't record the install: ${failure.reason}`)),
          );
          const relaunch = options.relaunch;
          if (relaunch === undefined) {
            const backup = yield* swap(built);
            yield* recorded;
            return `installed; the previous app is at ${backup}`;
          }
          const startAgain = Option.getOrElse(yield* headlessRelaunch(relaunch), () => reopen);
          yield* quit(relaunch);
          // The new app reads the install's record when it opens, so the record comes first. Whatever happens to the
          // swap or the record, the app (new, or the old one put back) opens again.
          const backup = yield* swap(built).pipe(
            Effect.tap(() => recorded),
            Effect.tapError(() => startAgain.pipe(Effect.ignore)),
          );
          const reopened = yield* startAgain.pipe(Effect.result);
          return Result.isSuccess(reopened)
            ? `installed and reopened; the previous app is at ${backup}`
            : `installed, but ${reopened.failure.reason}; the previous app is at ${backup}`;
        }),
      };
    }),
  );
