import type { Stack } from "@app/contracts";
import { appended, arranged, before, library, moved, saveStack, selected, toggled } from "@app/stack";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { memory, patch } from "./support/memory.ts";

const ids = (stack: Stack) => stack.entries.map((entry) => entry.id);
const three = Effect.all([patch("a"), patch("b"), patch("c")]);

describe("arranged", () => {
  it.effect("keeps the saved order, drops missing and repeated entries, and adds new patches on, by name", () =>
    Effect.gen(function* () {
      const [a, b, c] = yield* three;
      const gone = yield* patch("gone");
      const saved = {
        entries: [
          { id: b.manifest.id, enabled: false },
          { id: gone.manifest.id, enabled: true },
          { id: b.manifest.id, enabled: true },
        ],
      };
      expect(arranged([c, a, b], saved)).toEqual({
        entries: [
          { id: "b", enabled: false },
          { id: "a", enabled: true },
          { id: "c", enabled: true },
        ],
      });
    }));

  it.effect("is empty with no patches", () =>
    Effect.gen(function* () {
      const [a] = yield* three;
      expect(arranged([], { entries: [{ id: a.manifest.id, enabled: true }] })).toEqual({ entries: [] });
    }));
});

describe("toggled", () => {
  it.effect("flips only the named entry", () =>
    Effect.gen(function* () {
      const [a, b, c] = yield* three;
      const stack = arranged([a, b], { entries: [] });
      expect(toggled(stack, b.manifest.id)).toEqual({
        entries: [
          { id: "a", enabled: true },
          { id: "b", enabled: false },
        ],
      });
      expect(toggled(toggled(stack, a.manifest.id), a.manifest.id)).toEqual(stack);
      expect(toggled(stack, c.manifest.id)).toEqual(stack);
    }));
});

describe("moved", () => {
  it.effect("swaps with the neighbour, and is unchanged at either end or for an unknown id", () =>
    Effect.gen(function* () {
      const [a, b, c] = yield* three;
      const d = yield* patch("d");
      const stack = arranged([a, b, c], { entries: [] });
      expect(ids(moved(stack, b.manifest.id, -1))).toEqual(["b", "a", "c"]);
      expect(ids(moved(stack, b.manifest.id, 1))).toEqual(["a", "c", "b"]);
      expect(moved(stack, a.manifest.id, -1)).toEqual(stack);
      expect(moved(stack, c.manifest.id, 1)).toEqual(stack);
      expect(moved(stack, d.manifest.id, 1)).toEqual(stack);
    }));
});

describe("appended", () => {
  it.effect("puts the id last and on, wherever it was before", () =>
    Effect.gen(function* () {
      const [a, b, c] = yield* three;
      const stack = arranged([a, b, c], { entries: [{ id: c.manifest.id, enabled: false }] });
      expect([
        appended({ entries: [{ id: a.manifest.id, enabled: false }] }, b.manifest.id),
        appended(stack, c.manifest.id),
      ]).toEqual([
        {
          entries: [
            { id: "a", enabled: false },
            { id: "b", enabled: true },
          ],
        },
        {
          entries: [
            { id: "a", enabled: true },
            { id: "b", enabled: true },
            { id: "c", enabled: true },
          ],
        },
      ]);
    }));
});

describe("selected and before", () => {
  it.effect("give the patches that are on, in stack order", () =>
    Effect.gen(function* () {
      const [a, b, c] = yield* three;
      const d = yield* patch("d");
      const stack = {
        entries: [
          { id: c.manifest.id, enabled: true },
          { id: a.manifest.id, enabled: false },
          { id: b.manifest.id, enabled: true },
          { id: d.manifest.id, enabled: true },
        ],
      };
      expect(selected(stack, [a, b, c])).toEqual([c, b]);
      expect(before(stack, [a, b, c], b.manifest.id)).toEqual([c]);
      expect(before(stack, [a, b, c], c.manifest.id)).toEqual([]);
      expect(before({ entries: stack.entries.slice(0, 3) }, [a, b, c, d], d.manifest.id)).toEqual([c, b]);
    }));
});

describe("library", () => {
  it.effect("gives the arranged stack and each manifest in stack order", () =>
    Effect.gen(function* () {
      const [a, b, c] = yield* three;
      const store = yield* memory([a, b, c], { entries: [{ id: c.manifest.id, enabled: false }] });
      const view = yield* library.pipe(Effect.provide(store.layer));
      expect(view).toEqual({
        stack: {
          entries: [
            { id: "c", enabled: false },
            { id: "a", enabled: true },
            { id: "b", enabled: true },
          ],
        },
        patches: [c.manifest, a.manifest, b.manifest],
      });
    }));
});

describe("saveStack", () => {
  it.effect("saves and returns the stack arranged against the patches that exist", () =>
    Effect.gen(function* () {
      const [a, b, c] = yield* three;
      const store = yield* memory([a, b], { entries: [] });
      const next = yield* saveStack({
        entries: [
          { id: c.manifest.id, enabled: true },
          { id: b.manifest.id, enabled: false },
        ],
      }).pipe(Effect.provide(store.layer));
      const expected = {
        entries: [
          { id: "b", enabled: false },
          { id: "a", enabled: true },
        ],
      };
      expect(next).toEqual(expected);
      expect(yield* Ref.get(store.saved)).toEqual(expected);
    }));
});
