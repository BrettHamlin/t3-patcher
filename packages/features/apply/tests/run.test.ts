import type { Patch, RunReport, Step } from "@app/contracts";
import { installedRecord, run, updates } from "@app/apply";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { commit, fakes, patch, resolvedDiff, target } from "./support/fakes.ts";

const folders = { evidence: "/evidence" } as const;

const codes = {
  pending: "-",
  running: "r",
  passed: "P",
  failed: "F",
  skipped: "s",
} as const satisfies Record<Step["status"], string>;

/** Each report Progress saw, as `<version>|<one letter per step status>`. */
const seen = (reports: ReadonlyArray<RunReport>): ReadonlyArray<string> =>
  reports.map((report) => `${report.version}|${report.steps.map((step) => codes[step.status]).join("")}`);

/** What Progress sees when all `count` steps pass. */
const allPassing = (count: number): ReadonlyArray<string> => [
  `|${"-".repeat(count)}`,
  ...Array.from({ length: count }, (_, index) => [
    `${index === 0 ? "" : "0.1.11"}|${"P".repeat(index)}r${"-".repeat(count - index - 1)}`,
    `0.1.11|${"P".repeat(index + 1)}${"-".repeat(count - index - 1)}`,
  ]).flat(),
];

const twoPatches = Effect.fn("twoPatches")(function* () {
  const baseCommit = yield* commit("b");
  const a = yield* patch("a", { baseCommit, checks: [{ name: "unit", run: "bun test a" }] });
  const b = yield* patch("b", { baseCommit });
  return [a, b];
});

