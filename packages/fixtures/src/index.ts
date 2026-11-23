// Test setup: data a journey or test starts from. Only a devDependency (arch gate), so the shipped app can't use it.
import { decodeTally } from "@app/contracts";
import { fileTallyStore } from "@app/files";
import { TallyStore } from "@app/tally";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Save a tally in `folder`, the way the app saves one, before the app starts. */
export const savedTally = (folder: string, items: ReadonlyArray<readonly [string, number]>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const tally = yield* decodeTally({ items });
      const store = yield* TallyStore;
      yield* store.save(tally);
    }).pipe(Effect.provide(fileTallyStore(folder).pipe(Layer.provide(NodeServices.layer)))),
  );
