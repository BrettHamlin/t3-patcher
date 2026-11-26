// Random sequences of toggles, moves, and patches added and removed, checked step by step against a model of the
// spec. Seeded, so a failure prints a seed and steps that reproduce it; no library.
import type { Patch, PatchId, StackEntry } from "@app/contracts";
import { library, moved, saveStack, toggled } from "@app/stack";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { memory, patch } from "./support/memory.ts";

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

type Operation = "toggle" | "up" | "down" | "add" | "remove" | "update";

/**
 * The spec, when the app saves the stack it shows after every change: new patches (including ones an update brings)
 * join at the end and on, removed ones gone, and existing entries keep their on/off state.
 */
const model = (entries: ReadonlyArray<StackEntry>, operation: Operation, id: PatchId, exists: boolean) => {
  const at = entries.findIndex((entry) => entry.id === id);
  const swap = (other: number) => {
    const next = [...entries];
    const a = next[at];
    const b = next[other];
    if (a === undefined || b === undefined) return entries;
    next[at] = b;
    next[other] = a;
    return next;
  };
  switch (operation) {
    case "toggle":
      return entries.map((entry) => (entry.id === id ? { id, enabled: !entry.enabled } : entry));
    case "up":
      return at === -1 ? entries : swap(at - 1);
    case "down":
      return at === -1 ? entries : swap(at + 1);
    case "add":
    case "update":
      return exists ? entries : [...entries, { id, enabled: true }];
    case "remove":
      return entries.filter((entry) => entry.id !== id);
  }
};

it.effect("matches the model over 200 random sequences", () =>
  Effect.gen(function* () {
    const operations: ReadonlyArray<Operation> = ["toggle", "up", "down", "add", "remove", "update"];
    const pool = yield* Effect.all([patch("a"), patch("b"), patch("c"), patch("d"), patch("e")]);
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = generator(seed);
      const store = yield* memory([], { entries: [] });
      let expected: ReadonlyArray<StackEntry> = [];
      const steps: Array<string> = [];
      for (let step = 0; step < 30; step += 1) {
        const operation = operations[Math.floor(random() * operations.length)];
        const chosen = pool[Math.floor(random() * pool.length)];
        if (operation === undefined || chosen === undefined) return yield* Effect.die("nothing chosen");
        const id = chosen.manifest.id;
        steps.push(`${operation} ${id}`);
        const patches = yield* Ref.get(store.library);
        const exists = patches.some((each) => each.manifest.id === id);
        const stack = (yield* library.pipe(Effect.provide(store.layer))).stack;
        switch (operation) {
          case "toggle":
            yield* saveStack(toggled(stack, id)).pipe(Effect.provide(store.layer));
            break;
          case "up":
          case "down":
            yield* saveStack(moved(stack, id, operation === "up" ? -1 : 1)).pipe(Effect.provide(store.layer));
            break;
          case "add":
          case "update":
            if (!exists) yield* Ref.set(store.library, [...patches, chosen]);
            yield* saveStack(stack).pipe(Effect.provide(store.layer));
            break;
          case "remove":
            yield* Ref.set(store.library, patches.filter((each) => each.manifest.id !== id));
            yield* saveStack(stack).pipe(Effect.provide(store.layer));
            break;
        }
        expected = model(expected, operation, id, exists);
        const view = yield* library.pipe(Effect.provide(store.layer));
        const byId = new Map<PatchId, Patch>(pool.map((each) => [each.manifest.id, each]));
        expect(view, `seed ${seed}: ${steps.join(", ")}`).toEqual({
          stack: { entries: expected },
          patches: expected.flatMap((entry) => byId.get(entry.id)?.manifest ?? []),
        });
      }
    }
  }));