describe("run", () => {
  it.effect("applies, checks, builds, proves and installs when everything passes", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const patches = yield* twoPatches();
      const report = yield* run(target(), patches, true, folders).pipe(Effect.provide(fake.layer));
      expect(report).toEqual({
        version: "0.1.11",
        install: true,
        steps: [
          { kind: "source", name: "T3 Code source", status: "passed", note: "0.1.11 (v0.1.11)" },
          { kind: "patch", name: "a", status: "passed", note: "applied" },
          { kind: "patch", name: "b", status: "passed", note: "applied" },
          { kind: "check", name: "typecheck", status: "passed", note: "" },
          { kind: "check", name: "a: unit", status: "passed", note: "" },
          { kind: "build", name: "build", status: "passed", note: "" },
          { kind: "journey", name: "a: a-journey", status: "passed", note: "" },
          { kind: "journey", name: "b: b-journey", status: "passed", note: "" },
          { kind: "save", name: "save patches", status: "passed", note: "nothing to save" },
          { kind: "install", name: "install", status: "passed", note: "installed /work/stack/release/T3 Code.app" },
        ],
      });
      const reports = yield* Ref.get(fake.reports);
      expect(seen(reports)).toEqual(allPassing(10));
      expect(reports.at(-1)).toEqual(report);
      expect(yield* Ref.get(fake.events)).toEqual([
        "open v0.1.11 in stack",
        "apply diff:a in /work/stack",
        "commit a: Title a in /work/stack",
        "apply diff:b in /work/stack",
        "commit b: Title b in /work/stack",
        "run typecheck",
        "run unit",
        "run build",
        "run a-journey",
        "run b-journey",
        "install /work/stack/release/T3 Code.app (0.1.11)",
      ]);
      expect(yield* Ref.get(fake.written)).toEqual([]);
      expect(yield* Ref.get(fake.installed)).toEqual(["/work/stack/release/T3 Code.app"]);
    }));

  it.effect("passes the version, source, patches, app and evidence folders to commands", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const patches = yield* twoPatches();
      yield* run(target(), patches, false, folders).pipe(Effect.provide(fake.layer));
      const env = {
        CI: "1",
        T3_PATCHER_VERSION: "0.1.11",
        T3_PATCHER_SOURCE: "/work/stack",
        T3_PATCHER_PATCHES: JSON.stringify([
          { id: "a", title: "Title a", summary: "Summary a", version: 1 },
          { id: "b", title: "Title b", summary: "Summary b", version: 1 },
        ]),
      };
      const journeyEnv = (id: string) => ({
        ...env,
        T3_PATCHER_APP: "/work/stack/release/T3 Code.app",
        T3_PATCHER_EVIDENCE: `/evidence/${id}/${id}-journey`,
      });
      expect(yield* Ref.get(fake.shellCalls)).toEqual([
        { folder: "/work/stack", command: { name: "typecheck", run: "bun typecheck --tag 0.1.11" }, env },
        { folder: "/work/stack", command: { name: "unit", run: "bun test a" }, env },
        { folder: "/work/stack", command: { name: "build", run: "bun build 0.1.11" }, env },
        { folder: "/work/stack", command: { name: "a-journey", run: "run a-journey" }, env: journeyEnv("a") },
        { folder: "/work/stack", command: { name: "b-journey", run: "run b-journey" }, env: journeyEnv("b") },
      ]);
    }));

  it.effect("without install, has no install step and installs nothing", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const patches = yield* twoPatches();
      const report = yield* run(target({ checks: [] }), patches.slice(1), false, folders).pipe(
        Effect.provide(fake.layer),
      );
      expect(report).toEqual({
        version: "0.1.11",
        install: false,
        steps: [
          { kind: "source", name: "T3 Code source", status: "passed", note: "0.1.11 (v0.1.11)" },
          { kind: "patch", name: "b", status: "passed", note: "applied" },
          { kind: "build", name: "build", status: "passed", note: "" },
          { kind: "journey", name: "b: b-journey", status: "passed", note: "" },
          { kind: "save", name: "save patches", status: "passed", note: "nothing to save" },
        ],
      });
      expect(yield* Ref.get(fake.installed)).toEqual([]);
    }));

  it.effect("stops at a conflict the resolver can't clear: later steps skipped, nothing saved or installed", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({
        conflicts: new Map([["diff:b", { files: ["src/x.ts", "src/y.ts"], resolves: false }]]),
      });
      const patches = yield* twoPatches();
      const report = yield* run(target(), patches, true, folders).pipe(Effect.provide(fake.layer));
      expect(report).toEqual({
        version: "0.1.11",
        install: true,
        steps: [
          { kind: "source", name: "T3 Code source", status: "passed", note: "0.1.11 (v0.1.11)" },
          { kind: "patch", name: "a", status: "passed", note: "applied" },
          { kind: "patch", name: "b", status: "failed", note: "conflicts left in src/x.ts, src/y.ts" },
          { kind: "check", name: "typecheck", status: "skipped", note: "" },
          { kind: "check", name: "a: unit", status: "skipped", note: "" },
          { kind: "build", name: "build", status: "skipped", note: "" },
          { kind: "journey", name: "a: a-journey", status: "skipped", note: "" },
          { kind: "journey", name: "b: b-journey", status: "skipped", note: "" },
          { kind: "save", name: "save patches", status: "skipped", note: "" },
          { kind: "install", name: "install", status: "skipped", note: "" },
        ],
      });
      expect(seen(yield* Ref.get(fake.reports))).toEqual([
        "|----------",
        "|r---------",
        "0.1.11|P---------",
        "0.1.11|Pr--------",
        "0.1.11|PP--------",
        "0.1.11|PPr-------",
        "0.1.11|PPFsssssss",
      ]);
      expect(yield* Ref.get(fake.events)).toEqual([
        "open v0.1.11 in stack",
        "apply diff:a in /work/stack",
        "commit a: Title a in /work/stack",
        "apply diff:b in /work/stack",
        "resolve b (src/x.ts, src/y.ts) in /work/stack",
      ]);
      expect(yield* Ref.get(fake.written)).toEqual([]);
      expect(yield* Ref.get(fake.installed)).toEqual([]);
    }));

  it.effect("saves a patch whose conflicts were resolved, or whose base moved, onto this version", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({ conflicts: new Map([["diff:a", { files: ["src/x.ts"], resolves: true }]]) });
      const baseCommit = yield* commit("b");
      const a = yield* patch("a", { baseCommit });
      const b = yield* patch("b", { baseCommit: yield* commit("c") });
      const c = yield* patch("c", { baseCommit });
      const report = yield* run(target({ checks: [], build: [] }), [a, b, c], false, folders).pipe(
        Effect.provide(fake.layer),
      );
      expect(report).toEqual({
        version: "0.1.11",
        install: false,
        steps: [
          { kind: "source", name: "T3 Code source", status: "passed", note: "0.1.11 (v0.1.11)" },
          {
            kind: "patch",
            name: "a",
            status: "passed",
            note: "resolved conflicts in src/x.ts; to be saved for 0.1.11",
          },
          { kind: "patch", name: "b", status: "passed", note: "applied; to be saved for 0.1.11" },
          { kind: "patch", name: "c", status: "passed", note: "applied" },
          { kind: "journey", name: "a: a-journey", status: "passed", note: "" },
          { kind: "journey", name: "b: b-journey", status: "passed", note: "" },
          { kind: "journey", name: "c: c-journey", status: "passed", note: "" },
          { kind: "save", name: "save patches", status: "passed", note: "saved a, b" },
        ],
      });
      const rebased = { version: "0.1.11", commit: baseCommit };
      expect(yield* Ref.get(fake.written)).toEqual([
        { manifest: { ...a.manifest, base: rebased }, diff: resolvedDiff("diff:a") },
        { manifest: { ...b.manifest, base: rebased }, diff: "diff:b" },
      ]);
    }));

  it.effect("installs only over the version the build was made from", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({ installedLater: "0.1.12" });
      const patches = yield* twoPatches();
      const report = yield* run(target(), patches, true, folders).pipe(Effect.provide(fake.layer));
      expect(report.steps.map((step) => `${step.name}: ${step.status} ${step.note}`)).toEqual([
        "T3 Code source: passed 0.1.11 (v0.1.11)",
        "a: passed applied",
        "b: passed applied",
        "typecheck: passed ",
        "a: unit: passed ",
        "build: passed ",
        "a: a-journey: passed ",
        "b: b-journey: passed ",
        "save patches: passed nothing to save",
        "install: failed T3 Code is now 0.1.12, not 0.1.11: run again",
      ]);
      expect(yield* Ref.get(fake.installed)).toEqual([]);
    }));

  it.effect("a failing check stops the run before the build", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({ failing: new Set(["unit"]) });
      const patches = yield* twoPatches();
      const report = yield* run(target(), patches, true, folders).pipe(Effect.provide(fake.layer));
      expect(report.steps.map((step) => `${step.name}: ${step.status} ${step.note}`)).toEqual([
        "T3 Code source: passed 0.1.11 (v0.1.11)",
        "a: passed applied",
        "b: passed applied",
        "typecheck: passed ",
        "a: unit: failed unit exited 1",
        "build: skipped ",
        "a: a-journey: skipped ",
        "b: b-journey: skipped ",
        "save patches: skipped ",
        "install: skipped ",
      ]);
      expect(yield* Ref.get(fake.installed)).toEqual([]);
    }));

  it.effect("a failing journey saves nothing and installs nothing", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({
        failing: new Set(["b-journey"]),
        conflicts: new Map([["diff:a", { files: ["src/x.ts"], resolves: true }]]),
      });
      const patches = yield* twoPatches();
      const report = yield* run(target(), patches, true, folders).pipe(Effect.provide(fake.layer));
      expect(report.steps.map((step) => `${step.name}: ${step.status} ${step.note}`)).toEqual([
        "T3 Code source: passed 0.1.11 (v0.1.11)",
        "a: passed resolved conflicts in src/x.ts; to be saved for 0.1.11",
        "b: passed applied",
        "typecheck: passed ",
        "a: unit: passed ",
        "build: passed ",
        "a: a-journey: passed ",
        "b: b-journey: failed b-journey exited 1",
        "save patches: skipped ",
        "install: skipped ",
      ]);
      expect(yield* Ref.get(fake.written)).toEqual([]);
      expect(yield* Ref.get(fake.installed)).toEqual([]);
    }));

  it.effect("an update builds the wanted version's tag, says what it updates, and installs over the installed version, relaunching the app", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const patches = yield* twoPatches();
      const updating = [
        { name: "T3 Code", from: "0.1.11", to: "0.1.12" },
        { name: "a", from: "1", to: "2" },
      ];
      const report = yield* run(target({ checks: [] }), patches.slice(1), true, folders, {
        version: "0.1.12",
        relaunch: 4242,
        updating,
      }).pipe(Effect.provide(fake.layer));
      expect(report).toEqual({
        version: "0.1.12",
        install: true,
        updating,
        steps: [
          { kind: "source", name: "T3 Code source", status: "passed", note: "0.1.12 (v0.1.12)" },
          { kind: "patch", name: "b", status: "passed", note: "applied" },
          { kind: "build", name: "build", status: "passed", note: "" },
          { kind: "journey", name: "b: b-journey", status: "passed", note: "" },
          { kind: "save", name: "save patches", status: "passed", note: "nothing to save" },
          { kind: "install", name: "install", status: "passed", note: "installed /work/stack/release/T3 Code.app" },
        ],
      });
      expect((yield* Ref.get(fake.reports)).map((each) => each.updating)).toEqual(Array.from({ length: 13 }, () => updating));
      expect(yield* Ref.get(fake.events)).toEqual([
        "open v0.1.12 in stack",
        "apply diff:b in /work/stack",
        "commit b: Title b in /work/stack",
        "run build",
        "run b-journey",
        "install /work/stack/release/T3 Code.app (0.1.11) relaunching 4242",
      ]);
      expect((yield* Ref.get(fake.shellCalls)).map((call) => [call.command.run, call.env["T3_PATCHER_VERSION"]])).toEqual([
        ["bun build 0.1.12", "0.1.12"],
        ["run b-journey", "0.1.12"],
      ]);
    }));

  it.effect("with saving off, has no save step: the patch step says it was rebased, and nothing is written", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const baseCommit = yield* commit("b");
      const moved = yield* patch("a", { baseCommit: yield* commit("c") });
      const same = yield* patch("b", { baseCommit });
      const report = yield* run(target({ checks: [], build: [] }), [moved, same], false, folders, {
        version: "0.1.12",
        save: false,
      }).pipe(Effect.provide(fake.layer));
      expect(report.steps.map((step) => `${step.name}: ${step.status} ${step.note}`)).toEqual([
        "T3 Code source: passed 0.1.12 (v0.1.12)",
        "a: passed applied; rebased for 0.1.12",
        "b: passed applied",
        "a: a-journey: passed ",
        "b: b-journey: passed ",
      ]);
      expect(yield* Ref.get(fake.written)).toEqual([]);
    }));

  it.effect("an update whose build fails never reaches the install step, so the app isn't quit or replaced", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({ failing: new Set(["build"]) });
      const patches = yield* twoPatches();
      const report = yield* run(target({ checks: [] }), patches.slice(1), true, folders, {
        version: "0.1.12",
        relaunch: 4242,
        updating: [{ name: "T3 Code", from: "0.1.11", to: "0.1.12" }],
      }).pipe(Effect.provide(fake.layer));
      expect(report.steps.map((step) => `${step.name}: ${step.status} ${step.note}`)).toEqual([
        "T3 Code source: passed 0.1.12 (v0.1.12)",
        "b: passed applied",
        "build: failed build exited 1",
        "b: b-journey: skipped ",
        "save patches: skipped ",
        "install: skipped ",
      ]);
      expect(yield* Ref.get(fake.events)).toEqual([
        "open v0.1.12 in stack",
        "apply diff:b in /work/stack",
        "commit b: Title b in /work/stack",
        "run build",
      ]);
      expect(yield* Ref.get(fake.installed)).toEqual([]);
    }));
});

