// Test setup: a whole fake world in a journey's data folder, which is also the app's user data folder. Only a
// devDependency (arch gate), so the shipped app can't use it.
//
// <data>/upstream       a git repository with tags v1.0.0 and v1.1.0: Contents/Info.plist and Contents/Resources/app.txt
// <data>/Installed.app  the "installed" app: that tree at the chosen version
// <data>/patches/<id>/  patches made with git against v1.0.0
// <data>/work/          the work folder (source checkouts, logs, backups)
// <data>/settings.json  written with the files package, as `python3 scripts/patcher.py init` would
import { Commit, type Patch, PatchManifest, type Settings, StorageFailed } from "@app/contracts";
import { saveSettings } from "@app/files";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** The fixture app's versions: each is a tag in the upstream repository. */
export type FixtureVersion = "1.0.0" | "1.1.0";

/**
 * The fixture patches, all made against v1.0.0:
 * - `notes-one` adds Contents/Resources/notes.txt ("one")
 * - `notes-two` adds "two" to that file, so it applies only after notes-one
 * - `red-color` changes app.txt's `color: blue` to `color: red`; v1.1.0 changed that line too, so it conflicts there
 */
export type FixturePatch = "notes-one" | "notes-two" | "red-color";

/** How conflicts are resolved: `fixing` writes the intended app.txt; `stubborn` does nothing. */
export type FixtureResolver = "fixing" | "stubborn";

export interface World {
  readonly installed: FixtureVersion;
  readonly patches: ReadonlyArray<FixturePatch>;
  readonly resolver: FixtureResolver;
}

const APP_TXT = {
  "1.0.0": "title: Hello\ncolor: blue\n",
  "1.1.0": "title: Hello\ncolor: green\nsize: large\n",
} as const satisfies Readonly<Record<FixtureVersion, string>>;
/** app.txt once `red-color` is resolved over v1.1.0: the patch's color, and v1.1.0's new line. */
const RESOLVED = "title: Hello\ncolor: red\nsize: large\n";

const plist = (version: string): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>CFBundleName</key>",
    "  <string>Fixture</string>",
    "  <key>CFBundleShortVersionString</key>",
    `  <string>${version}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

interface FixturePatchSpec {
  readonly title: string;
  readonly summary: string;
  /** Patches applied (and committed) before this one is made. */
  readonly after: ReadonlyArray<FixturePatch>;
  /** Files written, relative to the source folder, with their whole new content. */
  readonly writes: Readonly<Record<string, string>>;
  readonly check: string;
  readonly journey: string;
}

const PATCHES = {
  "notes-one": {
    title: "Add notes",
    summary: "Adds a notes file.",
    after: [],
    writes: { "Contents/Resources/notes.txt": "one\n" },
    check: "test -f Contents/Resources/notes.txt",
    journey: "grep -qx one out/App.app/Contents/Resources/notes.txt",
  },
  "notes-two": {
    title: "Second note",
    summary: "Adds a second line to the notes.",
    after: ["notes-one"],
    writes: { "Contents/Resources/notes.txt": "one\ntwo\n" },
    check: "grep -qx two Contents/Resources/notes.txt",
    journey: "grep -qx two out/App.app/Contents/Resources/notes.txt",
  },
  "red-color": {
    title: "Red color",
    summary: "Makes the app red.",
    after: [],
    writes: { "Contents/Resources/app.txt": "title: Hello\ncolor: red\n" },
    check: "grep -qx 'color: red' Contents/Resources/app.txt",
    journey: "grep -qx 'color: red' out/App.app/Contents/Resources/app.txt",
  },
} as const satisfies Readonly<Record<FixturePatch, FixturePatchSpec>>;

class GitFailed extends Schema.TaggedError<GitFailed>()("GitFailed", { command: Schema.String, output: Schema.String }) {
  override get message(): string {
    return `git ${this.command} failed: ${this.output}`;
  }
}

const IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false"] as const;

/** Run git in `cwd`; its output, or GitFailed. */
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(ChildProcess.make("git", [...IDENTITY, ...args], { cwd }));
      const [output, errors, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (code !== 0) return yield* new GitFailed({ command: args.join(" "), output: errors });
      return output;
    }),
  );

const writeAll = Effect.fn("writeAll")(function* (folder: string, files: Readonly<Record<string, string>>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [name, text] of Object.entries(files)) {
    yield* fs.makeDirectory(path.dirname(path.join(folder, name)), { recursive: true });
    yield* fs.writeFileString(path.join(folder, name), text);
  }
});

/** The tree of the fixture app at `version`. */
const tree = (version: FixtureVersion): Readonly<Record<string, string>> => ({
  "Contents/Info.plist": plist(version),
  "Contents/Resources/app.txt": APP_TXT[version],
});

const makeUpstream = Effect.fn("makeUpstream")(function* (folder: string) {
  yield* (yield* FileSystem.FileSystem).makeDirectory(folder, { recursive: true });
  yield* git(folder, ["init", "--quiet", "--initial-branch=main"]);
  yield* writeAll(folder, { ".gitignore": "out/\n" });
  for (const version of ["1.0.0", "1.1.0"] as const) {
    yield* writeAll(folder, tree(version));
    yield* git(folder, ["add", "--all"]);
    yield* git(folder, ["commit", "--quiet", "-m", `Release ${version}`]);
    yield* git(folder, ["tag", `v${version}`]);
  }
});

const makePatch = Effect.fn("makePatch")(function* (upstream: string, scratch: string, id: FixturePatch) {
  const fs = yield* FileSystem.FileSystem;
  const spec = PATCHES[id];
  yield* fs.remove(scratch, { recursive: true, force: true });
  yield* git(upstream, ["clone", "--quiet", upstream, scratch]);
  yield* git(scratch, ["checkout", "--quiet", "v1.0.0"]);
  const commit = (yield* git(scratch, ["rev-parse", "HEAD"])).trim();
  for (const before of spec.after) {
    yield* writeAll(scratch, PATCHES[before].writes);
    yield* git(scratch, ["add", "--all"]);
    yield* git(scratch, ["commit", "--quiet", "-m", before]);
  }
  yield* writeAll(scratch, spec.writes);
  yield* git(scratch, ["add", "--all"]);
  const diff = yield* git(scratch, ["diff", "--cached", "--binary", "--full-index"]);
  const manifest: PatchManifest = {
    id: yield* Schema.decodeEffect(PatchManifest.fields.id)(id),
    title: spec.title,
    summary: spec.summary,
    base: { version: "1.0.0", commit: yield* Schema.decodeEffect(Commit)(commit) },
    checks: [{ name: "check", run: spec.check }],
    journeys: [{ name: "built", proves: `the built app has ${id}`, run: spec.journey }],
  };
  const patch: Patch = { manifest, diff };
  return patch;
});

const writePatch = Effect.fn("writePatch")(function* (folder: string, patch: Patch) {
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(PatchManifest))(patch.manifest);
  yield* writeAll(folder, {
    [`${patch.manifest.id}/patch.json`]: `${encoded}\n`,
    [`${patch.manifest.id}/changes.patch`]: patch.diff,
  });
});

const RESOLVERS = {
  fixing: `#!/bin/sh\nprintf '${RESOLVED.replaceAll("\n", "\\n")}' > Contents/Resources/app.txt\n`,
  stubborn: "#!/bin/sh\nexit 0\n",
} as const satisfies Readonly<Record<FixtureResolver, string>>;

