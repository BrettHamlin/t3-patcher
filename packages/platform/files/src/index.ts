import {
  Feed,
  InstalledRecord,
  PatchManifest,
  RunReport,
  Settings,
  Stack,
  StepFailed,
  StorageFailed,
  type Patch,
} from "@app/contracts";
import { PatchWriter } from "@app/apply";
import { Library, StackStore } from "@app/stack";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

interface JsonFile<T> {
  readonly decode: (text: string) => Effect.Effect<T, Schema.SchemaError>;
  readonly encode: (value: T) => Effect.Effect<string, Schema.SchemaError>;
}

const jsonFile = <T, E>(schema: Schema.Codec<T, E>): JsonFile<T> => {
  const json = Schema.fromJsonString(schema, { space: 2 });
  const decode = Schema.decodeUnknownEffect(json);
  const encode = Schema.encodeEffect(json);
  return {
    decode: (text) => decode(text),
    encode: (value) => encode(value).pipe(Effect.map((text) => `${text}\n`)),
  };
};

const manifestJson = jsonFile(PatchManifest);
const stackJson = jsonFile(Stack);
const settingsJson = jsonFile(Settings);
const reportJson = jsonFile(RunReport);
const feedJson = jsonFile(Feed);
const installedJson = jsonFile(InstalledRecord);

const io = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = (file: string) =>
    Effect.flatMap(fs.exists(file), (exists) =>
      exists ? Effect.asSome(fs.readFileString(file)) : Effect.succeed(Option.none<string>()),
    );
  const write = Effect.fn("write")(function* (file: string, text: string) {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    yield* fs.writeFileString(temporary, text);
    yield* fs.rename(temporary, file);
  });
  const load = <T>(file: string, codec: JsonFile<T>, what: string) =>
    Effect.gen(function* () {
      const text = yield* read(file);
      return Option.isSome(text) ? Option.some(yield* codec.decode(text.value)) : Option.none<T>();
    }).pipe(Effect.mapError(() => new StorageFailed({ what })));
  const save = <T>(file: string, codec: JsonFile<T>, value: T, what: string) =>
    Effect.flatMap(codec.encode(value), (text) => write(file, text)).pipe(
      Effect.mapError(() => new StorageFailed({ what })),
    );
  return { fs, path, read, write, load, save };
});

/** Every `<folder>/<id>/` with a patch.json and changes.patch, sorted by id. A missing folder has none. */
export const fileLibrary = (folder: string): Layer.Layer<Library, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Library)(
    Effect.gen(function* () {
      const { fs, path, read } = yield* io;
      const patch = (name: string) =>
        Effect.gen(function* () {
          const text = yield* read(path.join(folder, name, "patch.json"));
          if (Option.isNone(text)) return Option.none<Patch>();
          const manifest = yield* manifestJson.decode(text.value);
          if (manifest.id !== name) return yield* new StorageFailed({ what: `patch ${name}` });
          const diff = yield* fs.readFileString(path.join(folder, name, "changes.patch"));
          return Option.some({ manifest, diff });
        }).pipe(Effect.mapError(() => new StorageFailed({ what: `patch ${name}` })));
      return {
        patches: Effect.gen(function* () {
          if (!(yield* fs.exists(folder))) return [];
          const entries = yield* fs.readDirectoryEntries(folder);
          const names = entries
            .filter((entry) => entry.type === "Directory")
            .map((entry) => entry.name)
            .toSorted();
          return (yield* Effect.forEach(names, patch)).flatMap((each) => (Option.isSome(each) ? [each.value] : []));
        }).pipe(Effect.catchTag("PlatformError", () => Effect.fail(new StorageFailed({ what: "the patches folder" })))),
      };
    }),
  );

/** Saves `<folder>/<id>/patch.json` and changes.patch, each through a temporary file and a rename. */
export const filePatchWriter = (folder: string): Layer.Layer<PatchWriter, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(PatchWriter)(
    Effect.gen(function* () {
      const { path, write } = yield* io;
      return {
        write: (patch: Patch) =>
          Effect.gen(function* () {
            const at = path.join(folder, patch.manifest.id);
            yield* write(path.join(at, "patch.json"), yield* manifestJson.encode(patch.manifest));
            yield* write(path.join(at, "changes.patch"), patch.diff);
          }).pipe(
            Effect.mapError(
              (error) => new StepFailed({ reason: `couldn't save patch ${patch.manifest.id}: ${error.message}` }),
            ),
          ),
      };
    }),
  );

