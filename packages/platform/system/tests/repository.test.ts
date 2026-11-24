import { PatchRepository } from "@app/apply";
import { StepFailed } from "@app/contracts";
import { gitPatchRepository } from "@app/system";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { git, temporary, write } from "./support/repo.ts";

const head = (folder: string) => git(folder, "rev-parse", "HEAD").pipe(Effect.map((sha) => sha.trim()));

/** A published repository (bare) and a clone of it at `<root>/clone`, with patches/ in it, on main. */
const published = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = yield* temporary;
  const origin = path.join(root, "origin.git");
  const author = path.join(root, "author");
  const clone = path.join(root, "clone");
  yield* write(path.join(author, "patches", "a", "patch.json"), "{}\n");
  yield* git(author, "init", "--quiet", "--initial-branch=main");
  yield* git(author, "add", "-A");
  yield* git(author, "commit", "--quiet", "-m", "one");
  yield* git(root, "clone", "--quiet", "--bare", author, origin);
  yield* git(root, "clone", "--quiet", origin, clone);
  yield* git(author, "remote", "add", "origin", origin);
  const repository = yield* PatchRepository.useSync((service) => service).pipe(
    Effect.provide(gitPatchRepository(path.join(clone, "patches")).pipe(Layer.provide(NodeServices.layer))),
  );
  /** A new commit on origin's main. */
  const publish = Effect.gen(function* () {
    yield* write(path.join(author, "patches", "a", "patch.json"), '{"v":2}\n');
    yield* git(author, "commit", "--quiet", "-am", "two");
    yield* git(author, "push", "--quiet", "origin", "main");
    return yield* head(author);
  });
  return { clone, repository, publish };
});

describe("gitPatchRepository", () => {
  it.live("fast-forwards to origin's branch, and says when it's already there", () =>
    Effect.gen(function* () {
      const { clone, repository, publish } = yield* published;
      const first = yield* head(clone);
      const same = yield* repository.pull("main");
      const second = yield* publish;
      const moved = yield* repository.pull("main");
      expect([same, moved, yield* head(clone)]).toEqual([
        { from: first, to: first },
        { from: first, to: second },
        second,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("refuses, changing nothing, when the clone isn't on the branch", () =>
    Effect.gen(function* () {
      const { clone, repository, publish } = yield* published;
      yield* git(clone, "checkout", "--quiet", "-b", "feature");
      const before = yield* head(clone);
      yield* publish;
      expect([yield* Effect.flip(repository.pull("main")), yield* head(clone)]).toEqual([
        new StepFailed({
          reason: `the patches repository at ${clone} is on feature, not main: switch to main, then update again`,
        }),
        before,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
});
