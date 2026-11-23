import type { RunReport, Step } from "@app/contracts";
import { run } from "@app/apply";
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
        "install /work/stack/release/T3 Code.app",
      ]);
      expect(yield* Ref.get(fake.written)).toEqual([]);
      expect(yield* Ref.get(fake.installed)).toEqual(["/work/stack/release/T3 Code.app"]);
    }));

  it.effect("passes the version, source, app and evidence folders to commands", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const patches = yield* twoPatches();
      yield* run(target(), patches, false, folders).pipe(Effect.provide(fake.layer));
      const env = { CI: "1", T3_PATCHER_VERSION: "0.1.11", T3_PATCHER_SOURCE: "/work/stack" };
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
});
