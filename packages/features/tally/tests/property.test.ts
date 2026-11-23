// Random sequences of records and failed saves, checked step by step against a model of the spec. Seeded, so a
// failure prints a seed and steps that reproduce it; no library.
import type { ItemName } from "@app/contracts";
import { entries, parseItemName, record } from "@app/tally";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { memoryStore } from "./support/store.ts";

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

it.effect("matches the model over 200 random sequences", () =>
  Effect.gen(function* () {
    const names: Array<ItemName> = [];
    for (const raw of ["apple", "pear", "fig"]) names.push(yield* parseItemName(raw));
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = generator(seed);
      const store = yield* memoryStore;
      const model = new Map<ItemName, number>();
      const steps: Array<string> = [];
      for (let step = 0; step < 20; step += 1) {
        const name = names[Math.floor(random() * names.length)];
        if (name === undefined) return yield* Effect.die("no name");
        const fails = random() < 0.2;
        steps.push(`${fails ? "fail " : ""}record ${name}`);
        yield* Ref.set(store.failNextSave, fails);
        yield* record(name).pipe(Effect.provide(store.layer), Effect.ignore);
        if (!fails) model.set(name, (model.get(name) ?? 0) + 1);
        const actual = entries(yield* Ref.get(store.saved));
        const expected = [...model].toSorted(([a], [b]) => (a < b ? -1 : 1));
        expect(actual, `seed ${seed}: ${steps.join(", ")}`).toEqual(expected);
      }
    }
  }));
