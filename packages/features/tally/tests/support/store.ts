import { StorageFailed, type Tally } from "@app/contracts";
import { TallyStore } from "@app/tally";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/** An in-memory store whose next save can be made to fail. */
export const memoryStore = Effect.gen(function* () {
  const saved = yield* Ref.make<Tally>(new Map());
  const failNextSave = yield* Ref.make(false);
  const layer = Layer.succeed(TallyStore)({
    load: Ref.get(saved),
    save: Effect.fn("memory.save")(function* (tally) {
      if (yield* Ref.getAndSet(failNextSave, false)) {
        return yield* new StorageFailed();
      }
      yield* Ref.set(saved, tally);
    }),
  });
  return { layer, saved, failNextSave };
});
