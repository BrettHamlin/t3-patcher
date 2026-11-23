// Random stacks with random outcomes for every step, checked against a model of the spec. Seeded, so a failure
// prints a seed and the stack that reproduces it; no library.
import type { Command, Patch, StepKind } from "@app/contracts";
import { run } from "@app/apply";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { type Conflict, commit, fakes, patch, target } from "./support/fakes.ts";

const generator = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

interface Planned {
  readonly kind: StepKind;
  readonly name: string;
  readonly broken: boolean;
}

it.effect("matches the model over 300 random stacks", () =>
  Effect.gen(function* () {
    const current = yield* commit("b");
    const stale = yield* commit("c");
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = generator(seed);
      const count = (most: number) => Math.floor(random() * (most + 1));
      const failing = new Set<string>();
      const rollFailure = (name: string) => {
        const failed = random() < 0.08;
        if (failed) failing.add(name);
        return failed;
      };
      const story: Array<string> = [];

      const conflicts = new Map<string, Conflict>();
      const patches: Array<Patch> = [];
      const patchSteps: Array<Planned> = [];
      const needsSave: Array<string> = [];
      const patchCount = 1 + count(2);
      for (let index = 0; index < patchCount; index += 1) {
        const id = `p${index}`;
        const roll = random();
        const outcome = roll < 0.6 ? "clean" : roll < 0.85 ? "resolved" : "left";
        const moved = random() < 0.3;
        const checks: Array<Command> = Array.from({ length: count(1) }, (_, k) => ({ name: `${id}-check${k}`, run: "x" }));
        const journeys = Array.from({ length: 1 + count(1) }, (_, k) => ({ name: `${id}-j${k}`, proves: "x", run: "x" }));
        const made = yield* patch(id, { baseCommit: moved ? stale : current, checks, journeys });
        patches.push(made);
        if (outcome !== "clean") conflicts.set(made.diff, { files: ["f.ts"], resolves: outcome === "resolved" });
        patchSteps.push({ kind: "patch", name: id, broken: outcome === "left" });
        if (outcome === "resolved" || moved) needsSave.push(id);
        story.push(`${id} ${outcome}${moved ? " moved" : ""}`);
      }
      const targetChecks = Array.from({ length: count(2) }, (_, k) => ({ name: `t-check${k}`, run: "x" }));
      const build = Array.from({ length: 1 + count(1) }, (_, k) => ({ name: `t-build${k}`, run: "x" }));
      const install = random() < 0.5;
      const installFails = random() < 0.25;

      const plan: ReadonlyArray<Planned> = [
        { kind: "source", name: "T3 Code source", broken: false },
        ...patchSteps,
        ...targetChecks.map((check) => ({ kind: "check" as const, name: check.name, broken: rollFailure(check.name) })),
        ...patches.flatMap((p) =>
          p.manifest.checks.map((check) => ({
            kind: "check" as const,
            name: `${p.manifest.id}: ${check.name}`,
            broken: rollFailure(check.name),
          })),
        ),
        ...build.map((command) => ({ kind: "build" as const, name: command.name, broken: rollFailure(command.name) })),
        ...patches.flatMap((p) =>
          p.manifest.journeys.map((journey) => ({
            kind: "journey" as const,
            name: `${p.manifest.id}: ${journey.name}`,
            broken: rollFailure(journey.name),
          })),
        ),
        { kind: "save", name: "save patches", broken: false },
        ...(install ? [{ kind: "install" as const, name: "install", broken: installFails }] : []),
      ];
      story.push(`failing ${[...failing].join(" ")}`, `install ${install}${installFails ? " fails" : ""}`);

      const firstFailure = plan.findIndex((step) => step.broken);
      const passedUpTo = firstFailure === -1 ? plan.length : firstFailure;
      const expectedSteps = plan.map(
        (step, index) =>
          `${step.kind} ${step.name}: ${index < passedUpTo ? "passed" : index === passedUpTo ? "failed" : "skipped"}`,
      );
      const savedAll = passedUpTo > plan.findIndex((step) => step.kind === "save");
      const expected = {
        steps: expectedSteps,
        written: savedAll ? needsSave : [],
        installed: install && firstFailure === -1 ? ["/work/stack/release/T3 Code.app"] : [],
        lastReportIsResult: true,
      };

      const fake = yield* fakes({ conflicts, failing, installFails });
      const report = yield* run(target({ checks: targetChecks, build }), patches, install, { evidence: "/e" }).pipe(
        Effect.provide(fake.layer),
      );
      const actual = {
        steps: report.steps.map((step) => `${step.kind} ${step.name}: ${step.status}`),
        written: (yield* Ref.get(fake.written)).map((saved) => saved.manifest.id),
        installed: yield* Ref.get(fake.installed),
        lastReportIsResult: (yield* Ref.get(fake.reports)).at(-1) === report,
      };
      expect(actual, `seed ${seed}: ${story.join(", ")}`).toEqual(expected);
    }
  }));
