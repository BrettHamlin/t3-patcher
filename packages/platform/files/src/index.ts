import { decodeTallyJson, encodeTallyJson, StorageFailed } from "@app/contracts";
import { TallyStore } from "@app/tally";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

const failed = (): StorageFailed => new StorageFailed();

/** The tally in `folder`/tally.json. A missing file is an empty tally; saves go to a temporary file, then a rename. */
export const fileTallyStore = (folder: string): Layer.Layer<TallyStore, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(TallyStore)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(folder, "tally.json");
      return {
        load: Effect.gen(function* () {
          if (!(yield* fs.exists(file).pipe(Effect.mapError(failed)))) {
            return new Map();
          }
          return yield* decodeTallyJson(yield* fs.readFileString(file).pipe(Effect.mapError(failed)));
        }),
        save: Effect.fn("TallyStore.save")(function* (tally) {
          const temporary = `${file}.tmp`;
          yield* fs.writeFileString(temporary, yield* encodeTallyJson(tally)).pipe(Effect.mapError(failed));
          yield* fs.rename(temporary, file).pipe(Effect.mapError(failed));
        }),
      };
    }),
  );
