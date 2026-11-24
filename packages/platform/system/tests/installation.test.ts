import { Installation } from "@app/apply";
import { StepFailed } from "@app/contracts";
import { macInstallation } from "@app/system";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { exists, read, temporary, write } from "./support/repo.ts";

/** A stand-in .app: an Info.plist with `version`, a marker file, and a copy of sleep as its executable. */
const fakeApp = (app: string, version: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* write(
      path.join(app, "Contents", "Info.plist"),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "  <key>CFBundleShortVersionString</key>",
        `  <string>${version}</string>`,
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
    );
    yield* write(path.join(app, "Contents", "Resources", "marker"), version);
    yield* fs.makeDirectory(path.join(app, "Contents", "MacOS"), { recursive: true });
    yield* fs.copyFile("/bin/sleep", path.join(app, "Contents", "MacOS", "x"));
  }).pipe(Effect.orDie);

const setup = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = yield* temporary;
  const installed = path.join(root, "Applications", "T3 Code.app");
  const backups = path.join(root, "backups");
  const built = path.join(root, "build", "T3 Code.app");
  yield* fakeApp(installed, "0.1.11");
  yield* fakeApp(built, "0.1.12");
  const installationOf = (app: string) =>
    Installation.useSync((service) => service).pipe(
      Effect.provide(macInstallation({ installed: app, backups }).pipe(Layer.provide(NodeServices.layer))),
    );
  const installation = yield* installationOf(installed);
  const marker = (app: string) => read(path.join(app, "Contents", "Resources", "marker"));
  return { root, installed, backups, built, installation, installationOf, marker, join: (...parts: ReadonlyArray<string>) => path.join(...parts) };
});

