import { Resolver, Shell } from "@app/apply";
import { Commit, PatchId, StepFailed } from "@app/contracts";
import { commandResolver, commandShell } from "@app/system";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { POSIX_SUPERVISOR } from "../src/process.ts";
import { exists, read, sh, temporary } from "./support/repo.ts";

const shellIn = (logs: string) =>
  Shell.useSync((service) => service).pipe(Effect.provide(commandShell(logs).pipe(Layer.provide(NodeServices.layer))));
const resolverWith = (command: string, logs: string) =>
  Resolver.useSync((service) => service).pipe(
    Effect.provide(commandResolver({ command, logs }).pipe(Layer.provide(NodeServices.layer))),
  );
const numbers = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i)).join("\n");

const setEnvVar = (name: string, value: string | undefined): string | undefined => {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  return previous;
};

const processState = (pid: number): "alive" | "eperm" | "esrch" | "other" => {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ESRCH") return "esrch";
      if (error.code === "EPERM") return "eperm";
    }
    return "other";
  }
};

const forceKill = (pid: number): void => {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best-effort test cleanup.
  }
};

/** Shell snippet that double-forks a `setsid()` (`detached: true`) Node sleeper keeping stdio inherited, writing its PID to `pidFile`. */
const spawnSetsidNodeInherited = (pidFile: string): string =>
  `'${process.execPath.replaceAll("'", `'\\''`)}' -e 'const { spawn } = require("node:child_process"); const fs = require("node:fs"); const p = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "inherit" }); fs.writeFileSync(process.argv[1], String(p.pid)); p.unref();' "${pidFile}"`;

/** Shell snippet that double-forks a `setsid()` SIP-protected `/bin/sleep` (whose env macOS XNU hides from `ps -E`), writing its PID to `pidFile`. */
const spawnSetsidSipSleep = (pidFile: string): string =>
  `'${process.execPath.replaceAll("'", `'\\''`)}' -e 'const { spawn } = require("node:child_process"); const fs = require("node:fs"); const p = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" }); fs.writeFileSync(process.argv[1], String(p.pid)); p.unref();' "${pidFile}"`;