const update = {
  command: ["/usr/bin/python3", "/repo/scripts/patcher.py", "update"],
  cwd: "/repo",
  path: "/opt/homebrew/bin:/usr/bin:/bin",
} as const;

describe("installedRecord", () => {
  it.effect("records the version and each patch installed, with how to update it when there's a command", () =>
    Effect.gen(function* () {
      const baseCommit = yield* commit("b");
      const patches = [yield* patch("a", { baseCommit, version: 3 }), yield* patch("b", { baseCommit })];
      const installed = [
        { id: "a", title: "Title a", summary: "Summary a", version: 3 },
        { id: "b", title: "Title b", summary: "Summary b", version: 1 },
      ];
      expect([
        installedRecord("0.1.12", patches, "2026-11-24T10:00:00.000Z", "https://feed", update),
        installedRecord("0.1.12", patches, "2026-11-24T10:00:00.000Z", "https://feed", undefined),
      ]).toEqual([
        { t3Version: "0.1.12", patches: installed, installedAt: "2026-11-24T10:00:00.000Z", feed: "https://feed", update },
        { t3Version: "0.1.12", patches: installed, installedAt: "2026-11-24T10:00:00.000Z", feed: "https://feed" },
      ]);
    }));

  it.effect("is written by the install step right after the app is replaced, only when it installs", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const patches = yield* twoPatches();
      const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (version: string, installed: ReadonlyArray<Patch>) =>
        Ref.update(recorded, (all) => [...all, `${version}: ${installed.map((each) => each.manifest.id).join(", ")}`]);
      yield* run(target(), patches, false, folders, { record }).pipe(Effect.provide(fake.layer));
      yield* run(target(), patches, true, folders, { record, version: "0.1.12" }).pipe(
        Effect.provide((yield* fakes({ failing: new Set(["unit"]) })).layer),
      );
      yield* run(target(), patches, true, folders, { record, version: "0.1.12" }).pipe(Effect.provide(fake.layer));
      expect(yield* Ref.get(recorded)).toEqual(["0.1.12: a, b"]);
    }));
});

