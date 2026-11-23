import { decodeTally, encodeTally, StorageFailed, type TallyBridge } from "@app/contracts";
import { TallyStore } from "@app/tally";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const failed = (): StorageFailed => new StorageFailed();

/** The tally store as the renderer sees it: the main process, through the preload's bridge. */
export const bridgeTallyStore = (bridge: TallyBridge): Layer.Layer<TallyStore> =>
  Layer.succeed(TallyStore)({
    load: Effect.tryPromise({ try: () => bridge.load(), catch: failed }).pipe(Effect.flatMap(decodeTally)),
    save: Effect.fn("TallyStore.save")(function* (tally) {
      const saved = yield* Effect.tryPromise({ try: () => bridge.save(encodeTally(tally)), catch: failed });
      if (saved !== true) {
        return yield* new StorageFailed();
      }
    }),
  });