/** The stack in `<userdata>/stack.json`; a missing file is an empty stack. */
export const fileStackStore = (userdata: string): Layer.Layer<StackStore, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(StackStore)(
    Effect.gen(function* () {
      const { path, load, save } = yield* io;
      const file = path.join(userdata, "stack.json");
      return {
        load: load(file, stackJson, "the stack").pipe(Effect.map(Option.getOrElse((): Stack => ({ entries: [] })))),
        save: Effect.fn("StackStore.save")(function* (stack: Stack) {
          yield* save(file, stackJson, stack, "the stack");
        }),
      };
    }),
  );

export const loadSettings = (
  userdata: string,
): Effect.Effect<Settings, StorageFailed, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const { path, load } = yield* io;
    const settings = yield* load(path.join(userdata, "settings.json"), settingsJson, "settings");
    return Option.isSome(settings) ? settings.value : yield* new StorageFailed({ what: "settings" });
  });

export const saveSettings = (
  userdata: string,
  settings: Settings,
): Effect.Effect<void, StorageFailed, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const { path, save } = yield* io;
    yield* save(path.join(userdata, "settings.json"), settingsJson, settings, "settings");
  });

export const loadReport = (
  userdata: string,
): Effect.Effect<Option.Option<RunReport>, StorageFailed, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const { path, load } = yield* io;
    return yield* load(path.join(userdata, "last-run.json"), reportJson, "the last run");
  });

export const saveReport = (
  userdata: string,
  report: RunReport,
): Effect.Effect<void, StorageFailed, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const { path, save } = yield* io;
    yield* save(path.join(userdata, "last-run.json"), reportJson, report, "the last run");
  });

/** The feed's text, as `saveFeed` writes it to patches/index.json. */
export const feedText = (feed: Feed): Effect.Effect<string, StorageFailed> =>
  feedJson.encode(feed).pipe(Effect.mapError(() => new StorageFailed({ what: "the feed" })));

/** Write `<folder>/index.json`, the feed of the patches in `folder`; returns its path. */
export const saveFeed = (
  folder: string,
  feed: Feed,
): Effect.Effect<string, StorageFailed, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const { path, save } = yield* io;
    const file = path.join(folder, "index.json");
    yield* save(file, feedJson, feed, "the feed");
    return file;
  });

/** The record of the last install, `<userdata>/installed.json`; none before the first. */
export const loadInstalled = (
  userdata: string,
): Effect.Effect<Option.Option<InstalledRecord>, StorageFailed, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const { path, load } = yield* io;
    return yield* load(path.join(userdata, "installed.json"), installedJson, "the installed record");
  });

export const saveInstalled = (
  userdata: string,
  record: InstalledRecord,
): Effect.Effect<void, StorageFailed, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const { path, save } = yield* io;
    yield* save(path.join(userdata, "installed.json"), installedJson, record, "the installed record");
  });

const desktopArtifact =
  "node scripts/build-desktop-artifact.ts --platform mac --target dir --arch arm64 --build-version {version}";
const splitBuild = `grep -q '"bundles-only"' scripts/build-desktop-artifact.ts`;

export const defaultSettings = (input: { readonly patches: string; readonly work: string }): Settings => ({
  patches: input.patches,
  work: input.work,
  resolver: `claude -p "$(cat "$T3_PATCHER_PROMPT")" --permission-mode acceptEdits`,
  target: {
    name: "T3 Code",
    repository: "https://github.com/pingdotgg/t3code.git",
    tag: "v{version}",
    installed: "/Applications/T3 Code (Beta).app",
    built: "release/mac-arm64/T3 Code (Beta).app",
    // Everything that writes the source tree: compiling aligns the release manifests. The app is packaged from those
    // bundles alongside the checks, when the build script can split (journey-kit); otherwise setup builds it all.
    setup: [
      { name: "install packages", run: `. "$T3_PATCHER_ENV" && pnpm install --frozen-lockfile` },
      // The full Chromium T3's browser tests use (journey-kit), into the build env's browser folder.
      { name: "test browser", run: `. "$T3_PATCHER_ENV" && pnpm --dir apps/web exec playwright install chromium` },
      { name: "env file", run: "test -f .env || cp .env.example .env" },
      {
        name: "bundles",
        run: `. "$T3_PATCHER_ENV" && if ${splitBuild}; then ${desktopArtifact} --bundles-only; else ${desktopArtifact}; fi`,
      },
    ],
    checks: [{ name: "changed files", run: `. "$T3_PATCHER_ENV" && pnpm exec vp run check:changed v{version}` }],
    build: [{ name: "app", run: `. "$T3_PATCHER_ENV" && if ${splitBuild}; then ${desktopArtifact} --skip-build; fi` }],
    env: { T3_PATCHER_ENV: `${input.work}/build-env/env.sh` },
  },
});