describe("updates", () => {
  it.effect("lists the app when its version changes, each patch that is on whose version isn't the one installed or that is added, then installed patches left out", () =>
    Effect.gen(function* () {
      const baseCommit = yield* commit("b");
      const [a, b, c] = [
        yield* patch("a", { baseCommit, version: 2 }),
        yield* patch("b", { baseCommit, version: 5 }),
        yield* patch("c", { baseCommit, version: 1 }),
      ];
      const installed = {
        t3Version: "0.1.11",
        patches: [
          { id: a.manifest.id, version: 1 },
          { id: b.manifest.id, version: 5 },
        ],
        installedAt: "then",
        feed: "https://feed",
        update,
      };
      const before = [{ ...a.manifest, version: 2 }, { ...b.manifest, version: 4 }, c.manifest];
      expect([
        updates({ app: "T3 Code", t3: { from: "0.1.11", to: "0.1.12" }, installed, before, patches: [a, b, c] }),
        updates({ app: "T3 Code", t3: { from: "0.1.11", to: "0.1.11" }, installed: undefined, before, patches: [a, b, c] }),
        updates({ app: "T3 Code", t3: { from: "0.1.11", to: "0.1.11" }, installed, before, patches: [a, c] }),
      ]).toEqual([
        [
          { name: "T3 Code", from: "0.1.11", to: "0.1.12" },
          { name: "a", from: "1", to: "2" },
          { name: "c", from: "", to: "1" },
        ],
        [{ name: "b", from: "4", to: "5" }],
        [
          { name: "a", from: "1", to: "2" },
          { name: "c", from: "", to: "1" },
          { name: "b", from: "5", to: "removed" },
        ],
      ]);
    }));
});
