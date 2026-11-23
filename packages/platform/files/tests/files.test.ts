import { PatchManifest, StepFailed, StorageFailed, type Patch, type RunReport, type Stack } from "@app/contracts";
import { PatchWriter } from "@app/apply";
import {
  defaultSettings,
  fileLibrary,
  filePatchWriter,
  fileStackStore,
  loadReport,
  loadSettings,
  saveReport,
  saveSettings,
} from "@app/files";
import { Library, StackStore } from "@app/stack";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const decodeManifest = Schema.decodeEffect(PatchManifest);

const manifest = (id: string) =>
  decodeManifest({
    id,
    title: `Patch ${id}`,
    summary: `Changes ${id}`,
    base: { version: "0.1.0", commit: "a".repeat(40) },
    checks: [{ name: "types", run: "bun typecheck" }],
    journeys: [{ name: "opens", proves: "it opens", run: "true" }],
  }).pipe(Effect.orDie);

/** A new empty folder, removed after the test, and a way to name files in it. */
const temporary = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  return { fs, at: (...parts: ReadonlyArray<string>) => path.join(root, ...parts) };
});

const patches = (folder: string) =>
  Effect.gen(function* () {
    return yield* (yield* Library).patches;
  }).pipe(Effect.provide(fileLibrary(folder)));

const writePatch = (folder: string, patch: Patch) =>
  Effect.gen(function* () {
    yield* (yield* PatchWriter).write(patch);
  }).pipe(Effect.provide(filePatchWriter(folder)));