describe("commandShell", () => {
  it.live("runs the command in the folder with the extra environment, logging stdout and stderr", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temporary;
      const logs = path.join(root, "logs");
      const shell = yield* shellIn(logs);
      yield* shell.run(root, { name: "say hello/there", run: 'echo "$GREETING from $(pwd -P)"; echo oops >&2' }, { GREETING: "hi" });
      expect(yield* read(path.join(logs, "say-hello-there.log"))).toBe(`hi from ${root}\noops\n`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("fails with the exit code and the last 20 lines of output", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temporary;
      const logs = path.join(root, "logs");
      const shell = yield* shellIn(logs);
      const failed = yield* Effect.flip(shell.run(root, { name: "count", run: "seq 1 25; exit 3" }, {}));
      expect(failed).toEqual(
        new StepFailed({ reason: `count failed (exit 3; log ${path.join(logs, "count.log")}): ${numbers(6, 25)}` }),
      );
      expect(yield* read(path.join(logs, "count.log"))).toBe(`${numbers(1, 25)}\n`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("clears inherited ELECTRON_RUN_AS_NODE and VITEST_MAX_WORKERS unless explicitly given", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temporary;
      const logs = path.join(root, "logs");
      const shell = yield* shellIn(logs);
      const prevRunAsNode = setEnvVar("ELECTRON_RUN_AS_NODE", "1");
      const prevVitestWorkers = setEnvVar("VITEST_MAX_WORKERS", "8");
      yield* Effect.gen(function* () {
        yield* shell.run(
          root,
          { name: "default env", run: 'printf "%s|%s|%s" "${ELECTRON_RUN_AS_NODE:-unset}" "${VITEST_MAX_WORKERS:-unset}" "$EXTRA"' },
          { EXTRA: "ok" },
        );
        yield* shell.run(
          root,
          { name: "explicit env", run: 'printf "%s|%s" "${ELECTRON_RUN_AS_NODE:-unset}" "${VITEST_MAX_WORKERS:-unset}"' },
          { ELECTRON_RUN_AS_NODE: "1", VITEST_MAX_WORKERS: "2" },
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            setEnvVar("ELECTRON_RUN_AS_NODE", prevRunAsNode);
            setEnvVar("VITEST_MAX_WORKERS", prevVitestWorkers);
          }),
        ),
      );
      expect([
        yield* read(path.join(logs, "default-env.log")),
        yield* read(path.join(logs, "explicit-env.log")),
      ]).toEqual(["unset|unset|ok", "1|2"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("fails with no-concurrency-escapes and reaps leaked children (inherited stdio, setsid daemons, and detached SIP /bin/sleep) when a command exits 0", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temporary;
      const logs = path.join(root, "logs");
      const shell = yield* shellIn(logs);
      const bgFile = path.join(root, "bg.pid");
      const daemonFile = path.join(root, "daemon.pid");
      const sipSleepFile = path.join(root, "sip-sleep.pid");
      const failed = yield* Effect.flip(
        shell.run(
          root,
          {
            name: "leaking step",
            run: [
              "echo before-leak",
              "/bin/sleep 60 &",
              `printf "%s" "$!" > "${bgFile}"`,
              spawnSetsidNodeInherited(daemonFile),
              spawnSetsidSipSleep(sipSleepFile),
            ].join("\n"),
          },
          {},
        ),
      );
      const bgPid = Number.parseInt((yield* read(bgFile)).trim(), 10);
      const daemonPid = Number.parseInt((yield* read(daemonFile)).trim(), 10);
      const sipSleepPid = Number.parseInt((yield* read(sipSleepFile)).trim(), 10);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          forceKill(bgPid);
          forceKill(daemonPid);
          forceKill(sipSleepPid);
        }),
      );
      const nodeComm = path.basename(process.execPath);
      const ordered = [
        { pid: bgPid, comm: "sleep" },
        { pid: daemonPid, comm: nodeComm },
        { pid: sipSleepPid, comm: "sleep" },
      ].toSorted((a, b) => a.pid - b.pid);
      expect(failed).toEqual(
        new StepFailed({
          reason: `[no-concurrency-escapes] step left live process(es) running: ${ordered.map((item) => `${item.comm} (pid ${item.pid})`).join(", ")}`,
        }),
      );
      expect([
        Number.isInteger(bgPid) && bgPid > 0,
        Number.isInteger(daemonPid) && daemonPid > 0,
        Number.isInteger(sipSleepPid) && sipSleepPid > 0,
        processState(bgPid),
        processState(daemonPid),
        processState(sipSleepPid),
        yield* read(path.join(logs, "leaking-step.log")),
      ]).toEqual([true, true, true, "esrch", "esrch", "esrch", "before-leak\n"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("reaps background and detached children when a command exits non-zero while returning its exit failure", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temporary;
      const logs = path.join(root, "logs");
      const shell = yield* shellIn(logs);
      const bgFile = path.join(root, "bg.pid");
      const daemonFile = path.join(root, "daemon.pid");
      const sipSleepFile = path.join(root, "sip-sleep.pid");
      const failed = yield* Effect.flip(
        shell.run(
          root,
          {
            name: "failing leak",
            run: [
              "/bin/sleep 60 &",
              `printf "%s" "$!" > "${bgFile}"`,
              spawnSetsidNodeInherited(daemonFile),
              spawnSetsidSipSleep(sipSleepFile),
              "echo boom",
              "exit 3",
            ].join("\n"),
          },
          {},
        ),
      );
      const bgPid = Number.parseInt((yield* read(bgFile)).trim(), 10);
      const daemonPid = Number.parseInt((yield* read(daemonFile)).trim(), 10);
      const sipSleepPid = Number.parseInt((yield* read(sipSleepFile)).trim(), 10);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          forceKill(bgPid);
          forceKill(daemonPid);
          forceKill(sipSleepPid);
        }),
      );
      expect(failed).toEqual(
        new StepFailed({ reason: `failing leak failed (exit 3; log ${path.join(logs, "failing-leak.log")}): boom` }),
      );
      expect([
        Number.isInteger(bgPid) && bgPid > 0,
        Number.isInteger(daemonPid) && daemonPid > 0,
        Number.isInteger(sipSleepPid) && sipSleepPid > 0,
        processState(bgPid),
        processState(daemonPid),
        processState(sipSleepPid),
      ]).toEqual([true, true, true, "esrch", "esrch", "esrch"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("reaps /bin/sh, background children and detached daemons (including SIP /bin/sleep) on Fiber.interrupt without touching unrelated processes", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temporary;
      const logs = path.join(root, "logs");
      const shell = yield* shellIn(logs);
      const outsidePid = yield* sh(root, process.execPath, [
        "-e",
        'const { spawn } = require("node:child_process"); const p = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" }); console.log(p.pid); p.unref();',
      ]).pipe(Effect.map((out) => Number.parseInt(out.trim(), 10)));
      yield* Effect.addFinalizer(() => Effect.sync(() => forceKill(outsidePid)));

      const daemonFile = path.join(root, "daemon.pid");
      const sipSleepFile = path.join(root, "sip-sleep.pid");
      const pidsFile = path.join(root, "interrupted.pids");
      const fiber = yield* Effect.forkScoped(
        shell.run(
          root,
          {
            name: "interrupted",
            run: [
              "/bin/sleep 60 &",
              "bg=$!",
              spawnSetsidNodeInherited(daemonFile),
              spawnSetsidSipSleep(sipSleepFile),
              `printf "%s\\n%s\\n" "$$" "$bg" > "${pidsFile}.tmp"`,
              `mv "${pidsFile}.tmp" "${pidsFile}"`,
              "/bin/sleep 60",
              "true",
            ].join("\n"),
          },
          {},
        ),
      );
      while (!(yield* exists(pidsFile))) {
        yield* Effect.sleep("10 millis");
      }
      const [shellLine = "", bgLine = ""] = (yield* read(pidsFile)).trim().split("\n");
      const shellPid = Number.parseInt(shellLine, 10);
      const bgPid = Number.parseInt(bgLine, 10);
      const daemonPid = Number.parseInt((yield* read(daemonFile)).trim(), 10);
      const sipSleepPid = Number.parseInt((yield* read(sipSleepFile)).trim(), 10);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          forceKill(shellPid);
          forceKill(bgPid);
          forceKill(daemonPid);
          forceKill(sipSleepPid);
        }),
      );
      yield* Fiber.interrupt(fiber);
      expect([
        Number.isInteger(shellPid) && shellPid > 0,
        Number.isInteger(bgPid) && bgPid > 0,
        Number.isInteger(daemonPid) && daemonPid > 0,
        Number.isInteger(sipSleepPid) && sipSleepPid > 0,
        processState(shellPid),
        processState(bgPid),
        processState(daemonPid),
        processState(sipSleepPid),
        processState(outsidePid),
      ]).toEqual([true, true, true, true, "esrch", "esrch", "esrch", "esrch", "alive"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("fails with [volume-lost] and SIGKILLs the tree immediately when a watched backing path disappears", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temporary;
      const logs = path.join(root, "logs");
      const shell = yield* shellIn(logs);
      const missingWatch = path.join(root, "missing-volume");
      const markerFile = path.join(root, "never-ran.txt");
      const missingFailed = yield* Effect.flip(
        shell.run(
          root,
          { name: "missing watch", run: `printf ran > "${markerFile}"` },
          { BSTACK_WATCH_PATH: missingWatch },
        ),
      );
      expect(missingFailed).toEqual(
        new StepFailed({ reason: `[volume-lost] required $BSTACK_WATCH_PATH ${missingWatch} is not available` }),
      );
      expect(yield* exists(markerFile)).toBe(false);

      const liveWatch = path.join(root, "live-volume");
      yield* sh(root, "/bin/mkdir", ["-p", liveWatch]);
      const resolvedLiveWatch = (yield* sh(liveWatch, "/bin/pwd", ["-P"])).trim();
      const daemonFile = path.join(root, "vol-daemon.pid");
      const fiber = yield* Effect.forkScoped(
        shell.run(
          root,
          {
            name: "unmounted watch",
            run: [spawnSetsidNodeInherited(daemonFile), "/bin/sleep 60"].join("\n"),
          },
          { BSTACK_WATCH_PATH: liveWatch },
        ),
      );
      while (!(yield* exists(daemonFile))) {
        yield* Effect.sleep("15 millis");
      }
      const daemonPid = Number.parseInt((yield* read(daemonFile)).trim(), 10);
      yield* Effect.addFinalizer(() => Effect.sync(() => forceKill(daemonPid)));
      yield* sh(root, "/bin/rm", ["-rf", liveWatch]);
      const unmountFailed = yield* Effect.flip(Fiber.join(fiber));
      expect(unmountFailed).toEqual(
        new StepFailed({
          reason: `[volume-lost] backing path ${resolvedLiveWatch} became unavailable (volume unmounted); terminated child process tree immediately so revoked-vnode processes cannot spin CPU.`,
        }),
      );
      expect(processState(daemonPid)).toBe("esrch");

      const workDir = path.join(root, "checkout");
      const cacheDir = path.join(root, "cache");
      const envDir = path.join(root, "external-build-env");
      const movedEnvDir = path.join(root, "moved-build-env");
      const envFile = path.join(envDir, "env.sh");
      yield* sh(root, "/bin/mkdir", ["-p", workDir, cacheDir, envDir]);
      yield* sh(root, "/bin/sh", ["-c", `printf 'true\\n' > "${envFile}"`]);
      const resolvedEnvDir = (yield* sh(envDir, "/bin/pwd", ["-P"])).trim();
      const envFailed = yield* Effect.flip(
        shell.run(
          workDir,
          {
            name: "env dir lost",
            run: `. "$T3_PATCHER_ENV" && /bin/mv "${envDir}" "${movedEnvDir}" && /bin/sleep 1`,
          },
          {
            PATH: "/usr/bin:/bin",
            BSTACK_CACHE_DIR: cacheDir,
            T3_PATCHER_ENV: envFile,
          },
        ),
      );
      expect(envFailed).toEqual(
        new StepFailed({
          reason: `[volume-lost] backing path ${resolvedEnvDir} became unavailable (volume unmounted); terminated child process tree immediately so revoked-vnode processes cannot spin CPU.`,
        }),
      );

      const relEnvDir = path.join(workDir, "envdir");
      const extCacheDir = path.join(root, "separate-cache-vol");
      const movedExtCacheDir = path.join(root, "moved-cache-vol");
      yield* sh(root, "/bin/mkdir", ["-p", relEnvDir, extCacheDir]);
      yield* sh(root, "/bin/sh", ["-c", `printf 'export PLAYWRIGHT_BROWSERS_PATH="${extCacheDir}"\\n' > "${path.join(relEnvDir, "env.sh")}"`]);
      const resolvedExtCacheDir = (yield* sh(extCacheDir, "/bin/pwd", ["-P"])).trim();
      const cacheLostFailed = yield* Effect.flip(
        shell.run(
          workDir,
          {
            name: "external cache lost",
            run: `. "$T3_PATCHER_ENV" && /bin/mv "${extCacheDir}" "${movedExtCacheDir}"`,
          },
          {
            PATH: "/usr/bin:/bin",
            BSTACK_CACHE_DIR: cacheDir,
            T3_PATCHER_ENV: "./envdir/env.sh",
          },
        ),
      );
      expect(cacheLostFailed).toEqual(
        new StepFailed({
          reason: `[volume-lost] backing path ${resolvedExtCacheDir} became unavailable (volume unmounted); terminated child process tree immediately so revoked-vnode processes cannot spin CPU.`,
        }),
      );

      const graceWatch = path.join(root, "grace-watch");
      const movedGraceWatch = path.join(root, "moved-grace-watch");
      yield* sh(root, "/bin/mkdir", ["-p", graceWatch]);
      const resolvedGraceWatch = (yield* sh(graceWatch, "/bin/pwd", ["-P"])).trim();
      const s17Failed = yield* Effect.flip(
        shell.run(
          workDir,
          {
            name: "grace window unmount",
            run: `(/bin/sleep 0.34 && /bin/mv "${graceWatch}" "${movedGraceWatch}") &`,
          },
          { BSTACK_CACHE_DIR: cacheDir, BSTACK_WATCH_PATH: graceWatch },
        ),
      );
      expect(s17Failed).toEqual(
        new StepFailed({
          reason: `[volume-lost] backing path ${resolvedGraceWatch} became unavailable (volume unmounted); terminated child process tree immediately so revoked-vnode processes cannot spin CPU.`,
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("evaluates $T3_PATCHER_ENV under supervision, honors overrides and effective HOME config, and rejects dangling symlinks", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temporary;
      const logs = path.join(root, "logs");
      const shell = yield* shellIn(logs);
      const workDir = path.join(root, "checkout");
      const cacheDir = path.join(root, "cache");
      const relEnvDir = path.join(workDir, "envdir");
      const mountContainer = path.join(root, "mount-container");
      const unmountedTarget = path.join(mountContainer, "disconnected-vol", "cache");
      yield* sh(root, "/bin/mkdir", ["-p", workDir, cacheDir, relEnvDir, mountContainer]);
      yield* sh(root, "/bin/chmod", ["555", mountContainer]);
      yield* Effect.addFinalizer(() => sh(root, "/bin/chmod", ["755", mountContainer]).pipe(Effect.ignore));

      const localReplacementCache = path.join(root, "local-replacement-cache");
      yield* sh(root, "/bin/mkdir", ["-p", localReplacementCache]);
      yield* sh(
        root,
        "/bin/sh",
        [
          "-c",
          `printf 'export PLAYWRIGHT_BROWSERS_PATH="${localReplacementCache}"\\nunset CARGO_HOME\\n' > "${path.join(relEnvDir, "override.sh")}"`,
        ],
      );
      const prevCwd = process.cwd();
      yield* Effect.gen(function* () {
        process.chdir(root);
        yield* shell.run(
          "checkout",
          {
            name: "relative checkout override",
            run: '. "$T3_PATCHER_ENV" && printf "%s|%s" "$PLAYWRIGHT_BROWSERS_PATH" "${CARGO_HOME:-unset}"',
          },
          {
            PATH: "/usr/bin:/bin",
            BSTACK_CACHE_DIR: "./../cache",
            T3_PATCHER_ENV: "./envdir/override.sh",
            PLAYWRIGHT_BROWSERS_PATH: unmountedTarget,
            CARGO_HOME: path.join(mountContainer, "disconnected-vol", "cargo"),
          },
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            process.chdir(prevCwd);
          }),
        ),
      );
      expect(yield* read(path.join(logs, "relative-checkout-override.log"))).toBe(`${localReplacementCache}|unset`);

      const condOkEnv = path.join(relEnvDir, "cond-ok.sh");
      const cmdSubBadEnv = path.join(relEnvDir, "cmdsub-bad.sh");
      yield* sh(
        root,
        "/bin/sh",
        [
          "-c",
          `printf 'if false; then export PLAYWRIGHT_BROWSERS_PATH="${unmountedTarget}"; else export PLAYWRIGHT_BROWSERS_PATH="${localReplacementCache}"; fi\\n' > "${condOkEnv}"`,
        ],
      );
      yield* sh(
        root,
        "/bin/sh",
        [
          "-c",
          `printf 'export PLAYWRIGHT_BROWSERS_PATH="$(printf %%s "${unmountedTarget}")"\\n' > "${cmdSubBadEnv}"`,
        ],
      );
      yield* shell.run(
        workDir,
        { name: "conditional env ok", run: '. "$T3_PATCHER_ENV" && printf "%s" "$PLAYWRIGHT_BROWSERS_PATH"' },
        { PATH: "/usr/bin:/bin", BSTACK_CACHE_DIR: cacheDir, T3_PATCHER_ENV: condOkEnv },
      );
      expect(yield* read(path.join(logs, "conditional-env-ok.log"))).toBe(localReplacementCache);
      const cmdSubFailed = yield* Effect.flip(
        shell.run(
          workDir,
          { name: "cmdsub env bad", run: "true" },
          { PATH: "/usr/bin:/bin", BSTACK_CACHE_DIR: cacheDir, T3_PATCHER_ENV: cmdSubBadEnv },
        ),
      );

      const danglingLink = path.join(workDir, "dangling-cache-link");
      const containerLink = path.join(workDir, "container-link");
      const preflightPidFile = path.join(root, "preflight-side-effect.pid");
      yield* sh(root, "/bin/ln", ["-s", unmountedTarget, danglingLink]);
      yield* sh(root, "/bin/ln", ["-s", mountContainer, containerLink]);
      const sideEffectEnv = path.join(relEnvDir, "side-effect.sh");
      yield* sh(
        root,
        "/bin/sh",
        [
          "-c",
          `printf '/bin/sleep 60 &\\nprintf "%%s" "$!" > "${preflightPidFile}"\\nexport PLAYWRIGHT_BROWSERS_PATH="${unmountedTarget}"\\n' > "${sideEffectEnv}"`,
        ],
      );
      const s13Failed = yield* Effect.flip(
        shell.run(
          workDir,
          { name: "preflight reaped", run: "true" },
          { BSTACK_CACHE_DIR: cacheDir, T3_PATCHER_ENV: sideEffectEnv },
        ),
      );
      const preflightPid = Number.parseInt((yield* read(preflightPidFile)).trim(), 10);
      yield* Effect.addFinalizer(() => Effect.sync(() => forceKill(preflightPid)));
      const s15DanglingFailed = yield* Effect.flip(
        shell.run(
          workDir,
          { name: "dangling link cache", run: "true" },
          { BSTACK_CACHE_DIR: cacheDir, PLAYWRIGHT_BROWSERS_PATH: danglingLink },
        ),
      );
      const s15ContainerFailed = yield* Effect.flip(
        shell.run(
          workDir,
          { name: "container link cache", run: "true" },
          { BSTACK_CACHE_DIR: cacheDir, PLAYWRIGHT_BROWSERS_PATH: path.join(containerLink, "disconnected-vol", "cache") },
        ),
      );

      const altHome = path.join(root, "alt-home");
      const altConfigDir = path.join(altHome, ".config", "b-stack");
      const altConfigFile = path.join(altConfigDir, "config.toml");
      const s18Env = path.join(relEnvDir, "alt-home.sh");
      yield* sh(root, "/bin/mkdir", ["-p", altConfigDir]);
      yield* sh(
        root,
        "/bin/sh",
        [
          "-c",
          `printf 'note = """\\ncache_dir = "/wrong"\\n"""\\n"cache_dir" = "${path.join(mountContainer, "disconnected-vol")}\\\\U0000002Fcache" # """\\n' > "${altConfigFile}"`,
        ],
      );
      yield* sh(
        root,
        "/bin/sh",
        ["-c", `printf 'export HOME="${altHome}"\\nunset BSTACK_CACHE_DIR\\n' > "${s18Env}"`],
      );
      const s18Failed = yield* Effect.flip(
        shell.run(
          workDir,
          { name: "effective home config", run: "true" },
          { BSTACK_CACHE_DIR: cacheDir, T3_PATCHER_ENV: s18Env },
        ),
      );

      expect([
        Number.isInteger(preflightPid) && preflightPid > 0,
        processState(preflightPid),
        cmdSubFailed,
        s13Failed,
        s15DanglingFailed,
        s15ContainerFailed,
        s18Failed,
      ]).toEqual([
        true,
        "esrch",
        new StepFailed({ reason: `[volume-lost] required $PLAYWRIGHT_BROWSERS_PATH ${unmountedTarget} is not available` }),
        new StepFailed({ reason: `[volume-lost] required $PLAYWRIGHT_BROWSERS_PATH ${unmountedTarget} is not available` }),
        new StepFailed({ reason: `[volume-lost] required $PLAYWRIGHT_BROWSERS_PATH ${danglingLink} is not available` }),
        new StepFailed({
          reason: `[volume-lost] required $PLAYWRIGHT_BROWSERS_PATH ${path.join(containerLink, "disconnected-vol", "cache")} is not available`,
        }),
        new StepFailed({ reason: `[volume-lost] required cache_dir (${altConfigFile}) ${unmountedTarget} is not available` }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("stops launch with [volume-lost] when $T3_PATCHER_ENV evaluation times out", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temporary;
      const logs = path.join(root, "logs");
      const shell = yield* shellIn(logs);
      const workDir = path.join(root, "checkout");
      const cacheDir = path.join(root, "cache");
      const envDir = path.join(workDir, "envdir");
      const s19TimeoutEnv = path.join(envDir, "timeout.sh");
      const s19NeverRan = path.join(root, "s19-never-ran.txt");
      yield* sh(root, "/bin/mkdir", ["-p", workDir, cacheDir, envDir]);
      yield* sh(
        root,
        "/bin/sh",
        ["-c", `printf 'export BSTACK_CACHE_DIR="$(/bin/sleep 2.3 && printf /nonexistent)"\\n' > "${s19TimeoutEnv}"`],
      );
      const s19Failed = yield* Effect.flip(
        shell.run(
          workDir,
          { name: "probe timeout stops launch", run: `printf ran > "${s19NeverRan}"` },
          { BSTACK_CACHE_DIR: cacheDir, T3_PATCHER_ENV: s19TimeoutEnv },
        ),
      );
      expect([yield* exists(s19NeverRan), s19Failed]).toEqual([
        false,
        new StepFailed({ reason: `[volume-lost] evaluating $T3_PATCHER_ENV ${s19TimeoutEnv} timed out` }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("defers SIGTERM while SafeLock is held on the main thread without deadlocking under system Python", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temporary;
      const sysPython = (yield* exists("/usr/bin/python3")) ? "/usr/bin/python3" : "python3";
      const harness = [
        "import os, subprocess, sys",
        "sup_code = sys.argv[1]",
        "hook = '''",
        "def _inject_sigterm(frame, event, _arg):",
        '  if event == "line" and frame.f_code.co_name == "record" and frame.f_locals.get("with_env") and frame.f_locals["self"].lock._lk.locked():',
        "    sys.settrace(None)",
        "    os.kill(os.getpid(), 15)",
        "  return _inject_sigterm",
        "sys.settrace(_inject_sigterm)",
        "'''",
        'patched = sup_code.replace("rc = 1\\ntry:", hook + "\\nrc = 1\\ntry:", 1)',
        'p = subprocess.Popen([sys.executable, "-c", patched, sys.argv[3], sys.argv[4], "tok-sig", "true"], cwd=sys.argv[2])',
        "print(p.wait(timeout=3))",
      ].join("\n");
      const out = yield* sh(root, sysPython, [
        "-c",
        harness,
        POSIX_SUPERVISOR,
        root,
        path.join(root, "leaked.txt"),
        path.join(root, "vol.txt"),
      ]);
      expect(out.trim()).toBe("143");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
});

describe("commandResolver", () => {
  const manifest = Effect.gen(function* () {
    return {
      id: yield* Schema.decodeEffect(PatchId)("dark-mode"),
      title: "Dark mode",
      summary: "Adds a dark theme to the settings.",
      version: 1,
      base: { version: "1.0.0", commit: yield* Schema.decodeEffect(Commit)("a".repeat(40)) },
      checks: [],
      journeys: [{ name: "dark", proves: "the theme switches", run: "true" }],
    };
  }).pipe(Effect.orDie);

  it.live("runs the command in the workspace with T3_PATCHER_PROMPT naming the prompt file", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temporary;
      const logs = path.join(root, "logs");
      const resolver = yield* resolverWith('echo "$T3_PATCHER_PROMPT" > seen.txt; pwd -P >> seen.txt', logs);
      yield* resolver.resolve(root, yield* manifest, ["a.txt", "src/b.ts"]);
      const prompt = path.join(logs, "resolve-dark-mode.md");
      expect(yield* read(path.join(root, "seen.txt"))).toBe(`${prompt}\n${root}\n`);
      const lines = (yield* read(prompt)).split("\n");
      expect(lines.filter((line) => line.startsWith("- "))).toEqual([
        "- Name: dark-mode",
        "- Title: Dark mode",
        `- Made for version 1.0.0 (commit ${"a".repeat(40)})`,
        "- a.txt",
        "- src/b.ts",
        "- Resolve each file so that upstream's changes are kept AND the patch's intent is preserved.",
        "- Remove every conflict marker, and delete the `.rej` files once their changes are in.",
        "- Change nothing else.",
        "- Don't commit.",
      ]);
      expect(lines.filter((line) => line === "Adds a dark theme to the settings.")).toEqual(["Adds a dark theme to the settings."]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("fails with the exit code and the end of the output", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temporary;
      const logs = path.join(root, "logs");
      const resolver = yield* resolverWith("echo gave up; exit 2", logs);
      const failed = yield* Effect.flip(resolver.resolve(root, yield* manifest, ["a.txt"]));
      expect(failed).toEqual(
        new StepFailed({ reason: `resolver failed (exit 2; log ${path.join(logs, "resolve-dark-mode.log")}): gave up` }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
});
