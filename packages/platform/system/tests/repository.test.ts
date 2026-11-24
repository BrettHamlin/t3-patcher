import { PublishedPatches } from "@app/apply";
import { StepFailed } from "@app/contracts";
import { gitPublishedPatches } from "@app/system";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { exists, git, read, temporary, write } from "./support/repo.ts";

const head = (folder: string) => git(folder, "rev-parse", "HEAD").pipe(Effect.map((sha) => sha.trim()));

/**
 * A published repository (bare, a stand-in for GitHub) with patches/ on main; the author's checkout of it at
 * `<root>/dev` (the patches folder settings name); and the clone updates use at `<root>/work/published`.
 */
const published = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = yield* temporary;
  const origin = path.join(root, "origin.git");
  const author = path.join(root, "author");
  const dev = path.join(root, "dev");
  const clone = path.join(root, "work", "published");
  yield* write(path.join(author, "patches", "a", "patch.json"), "{}\n");
  yield* git(author, "init", "--quiet", "--initial-branch=main");
  yield* git(author, "add", "-A");
  yield* git(author, "commit", "--quiet", "-m", "one");
  yield* git(root, "clone", "--quiet", "--bare", author, origin);
  yield* git(author, "remote", "add", "origin", origin);
  yield* git(root, "clone", "--quiet", origin, dev);
  const patchesOf = (source: string) =>
    PublishedPatches.useSync((service) => service).pipe(
      Effect.provide(gitPublishedPatches({ source, clone }).pipe(Layer.provide(NodeServices.layer))),
    );
  const service = yield* patchesOf(path.join(dev, "patches"));
  /** A new commit on origin's main, changing patch a. */
  const publish = (text: string) =>
    Effect.gen(function* () {
      yield* write(path.join(author, "patches", "a", "patch.json"), `${text}\n`);
      yield* git(author, "commit", "--quiet", "-am", text);
      yield* git(author, "push", "--quiet", "origin", "main");
      return yield* head(author);
    });
  const patchA = path.join(clone, "patches", "a", "patch.json");
  return { root, origin, dev, clone, service, patchesOf, publish, patchA, first: yield* head(author) };
});

describe("gitPublishedPatches", () => {
  it.live("clones origin the first time, then fast-forwards, and says when it's up to date", () =>
    Effect.gen(function* () {
      const { origin, clone, service, publish, patchA, first } = yield* published;
      const folder = yield* service.folder;
      const cloned = yield* service.sync("main");
      const same = yield* service.sync("main");
      const second = yield* publish('{"v":2}');
      const moved = yield* service.sync("main");
      expect([folder, cloned, same, moved, yield* read(patchA)]).toEqual([
        `${clone}/patches/`,
        { url: origin, from: null, to: first, reset: false },
        { url: origin, from: first, to: first, reset: false },
        { url: origin, from: first, to: second, reset: false },
        '{"v":2}\n',
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("never minds the author's checkout: another branch, local changes or local commits", () =>
    Effect.gen(function* () {
      const { origin, dev, service, publish, patchA, first } = yield* published;
      yield* service.sync("main");
      yield* git(dev, "checkout", "--quiet", "-b", "feature");
      yield* write(`${dev}/patches/a/patch.json`, '{"draft":true}\n');
      yield* git(dev, "commit", "--quiet", "-am", "local");
      yield* write(`${dev}/patches/a/patch.json`, '{"uncommitted":true}\n');
      const second = yield* publish('{"v":2}');
      expect([yield* service.sync("main"), yield* read(patchA)]).toEqual([
        { url: origin, from: first, to: second, reset: false },
        '{"v":2}\n',
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("resets a clone that can't fast-forward, or was changed, to the published branch", () =>
    Effect.gen(function* () {
      const { origin, clone, service, publish, patchA } = yield* published;
      yield* service.sync("main");
      yield* write(patchA, '{"edited":true}\n');
      yield* git(clone, "commit", "--quiet", "-am", "edited in the clone");
      const edited = yield* head(clone);
      const second = yield* publish('{"v":2}');
      const diverged = yield* service.sync("main");
      yield* write(patchA, '{"uncommitted":true}\n');
      yield* write(`${clone}/stray.txt`, "stray\n");
      const changed = yield* service.sync("main");
      expect([diverged, changed, yield* read(patchA), yield* exists(`${clone}/stray.txt`)]).toEqual([
        { url: origin, from: edited, to: second, reset: true },
        { url: origin, from: second, to: second, reset: true },
        '{"v":2}\n',
        false,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("fails when the patches repository has no origin", () =>
    Effect.gen(function* () {
      const { root, clone, patchesOf } = yield* published;
      const lonely = `${root}/lonely`;
      yield* write(`${lonely}/patches/a/patch.json`, "{}\n");
      yield* git(lonely, "init", "--quiet", "--initial-branch=main");
      const service = yield* patchesOf(`${lonely}/patches`);
      expect([yield* Effect.flip(service.sync("main")), yield* exists(clone)]).toEqual([
        new StepFailed({
          reason: `the patches repository at ${lonely}/patches has no origin: updates come from its origin's main`,
        }),
        false,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
});