describe("patches", () => {
  it.effect("round-trip through the writer and the library, sorted by id, ignoring folders without patch.json", () =>
    Effect.gen(function* () {
      const { fs, at } = yield* temporary;
      const folder = at("patches");
      const b = { manifest: yield* manifest("b"), diff: "diff b\n" };
      const a = { manifest: yield* manifest("a"), diff: "diff a\n" };
      yield* writePatch(folder, b);
      yield* writePatch(folder, a);
      yield* fs.makeDirectory(at("patches", "notes"));
      yield* fs.writeFileString(at("patches", "README"), "not a patch");
      expect(yield* patches(folder)).toEqual([a, b]);
      expect(yield* fs.readFileString(at("patches", "a", "patch.json"))).toEqual(
        `${JSON.stringify(
          {
            id: "a",
            title: "Patch a",
            summary: "Changes a",
            base: { version: "0.1.0", commit: "a".repeat(40) },
            checks: [{ name: "types", run: "bun typecheck" }],
            journeys: [{ name: "opens", proves: "it opens", run: "true" }],
          },
          null,
          2,
        )}\n`,
      );
      expect((yield* fs.readDirectory(at("patches", "a"))).toSorted()).toEqual(["changes.patch", "patch.json"]);
    }).pipe(Effect.provide(NodeServices.layer)));

  it.effect("a missing folder is an empty library", () =>
    Effect.gen(function* () {
      const { at } = yield* temporary;
      expect(yield* patches(at("missing"))).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)));

  it.effect("a malformed patch.json fails naming the patch", () =>
    Effect.gen(function* () {
      const { fs, at } = yield* temporary;
      yield* fs.makeDirectory(at("broken"));
      yield* fs.writeFileString(at("broken", "patch.json"), "{ not json");
      yield* fs.writeFileString(at("broken", "changes.patch"), "");
      expect(yield* Effect.flip(patches(at()))).toEqual(new StorageFailed({ what: "patch broken" }));
    }).pipe(Effect.provide(NodeServices.layer)));

  it.effect("a manifest whose id isn't its folder's name fails naming the folder", () =>
    Effect.gen(function* () {
      const { fs, at } = yield* temporary;
      yield* writePatch(at(), { manifest: yield* manifest("a"), diff: "" });
      yield* fs.makeDirectory(at("other"));
      yield* fs.copyFile(at("a", "patch.json"), at("other", "patch.json"));
      yield* fs.writeFileString(at("other", "changes.patch"), "");
      expect(yield* Effect.flip(patches(at()))).toEqual(new StorageFailed({ what: "patch other" }));
    }).pipe(Effect.provide(NodeServices.layer)));

  it.effect("a failed write says which patch", () =>
    Effect.gen(function* () {
      const { fs, at } = yield* temporary;
      yield* fs.writeFileString(at("blocked"), "a file where the folder goes");
      const failed = yield* Effect.flip(writePatch(at("blocked"), { manifest: yield* manifest("a"), diff: "" }));
      expect(failed).toEqual(
        new StepFailed({
          reason: `couldn't save patch a: BadResource: FileSystem.makeDirectory (${at("blocked", "a")})`,
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)));
});

describe("stack", () => {
  it.effect("round-trips, creating the folder; a missing file is empty; malformed fails", () =>
    Effect.gen(function* () {
      const { fs, at } = yield* temporary;
      const stack: Stack = { entries: [{ id: (yield* manifest("a")).id, enabled: false }] };
      const store = yield* StackStore.pipe(Effect.provide(fileStackStore(at("user"))));
      const missing = yield* store.load;
      yield* store.save(stack);
      const loaded = yield* store.load;
      yield* fs.writeFileString(at("user", "stack.json"), '{"entries":[{"id":"Not Valid","enabled":true}]}');
      const malformed = yield* Effect.flip(store.load);
      expect([missing, loaded, malformed]).toEqual([{ entries: [] }, stack, new StorageFailed({ what: "the stack" })]);
    }).pipe(Effect.provide(NodeServices.layer)));
});

describe("settings", () => {
  it.effect("round-trip; missing or malformed fails", () =>
    Effect.gen(function* () {
      const { fs, at } = yield* temporary;
      const settings = defaultSettings({ patches: "/patches", work: "/work" });
      const missing = yield* Effect.flip(loadSettings(at("user")));
      yield* saveSettings(at("user"), settings);
      const loaded = yield* loadSettings(at("user"));
      yield* fs.writeFileString(at("user", "settings.json"), "{}");
      const malformed = yield* Effect.flip(loadSettings(at("user")));
      expect([missing, loaded, malformed]).toEqual([
        new StorageFailed({ what: "settings" }),
        settings,
        new StorageFailed({ what: "settings" }),
      ]);
    }).pipe(Effect.provide(NodeServices.layer)));

  it.effect("default to T3 Code", () =>
    Effect.sync(() => {
      expect(defaultSettings({ patches: "/p", work: "/w" })).toEqual({
        patches: "/p",
        work: "/w",
        resolver: `claude -p "$(cat "$T3_PATCHER_PROMPT")" --permission-mode acceptEdits`,
        target: {
          name: "T3 Code",
          repository: "https://github.com/pingdotgg/t3code.git",
          tag: "v{version}",
          installed: "/Applications/T3 Code (Beta).app",
          built: "release/mac-arm64/T3 Code (Beta).app",
          checks: [],
          build: [],
          env: {},
        },
      });
    }));
});

describe("report", () => {
  it.effect("round-trips; missing is none; malformed fails", () =>
    Effect.gen(function* () {
      const { fs, at } = yield* temporary;
      const report: RunReport = {
        version: "0.1.11",
        install: true,
        steps: [{ kind: "source", name: "v0.1.11", status: "passed", note: "" }],
      };
      const missing = yield* loadReport(at("user"));
      yield* saveReport(at("user"), report);
      const loaded = yield* loadReport(at("user"));
      yield* fs.writeFileString(at("user", "last-run.json"), '{"version":"x"}');
      const malformed = yield* Effect.flip(loadReport(at("user")));
      expect([missing, loaded, malformed]).toEqual([
        Option.none(),
        Option.some(report),
        new StorageFailed({ what: "the last run" }),
      ]);
    }).pipe(Effect.provide(NodeServices.layer)));
});
