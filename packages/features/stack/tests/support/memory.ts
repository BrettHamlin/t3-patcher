import { PatchManifest, type Patch, type Stack } from "@app/contracts";
import { Library, StackStore } from "@app/stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

const decodeManifest = Schema.decodeUnknownEffect(PatchManifest);

/** A patch named `id` (version 1 unless given), with a one-line diff naming it. */
export const patch = (id: string, version = 1): Effect.Effect<Patch> =>
  decodeManifest({
    id,
    title: `Patch ${id}`,
    summary: `Changes ${id}`,
    version,
    base: { version: "0.1.0", commit: "0".repeat(40) },
    checks: [],
    journeys: [{ name: "opens", proves: "it opens", run: "true" }],
  }).pipe(
    Effect.map((manifest) => ({ manifest, diff: `diff ${id}\n` })),
    Effect.orDie,
  );

/** A library of `patches` and a stack store holding `stack`, both in memory. */
export const memory = (patches: ReadonlyArray<Patch>, stack: Stack) =>
  Effect.gen(function* () {
    const library = yield* Ref.make(patches);
    const saved = yield* Ref.make(stack);
    const layer = Layer.mergeAll(
      Layer.succeed(Library)({ patches: Ref.get(library) }),
      Layer.succeed(StackStore)({ load: Ref.get(saved), save: (next) => Ref.set(saved, next) }),
    );
    return { layer, library, saved };
  });
