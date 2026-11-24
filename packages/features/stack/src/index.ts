import {
  type Feed,
  InvalidPatchId,
  PatchId,
  type LibraryView,
  type Patch,
  type Stack,
  type StackEntry,
  type StorageFailed,
} from "@app/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** The patches folder: every patch in it. A platform package implements it. */
export interface LibraryShape {
  readonly patches: Effect.Effect<ReadonlyArray<Patch>, StorageFailed>;
}
export class Library extends Context.Service<Library, LibraryShape>()("@app/stack/Library") {}

/** Where the stack (order and which patches are on) is kept: the user data folder. */
export interface StackStoreShape {
  readonly load: Effect.Effect<Stack, StorageFailed>;
  readonly save: (stack: Stack) => Effect.Effect<void, StorageFailed>;
}
export class StackStore extends Context.Service<StackStore, StackStoreShape>()("@app/stack/StackStore") {}

const decodeId = Schema.decodeUnknownEffect(PatchId);

export const parsePatchId = (raw: string): Effect.Effect<PatchId, InvalidPatchId> =>
  decodeId(raw).pipe(Effect.mapError(() => new InvalidPatchId()));

const byId = (a: PatchId, b: PatchId): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The stack for the patches that exist: the saved order first, without patches that no longer exist, then new
 * patches, on, sorted by name.
 */
export const arranged = (patches: ReadonlyArray<Patch>, saved: Stack): Stack => {
  const ids = new Set(patches.map((patch) => patch.manifest.id));
  const kept = saved.entries.filter((entry, index) =>
    ids.has(entry.id) && saved.entries.findIndex((other) => other.id === entry.id) === index,
  );
  const known = new Set(kept.map((entry) => entry.id));
  const added: ReadonlyArray<StackEntry> = [...ids]
    .filter((id) => !known.has(id))
    .toSorted(byId)
    .map((id) => ({ id, enabled: true }));
  return { entries: [...kept, ...added] };
};

/** The stack with `id` turned on or off. */
export const toggled = (stack: Stack, id: PatchId): Stack => ({
  entries: stack.entries.map((entry) => (entry.id === id ? { id, enabled: !entry.enabled } : entry)),
});

/** The stack with `id` moved one place earlier (-1) or later (+1); unchanged at either end. */
export const moved = (stack: Stack, id: PatchId, by: -1 | 1): Stack => {
  const from = stack.entries.findIndex((entry) => entry.id === id);
  const to = from + by;
  const entry = stack.entries[from];
  const other = stack.entries[to];
  if (from === -1 || entry === undefined || other === undefined) return stack;
  return { entries: stack.entries.map((each, index) => (index === from ? other : index === to ? entry : each)) };
};

/** The stack with `id` last and on: where a new patch goes, after every patch its workspace had applied. */
export const appended = (stack: Stack, id: PatchId): Stack => ({
  entries: [...stack.entries.filter((entry) => entry.id !== id), { id, enabled: true }],
});

/**
 * The stack after the patches folder changed under `before` (a stack naming every patch there was): the patches that
 * are still there keep their order and whether they're on, and patches that are new join at the end, off, sorted by
 * name. An update never turns on a patch the user didn't choose.
 */
export const joinedOff = (patches: ReadonlyArray<Patch>, before: Stack): Stack => {
  const known = new Set(before.entries.map((entry) => entry.id));
  const added: ReadonlyArray<StackEntry> = patches
    .map((patch) => patch.manifest.id)
    .filter((id) => !known.has(id))
    .toSorted(byId)
    .map((id) => ({ id, enabled: false }));
  return arranged(patches, { entries: [...before.entries, ...added] });
};

/** The feed (patches/index.json) for `patches`: each one's id, title, summary and version, sorted by id. */
export const feedIndex = (patches: ReadonlyArray<Patch>): Feed => ({
  patches: patches
    .map(({ manifest }) => ({ id: manifest.id, title: manifest.title, summary: manifest.summary, version: manifest.version }))
    .toSorted((a, b) => byId(a.id, b.id)),
});

/** The patches that are on, in stack order. */
export const selected = (stack: Stack, patches: ReadonlyArray<Patch>): ReadonlyArray<Patch> =>
  stack.entries.flatMap((entry) => {
    const patch = patches.find((each) => each.manifest.id === entry.id);
    return entry.enabled && patch !== undefined ? [patch] : [];
  });

/** The patches that are on and come before `id` in the stack. */
export const before = (stack: Stack, patches: ReadonlyArray<Patch>, id: PatchId): ReadonlyArray<Patch> => {
  const at = stack.entries.findIndex((entry) => entry.id === id);
  return selected({ entries: at === -1 ? stack.entries : stack.entries.slice(0, at) }, patches);
};

/** Every patch and the saved stack, arranged. */
export const library = Effect.gen(function* () {
  const patches = yield* (yield* Library).patches;
  const stack = arranged(patches, yield* (yield* StackStore).load);
  return { stack, patches: stack.entries.flatMap((entry) => patches.filter((p) => p.manifest.id === entry.id).map((p) => p.manifest)) } satisfies LibraryView;
});

/** Save a changed stack, arranged against the patches that exist. */
export const saveStack = Effect.fn("saveStack")(function* (stack: Stack) {
  const patches = yield* (yield* Library).patches;
  const next = arranged(patches, stack);
  yield* (yield* StackStore).save(next);
  return next;
});
