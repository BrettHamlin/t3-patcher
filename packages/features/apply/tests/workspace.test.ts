import { PatchId, StepFailed } from "@app/contracts";
import { capture, openWorkspace } from "@app/apply";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { commit, fakes, patch, target } from "./support/fakes.ts";

const request = Effect.fn("request")(function* (id: string) {
  return { id: yield* Schema.decodeEffect(PatchId)(id), title: "New title", summary: "New summary" };
});

describe("openWorkspace", () => {
  it.effect("commits the preceding patches, then applies the patch's own diff uncommitted", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({ conflicts: new Map([["diff:c", { files: ["src/z.ts"], resolves: true }]]) });
      const baseCommit = yield* commit("b");
      const a = yield* patch("a", { baseCommit });
      const b = yield* patch("b", { baseCommit });
      const c = yield* patch("c", { baseCommit });
      const folder = yield* openWorkspace(target(), [a, b], c, "c").pipe(Effect.provide(fake.layer));
      expect(folder).toBe("/work/workspace-c");
      expect(yield* Ref.get(fake.events)).toEqual([
        "open v0.1.11 in workspace-c",
        "apply diff:a in /work/workspace-c",
        "commit a: Title a in /work/workspace-c",
        "apply diff:b in /work/workspace-c",
        "commit b: Title b in /work/workspace-c",
        "apply diff:c in /work/workspace-c",
        "resolve c (src/z.ts) in /work/workspace-c",
      ]);
    }));

  it.effect("for a new patch, applies only the preceding ones", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({ version: "0.2.0" });
      const a = yield* patch("a", { baseCommit: yield* commit("b") });
      const folder = yield* openWorkspace(target(), [a], undefined, "fresh").pipe(Effect.provide(fake.layer));
      expect(folder).toBe("/work/workspace-fresh");
      expect(yield* Ref.get(fake.events)).toEqual([
        "open v0.2.0 in workspace-fresh",
        "apply diff:a in /work/workspace-fresh",
        "commit a: Title a in /work/workspace-fresh",
      ]);
    }));

  it.effect("fails naming the patch whose conflicts are left", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({ conflicts: new Map([["diff:b", { files: ["src/x.ts"], resolves: false }]]) });
      const baseCommit = yield* commit("b");
      const a = yield* patch("a", { baseCommit });
      const b = yield* patch("b", { baseCommit });
      const c = yield* patch("c", { baseCommit });
      const failed = yield* openWorkspace(target(), [a, b], c, "c").pipe(Effect.provide(fake.layer), Effect.flip);
      expect(failed).toEqual(new StepFailed({ reason: "b: conflicts left in src/x.ts" }));
      expect(yield* Ref.get(fake.events)).toEqual([
        "open v0.1.11 in workspace-c",
        "apply diff:a in /work/workspace-c",
        "commit a: Title a in /work/workspace-c",
        "apply diff:b in /work/workspace-c",
        "resolve b (src/x.ts) in /work/workspace-c",
      ]);
    }));
});

describe("capture", () => {
  it.effect("saves a new patch with a journey that fails until it's written", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({ pending: "diff:new" });
      const saved = yield* capture(target(), yield* request("new"), undefined).pipe(Effect.provide(fake.layer));
      expect(saved).toEqual({
        manifest: {
          id: "new",
          title: "New title",
          summary: "New summary",
          base: { version: "0.1.11", commit: fake.baseCommit },
          checks: [],
          journeys: [
            {
              name: "new_works",
              proves: "Write what this journey proves.",
              run: "echo 'Write this journey: patches/new/patch.json' >&2; exit 1",
            },
          ],
        },
        diff: "diff:new",
      });
      expect(yield* Ref.get(fake.written)).toEqual([saved]);
      expect(yield* Ref.get(fake.events)).toEqual(["existing workspace-new", "write new"]);
    }));

  it.effect("replaces an existing patch's diff, base, title and summary, keeping its checks and journeys", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({ pending: "diff:a2", version: "0.2.0" });
      const a = yield* patch("a", {
        baseCommit: yield* commit("c"),
        checks: [{ name: "unit", run: "bun test a" }],
        journeys: [{ name: "opens", proves: "it opens", run: "run opens" }],
      });
      const saved = yield* capture(target(), yield* request("a"), a).pipe(Effect.provide(fake.layer));
      expect(saved).toEqual({
        manifest: {
          id: "a",
          title: "New title",
          summary: "New summary",
          base: { version: "0.2.0", commit: fake.baseCommit },
          checks: [{ name: "unit", run: "bun test a" }],
          journeys: [{ name: "opens", proves: "it opens", run: "run opens" }],
        },
        diff: "diff:a2",
      });
      expect(yield* Ref.get(fake.written)).toEqual([saved]);
    }));

  it.effect("fails when nothing changed in the workspace", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const failed = yield* capture(target(), yield* request("a"), undefined).pipe(
        Effect.provide(fake.layer),
        Effect.flip,
      );
      expect(failed).toEqual(new StepFailed({ reason: "nothing changed in the workspace for a" }));
      expect(yield* Ref.get(fake.written)).toEqual([]);
    }));
});
