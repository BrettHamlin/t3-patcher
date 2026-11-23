import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { uiId } from "./ui.ts";

/** An item's name: 1 to 32 letters, digits, '-' or '_'. Only decoding makes one. */
export const ItemName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,32}$/)),
  Schema.brand("ItemName"),
);
export type ItemName = typeof ItemName.Type;

/** How many times each item was recorded. */
export type Tally = ReadonlyMap<ItemName, number>;

export class InvalidName extends Schema.TaggedError<InvalidName>()("InvalidName", {}) {
  override get message(): string {
    return "names are 1 to 32 letters, digits, '-' or '_'";
  }
}

export class StorageFailed extends Schema.TaggedError<StorageFailed>()("StorageFailed", {}) {
  override get message(): string {
    return "the tally couldn't be read or saved";
  }
}

/** The tally as it is saved and sent between processes: plain data. */
export const SavedTally = Schema.Struct({
  items: Schema.Array(Schema.Tuple([ItemName, Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))])),
});
export type SavedTally = typeof SavedTally.Encoded;

const decodeSaved = Schema.decodeUnknownEffect(SavedTally);
const decodeSavedJson = Schema.decodeUnknownEffect(Schema.fromJsonString(SavedTally));
const encodeSavedJson = Schema.encodeEffect(Schema.fromJsonString(SavedTally));

/** Read saved data back into a tally; anything malformed is a storage failure. */
export const decodeTally = (data: unknown): Effect.Effect<Tally, StorageFailed> =>
  decodeSaved(data).pipe(
    Effect.map(({ items }) => new Map(items)),
    Effect.mapError(() => new StorageFailed()),
  );

/** The same, from the JSON text a store saved. */
export const decodeTallyJson = (text: string): Effect.Effect<Tally, StorageFailed> =>
  decodeSavedJson(text).pipe(
    Effect.map(({ items }) => new Map(items)),
    Effect.mapError(() => new StorageFailed()),
  );

export const encodeTally = (tally: Tally): SavedTally => ({ items: [...tally] });

export const encodeTallyJson = (tally: Tally): Effect.Effect<string, StorageFailed> =>
  encodeSavedJson({ items: [...tally] }).pipe(Effect.mapError(() => new StorageFailed()));

export * from "./ipc.ts";
export type { UiId } from "./ui.ts";

/** Element identifiers shared by the renderer and the journeys. */
export const TallyUi = {
  name: uiId("tally-name"),
  add: uiId("tally-add"),
  items: uiId("tally-items"),
  error: uiId("tally-error"),
} as const;