const build = Effect.fn("build")(function* (data: string, world: World) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const upstream = path.join(data, "upstream");
  const patches = path.join(data, "patches");
  yield* makeUpstream(upstream);
  yield* writeAll(path.join(data, "Installed.app"), tree(world.installed));
  for (const id of world.patches) {
    yield* writePatch(patches, yield* makePatch(upstream, path.join(data, "scratch"), id));
  }
  yield* fs.remove(path.join(data, "scratch"), { recursive: true, force: true });
  const resolver = path.join(data, "resolve.sh");
  yield* fs.writeFileString(resolver, RESOLVERS[world.resolver]);
  yield* fs.chmod(resolver, 0o755);
  const settings: Settings = {
    patches,
    work: path.join(data, "work"),
    resolver: `'${resolver}'`,
    target: {
      name: "Fixture",
      repository: upstream,
      tag: "v{version}",
      installed: path.join(data, "Installed.app"),
      built: "out/App.app",
      checks: [{ name: "plist", run: "test -f Contents/Info.plist" }],
      build: [{ name: "copy", run: "rm -rf out && mkdir -p out/App.app && cp -R Contents out/App.app/" }],
      env: {},
    },
  };
  yield* saveSettings(data, settings);
});

const node = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

/** Build the fake world in `data` (the journey's data folder) before the app starts. */
export const patcherWorld = (data: string, world: World): Promise<void> => node(build(data, world));

/** A file inside the installed app, e.g. "Contents/Resources/notes.txt"; "(missing)" if it isn't there. */
export const installedFile = (data: string, file: string): Promise<string> =>
  node(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const at = (yield* Path.Path).join(data, "Installed.app", file);
      return (yield* fs.exists(at)) ? yield* fs.readFileString(at) : "(missing)";
    }),
  );

/** The base version saved in patch `id`'s patch.json. */
export const savedBase = (data: string, id: FixturePatch): Promise<string> =>
  node(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString((yield* Path.Path).join(data, "patches", id, "patch.json"));
      const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(PatchManifest))(text).pipe(
        Effect.mapError(() => new StorageFailed({ what: `patch ${id}` })),
      );
      return manifest.base.version;
    }),
  );

/** Write `text` to `file` inside a patch workspace folder (as the app showed it), the way an author would edit it. */
export const editInWorkspace = (folder: string, file: string, text: string): Promise<void> =>
  node(writeAll(folder, { [file]: text }));

/** A file in a patch workspace folder (as the app showed it); "(missing)" if it isn't there. */
export const workspaceFile = (folder: string, file: string): Promise<string> =>
  node(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const at = (yield* Path.Path).join(folder, file);
      return (yield* fs.exists(at)) ? yield* fs.readFileString(at) : "(missing)";
    }),
  );
