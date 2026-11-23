import { InvalidName, StorageFailed } from "@app/contracts";
import { current, entries, parseItemName, record } from "@app/tally";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { memoryStore } from "./support/store.ts";

describe("record", () => {
  it.effect("counts each name and keeps them sorted", () =>
    Effect.gen(function* () {
      const store = yield* memoryStore;
      const apple = yield* parseItemName("apple");
      const pear = yield* parseItemName("pear");
      yield* record(pear).pipe(Effect.provide(store.layer));
      yield* record(apple).pipe(Effect.provide(store.layer));
      yield* record(apple).pipe(Effect.provide(store.layer));
      const saved = yield* current.pipe(Effect.provide(store.layer));
      expect(entries(saved)).toEqual([["apple", 2], ["pear", 1]]);
    }));

  it.effect("a failed save keeps the saved tally", () =>
    Effect.gen(function* () {
      const store = yield* memoryStore;
      const apple = yield* parseItemName("apple");
      yield* record(apple).pipe(Effect.provide(store.layer));
      yield* Ref.set(store.failNextSave, true);
      const failed = yield* record(apple).pipe(Effect.provide(store.layer), Effect.flip);
      expect(failed).toBeInstanceOf(StorageFailed);
      expect(entries(yield* Ref.get(store.saved))).toEqual([["apple", 1]]);
    }));
});

describe("parseItemName", () => {
  it.effect("refuses names outside 1 to 32 letters, digits, '-' or '_'", () =>
    Effect.gen(function* () {
      for (const bad of ["", "two words", "x".repeat(33), "é"]) {
        expect(yield* Effect.flip(parseItemName(bad))).toBeInstanceOf(InvalidName);
      }
      expect(yield* parseItemName("a-b_C9")).toBe("a-b_C9");
    }));
});