describe("macInstallation", () => {
  it.live("reads the installed version, and says when it can't", () =>
    Effect.gen(function* () {
      const { root, installation, installationOf, join } = yield* setup;
      const missing = join(root, "Missing.app");
      expect(yield* installation.version).toBe("0.1.11");
      expect(yield* Effect.flip((yield* installationOf(missing)).version)).toEqual(
        new StepFailed({ reason: `couldn't read the installed version of ${missing}` }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("installs the built app, keeping the previous one as a numbered backup", () =>
    Effect.gen(function* () {
      const { installed, backups, built, installation, marker, join } = yield* setup;
      const first = yield* installation.install(built, "0.1.11");
      yield* fakeApp(built, "0.1.13");
      const second = yield* installation.install(built, "0.1.12");
      yield* write(join(backups, "T3 Code-0.1.13-1.app", "taken"), "");
      yield* fakeApp(built, "0.1.14");
      const third = yield* installation.install(built, "0.1.13");
      expect([first, second, third]).toEqual([
        `installed; the previous app is at ${join(backups, "T3 Code-0.1.11-1.app")}`,
        `installed; the previous app is at ${join(backups, "T3 Code-0.1.12-1.app")}`,
        `installed; the previous app is at ${join(backups, "T3 Code-0.1.13-2.app")}`,
      ]);
      expect([
        yield* installation.version,
        yield* marker(installed),
        yield* marker(join(backups, "T3 Code-0.1.11-1.app")),
        yield* marker(join(backups, "T3 Code-0.1.12-1.app")),
        yield* marker(join(backups, "T3 Code-0.1.13-2.app")),
        yield* exists(built),
      ]).toEqual(["0.1.14", "0.1.14", "0.1.11", "0.1.12", "0.1.13", true]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("fails, changing nothing, when the built app is missing", () =>
    Effect.gen(function* () {
      const { root, installed, backups, installation, marker, join } = yield* setup;
      const missing = join(root, "nowhere.app");
      expect(yield* Effect.flip(installation.install(missing, "0.1.11"))).toEqual(
        new StepFailed({ reason: `no built app at ${missing}` }),
      );
      expect([yield* marker(installed), yield* exists(backups)]).toEqual(["0.1.11", false]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("refuses while the installed app is running", () =>
    Effect.gen(function* () {
      const { installed, built, installation, marker, join } = yield* setup;
      const spawner = yield* ChildProcessSpawner;
      // Killed when the test's scope closes.
      const running = yield* spawner.spawn(ChildProcess.make(join(installed, "Contents", "MacOS", "x"), ["30"], { stdin: "ignore" }));
      expect(yield* running.isRunning).toBe(true);
      expect(yield* Effect.flip(installation.install(built, "0.1.11"))).toEqual(
        new StepFailed({ reason: "quit T3 Code first" }),
      );
      expect(yield* marker(installed)).toBe("0.1.11");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("fails, changing nothing, when the installed version is no longer the one the build was made from", () =>
    Effect.gen(function* () {
      const { installed, backups, built, installation, marker } = yield* setup;
      yield* fakeApp(installed, "0.1.12");
      expect(yield* Effect.flip(installation.install(built, "0.1.11"))).toEqual(
        new StepFailed({ reason: "T3 Code is now 0.1.12, not 0.1.11: apply again" }),
      );
      expect([yield* marker(installed), yield* exists(backups)]).toEqual(["0.1.12", false]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("with relaunch, quits the running app, replaces it and opens the new one", () =>
    Effect.gen(function* () {
      const { root, installed, backups, built, marker, join } = yield* setup;
      const opened = join(root, "opened.txt");
      yield* launchable(installed, "0.1.11", opened);
      yield* launchable(built, "0.1.12", opened);
      const installation = yield* Installation.useSync((service) => service).pipe(
        Effect.provide(macInstallation({ installed, backups, quitTimeout: "10 seconds" }).pipe(Layer.provide(NodeServices.layer))),
      );
      const running = yield* stay(installed);
      const note = yield* installation.install(built, "0.1.11", running.pid);
      expect([
        note,
        yield* running.isRunning,
        yield* waitFor(opened),
        yield* marker(installed),
        yield* marker(join(backups, "T3 Code-0.1.11-1.app")),
      ]).toEqual([
        `installed and reopened; the previous app is at ${join(backups, "T3 Code-0.1.11-1.app")}`,
        false,
        "0.1.12\n",
        "0.1.12",
        "0.1.11",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("with relaunch, fails changing nothing when the app doesn't quit in time", () =>
    Effect.gen(function* () {
      const { root, installed, backups, built, marker, join } = yield* setup;
      const opened = join(root, "opened.txt");
      yield* launchable(installed, "0.1.11", opened);
      const installation = yield* Installation.useSync((service) => service).pipe(
        Effect.provide(macInstallation({ installed, backups, quitTimeout: "1 second" }).pipe(Layer.provide(NodeServices.layer))),
      );
      const stubborn = yield* stay(installed, "ignore");
      expect(yield* Effect.flip(installation.install(built, "0.1.11", stubborn.pid))).toEqual(
        new StepFailed({ reason: "T3 Code didn't quit within 1s" }),
      );
      expect([yield* stubborn.isRunning, yield* marker(installed), yield* exists(backups), yield* exists(opened)]).toEqual([
        true,
        "0.1.11",
        false,
        false,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
});

/**
 * A stand-in app that can be opened: a background-only bundle (no window or Dock icon) whose executable, opened with
 * no arguments, appends its version to `opened`; with `stay`, it runs until it's sent SIGTERM (or, with `ignore`, it
 * ignores SIGTERM and quits by itself after 2 seconds).
 */
const launchable = (app: string, version: string, opened: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* write(
      path.join(app, "Contents", "Info.plist"),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "  <key>CFBundleIdentifier</key>",
        `  <string>dev.t3-patcher.test.${path.basename(path.dirname(path.dirname(app)))}.${version.replaceAll(".", "-")}</string>`,
        "  <key>CFBundleExecutable</key>",
        "  <string>x</string>",
        "  <key>CFBundlePackageType</key>",
        "  <string>APPL</string>",
        "  <key>LSBackgroundOnly</key>",
        "  <true/>",
        "  <key>CFBundleShortVersionString</key>",
        `  <string>${version}</string>`,
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
    );
    yield* write(path.join(app, "Contents", "Resources", "marker"), version);
    const executable = path.join(app, "Contents", "MacOS", "x");
    yield* write(
      executable,
      [
        "#!/bin/sh",
        'if [ "$1" = stay ]; then',
        '  if [ "$2" = ignore ]; then trap "" TERM; sleep 2; exit 0; fi',
        '  trap "exit 0" TERM',
        "  while :; do sleep 0.1; done",
        "fi",
        `echo ${version} >> '${opened}'`,
        "",
      ].join("\n"),
    );
    yield* fs.chmod(executable, 0o755);
  }).pipe(Effect.orDie);

/** The installed stand-in running from its executable until the test's scope closes. */
const stay = (app: string, mode: "quit" | "ignore" = "quit") =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const path = yield* Path.Path;
    const handle = yield* spawner.spawn(
      ChildProcess.make(path.join(app, "Contents", "MacOS", "x"), ["stay", mode], { stdin: "ignore" }),
    );
    // The script's traps are set before its loop's first sleep ends.
    yield* Effect.sleep("300 millis");
    return handle;
  });

/** `file`'s content once it exists, waiting up to 10 seconds; "(never)" if it doesn't appear. */
const waitFor = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (let tries = 0; tries < 100; tries += 1) {
      if (yield* fs.exists(file)) return yield* fs.readFileString(file);
      yield* Effect.sleep("100 millis");
    }
    return "(never)";
  }).pipe(Effect.orDie);
