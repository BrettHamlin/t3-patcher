import { InvalidName, ItemName, type StorageFailed, type Tally } from "@app/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Where the tally is kept. A platform package implements it; the composition root picks one. */
export interface TallyStoreShape {
  readonly load: Effect.Effect<Tally, StorageFailed>;
  readonly save: (tally: Tally) => Effect.Effect<void, StorageFailed>;
}

export class TallyStore extends Context.Service<TallyStore, TallyStoreShape>()("@app/tally/TallyStore") {}

const decodeName = Schema.decodeUnknownEffect(ItemName);

export const parseItemName = (raw: string): Effect.Effect<ItemName, InvalidName> =>
  decodeName(raw).pipe(Effect.mapError(() => new InvalidName()));

/** The tally after recording `name` once more. */
export const recorded = (tally: Tally, name: ItemName): Tally =>
  new Map([...tally, [name, (tally.get(name) ?? 0) + 1]]);

/** Every item and its count, sorted by name. */
export const entries = (tally: Tally): ReadonlyArray<readonly [ItemName, number]> =>
  [...tally].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** Record one more of `name` and save it. If the save fails, the saved tally is unchanged. */
export const record = Effect.fn("record")(function* (name: ItemName) {
  const store = yield* TallyStore;
  const next = recorded(yield* store.load, name);
  yield* store.save(next);
  return next;
});

/** The saved tally. */
export const current = Effect.gen(function* () {
  const store = yield* TallyStore;
  return yield* store.load;
});
