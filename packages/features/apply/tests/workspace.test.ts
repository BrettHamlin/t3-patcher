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
        "existing workspace-c",
        "open v0.1.11 in workspace-c",
        "apply diff:a in /work/workspace-c",
        "commit a: Title a in /work/workspace-c",
        "apply diff:b in /work/workspace-c",
        "commit b: Title b in /work/workspace-c",
        "apply diff:c in /work/workspace-c",
        "resolve c (src/z.ts) in /work/workspace-c",
        "ready 0.1.11 in /work/workspace-c",
      ]);
    }));

  it.effect("for a new patch, applies only the preceding ones", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({ version: "0.2.0" });
      const a = yield* patch("a", { baseCommit: yield* commit("b") });
      const folder = yield* openWorkspace(target(), [a], undefined, "fresh").pipe(Effect.provide(fake.layer));
      expect(folder).toBe("/work/workspace-fresh");
      expect(yield* Ref.get(fake.events)).toEqual([
        "existing workspace-fresh",
        "open v0.2.0 in workspace-fresh",
        "apply diff:a in /work/workspace-fresh",
        "commit a: Title a in /work/workspace-fresh",
        "ready 0.2.0 in /work/workspace-fresh",
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
        "existing workspace-c",
        "open v0.1.11 in workspace-c",
        "apply diff:a in /work/workspace-c",
        "commit a: Title a in /work/workspace-c",
        "apply diff:b in /work/workspace-c",
        "resolve b (src/x.ts) in /work/workspace-c",
      ]);
    }));

  it.effect("leaves the workspace unready when the patch's own diff has conflicts left, so capture refuses it", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({ conflicts: new Map([["diff:c", { files: ["src/z.ts"], resolves: false }]]) });
      const c = yield* patch("c", { baseCommit: yield* commit("b") });
      const failed = yield* openWorkspace(target(), [], c, "c").pipe(Effect.provide(fake.layer), Effect.flip);
      expect(failed).toEqual(new StepFailed({ reason: "c: conflicts left in src/z.ts" }));
      const refused = yield* capture(target(), yield* request("c"), c).pipe(Effect.provide(fake.layer), Effect.flip);
      expect(refused).toEqual(new StepFailed({ reason: "no workspace ready in workspace-c" }));
      expect(yield* Ref.get(fake.written)).toEqual([]);
    }));

  it.effect("refuses to wipe changes in the workspace that aren't captured", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({ existing: new Map([["workspace-c", { version: "0.1.11", pending: "diff:c\ndraft" }]]) });
      const c = yield* patch("c", { baseCommit: yield* commit("b") });
      const failed = yield* openWorkspace(target(), [], c, "c").pipe(Effect.provide(fake.layer), Effect.flip);
      expect(failed).toEqual(
        new StepFailed({
          reason:
            "the workspace for c has changes that aren't captured: capture them, or delete /work/workspace-c to start over",
        }),
      );
      expect(yield* Ref.get(fake.events)).toEqual(["existing workspace-c"]);
    }));

  it.effect("refuses to wipe a draft of a patch that hasn't been captured yet", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({ existing: new Map([["workspace-new", { version: "0.1.11", pending: "draft" }]]) });
      const failed = yield* openWorkspace(target(), [], undefined, "new").pipe(Effect.provide(fake.layer), Effect.flip);
      expect(failed).toEqual(
        new StepFailed({
          reason:
            "the workspace for new has changes that aren't captured: capture them, or delete /work/workspace-new to start over",
        }),
      );
      expect(yield* Ref.get(fake.events)).toEqual(["existing workspace-new"]);
    }));

  it.effect("reopens a workspace whose changes are all captured", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({
        existing: new Map([
          ["workspace-c", { version: "0.1.10", pending: "diff:c" }],
          ["workspace-d", { version: "0.1.10", pending: "" }],
        ]),
      });
      const c = yield* patch("c", { baseCommit: yield* commit("b") });
      expect(yield* openWorkspace(target(), [], c, "c").pipe(Effect.provide(fake.layer))).toBe("/work/workspace-c");
      expect(yield* openWorkspace(target(), [], undefined, "d").pipe(Effect.provide(fake.layer))).toBe(
        "/work/workspace-d",
      );
      expect(yield* Ref.get(fake.events)).toEqual([
        "existing workspace-c",
        "open v0.1.11 in workspace-c",
        "apply diff:c in /work/workspace-c",
        "ready 0.1.11 in /work/workspace-c",
        "existing workspace-d",
        "open v0.1.11 in workspace-d",
        "ready 0.1.11 in /work/workspace-d",
      ]);
    }));
});

describe("capture", () => {
  it.effect("saves a new patch with a journey that fails until it's written", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({ existing: new Map([["workspace-new", { version: "0.1.11", pending: "diff:new" }]]) });
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
      const fake = yield* fakes({ existing: new Map([["workspace-a", { version: "0.2.0", pending: "diff:a2" }]]) });
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

  it.effect("bases the patch on the version the workspace was opened for, not the one installed now", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({
        version: "0.2.0",
        existing: new Map([["workspace-new", { version: "0.1.11", pending: "diff:new" }]]),
      });
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
    }));

  it.effect("fails while the workspace has conflicts left", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({
        existing: new Map([["workspace-a", { version: "0.1.11", pending: "diff:a", conflicts: ["src/x.ts", "src/y.ts"] }]]),
      });
      const failed = yield* capture(target(), yield* request("a"), undefined).pipe(
        Effect.provide(fake.layer),
        Effect.flip,
      );
      expect(failed).toEqual(
        new StepFailed({ reason: "conflicts left in src/x.ts, src/y.ts: resolve them before capturing" }),
      );
      expect(yield* Ref.get(fake.written)).toEqual([]);
    }));

  it.effect("fails when there's no workspace ready", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const failed = yield* capture(target(), yield* request("a"), undefined).pipe(
        Effect.provide(fake.layer),
        Effect.flip,
      );
      expect(failed).toEqual(new StepFailed({ reason: "no workspace ready in workspace-a" }));
      expect(yield* Ref.get(fake.written)).toEqual([]);
    }));

  it.effect("fails when nothing changed in the workspace", () =>
    Effect.gen(function* () {
      const fake = yield* fakes({ existing: new Map([["workspace-a", { version: "0.1.11", pending: "" }]]) });
      const failed = yield* capture(target(), yield* request("a"), undefined).pipe(
        Effect.provide(fake.layer),
        Effect.flip,
      );
      expect(failed).toEqual(new StepFailed({ reason: "nothing changed in the workspace for a" }));
      expect(yield* Ref.get(fake.written)).toEqual([]);
    }));
});
