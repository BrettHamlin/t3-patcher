import { Source } from "@app/apply";
import { StepFailed } from "@app/contracts";
import { gitSource } from "@app/system";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { applyElsewhere, exists, git, PATCHED, read, sh, temporary, upstream, V11, write } from "./support/repo.ts";

/** A temporary folder with the upstream repository, and a Source over it with its work folder in `<root>/work`. */
const setup = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = yield* temporary;
  const repo = yield* upstream(root);
  const work = path.join(root, "work");
  const layer = gitSource({ work, repository: repo.folder }).pipe(Layer.provide(NodeServices.layer));
  const source = yield* Source.useSync((service) => service).pipe(Effect.provide(layer));
  return { root, repo, work, source, join: (...parts: ReadonlyArray<string>) => path.join(...parts) };
});

const status = (folder: string) => sh(folder, "git", ["status", "--porcelain", "--untracked-files=all"]);

describe("gitSource", () => {
  it.live("opens a tag, applies a clean diff and commits it as a diff that reapplies", () =>
    Effect.gen(function* () {
      const { root, repo, work, source, join } = yield* setup;
      const workspace = yield* source.open("v1.1.0", "main");
      const conflicts = yield* workspace.apply(repo.clean);
      const diff = yield* workspace.commit("other");
      expect({ path: workspace.path, base: workspace.base, conflicts, diff }).toEqual({
        path: join(work, "slots", "main"),
        base: repo.v11,
        conflicts: [],
        diff: repo.clean,
      });
      expect(yield* applyElsewhere(join(root, "check"), repo.folder, "v1.1.0", diff, "other.txt")).toBe("left\nchanged\n");
      expect(yield* status(workspace.path)).toBe("");
      const head = (yield* sh(workspace.path, "git", ["rev-parse", "HEAD"])).trim();
      const kept = yield* sh(join(work, "upstream.git"), "git", ["rev-parse", `refs/t3-patcher/kept/${head}`]);
      expect(kept.trim()).toBe(head);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("leaves conflict markers with nothing unmerged in the index, then commits the resolution", () =>
    Effect.gen(function* () {
      const { root, repo, source, join } = yield* setup;
      const workspace = yield* source.open("v1.1.0", "main");
      const a = join(workspace.path, "a.txt");
      const applied = yield* workspace.apply(repo.conflicting);
      expect(applied).toEqual(["a.txt"]);
      expect(yield* read(a)).toBe("one\n<<<<<<< ours\ntwo upstream\n=======\ntwo patched\n>>>>>>> theirs\nthree\n");
      expect(yield* sh(workspace.path, "git", ["ls-files", "--unmerged"])).toBe("");
      expect(yield* status(workspace.path)).toBe(" M a.txt\n?? new.txt\n");
      expect(yield* workspace.conflicts).toEqual(["a.txt"]);

      yield* write(a, "one\ntwo upstream, patched\nthree\n");
      expect(yield* workspace.conflicts).toEqual([]);
      const diff = yield* workspace.commit("resolved");
      expect(yield* status(workspace.path)).toBe("");
      expect(yield* applyElsewhere(join(root, "check-a"), repo.folder, "v1.1.0", diff, "a.txt")).toBe(
        "one\ntwo upstream, patched\nthree\n",
      );
      expect(yield* applyElsewhere(join(root, "check-new"), repo.folder, "v1.1.0", diff, "new.txt")).toBe("new\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("falls back to .rej files when the repository lacks the diff's base blobs", () =>
    Effect.gen(function* () {
      const { repo, source, join } = yield* setup;
      const unknown = repo.conflicting.replace(/^index [0-9a-f]+\.\.[0-9a-f]+/gm, `index ${"1".repeat(40)}..${"2".repeat(40)}`);
      const workspace = yield* source.open("v1.1.0", "main");
      expect(yield* workspace.apply(unknown)).toEqual(["a.txt"]);
      expect(yield* workspace.conflicts).toEqual(["a.txt"]);
      expect(yield* status(workspace.path)).toBe("?? a.txt.rej\n?? new.txt\n");
      expect({ a: yield* read(join(workspace.path, "a.txt")), added: yield* read(join(workspace.path, "new.txt")) }).toEqual({
        a: V11,
        added: "new\n",
      });

      yield* write(join(workspace.path, "a.txt"), PATCHED);
      expect(yield* workspace.conflicts).toEqual(["a.txt"]);
      const diff = yield* workspace.commit("by hand");
      expect(yield* status(workspace.path)).toBe("");
      expect(yield* exists(join(workspace.path, "a.txt.rej"))).toBe(false);
      expect(diff.split("\n").filter((line) => line.startsWith("diff --git"))).toEqual([
        "diff --git a/a.txt b/a.txt",
        "diff --git a/new.txt b/new.txt",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("pending is the uncommitted changes, new files included, and empty when there are none", () =>
    Effect.gen(function* () {
      const { repo, source } = yield* setup;
      const workspace = yield* source.open("v1.0.0", "main");
      const none = yield* workspace.pending;
      expect(yield* workspace.apply(repo.conflicting)).toEqual([]);
      expect({ none, some: yield* workspace.pending }).toEqual({ none: "", some: repo.conflicting });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("existing returns the slot as it is, with the base it was opened at and the version it was marked for", () =>
    Effect.gen(function* () {
      const { repo, work, source, join } = yield* setup;
      expect(yield* Effect.flip(source.existing("main"))).toEqual(
        new StepFailed({ reason: "no workspace main; open it first" }),
      );
      const opened = yield* source.open("v1.0.0", "main");
      yield* opened.apply(repo.clean);
      yield* opened.commit("one");
      yield* opened.markReady("1.0.0");
      yield* write(join(opened.path, "draft.txt"), "draft\n");
      const { workspace: again, version } = yield* source.existing("main");
      expect({ path: again.path, base: again.base, version, pending: yield* again.pending }).toEqual({
        path: join(work, "slots", "main"),
        base: repo.v1,
        version: "1.0.0",
        pending: [
          "diff --git a/draft.txt b/draft.txt",
          "new file mode 100644",
          "index 0000000000000000000000000000000000000000..f3d43775e65ac68c0589a8961c9e665ee8436944",
          "--- /dev/null",
          "+++ b/draft.txt",
          "@@ -0,0 +1 @@",
          "+draft",
          "",
        ].join("\n"),
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("existing fails until the slot is marked ready, and again once it's reopened or its HEAD moves", () =>
    Effect.gen(function* () {
      const { repo, source } = yield* setup;
      const notReady = new StepFailed({ reason: "workspace main isn't ready: open it again" });
      const opened = yield* source.open("v1.0.0", "main");
      const before = yield* Effect.flip(source.existing("main"));
      yield* opened.markReady("1.0.0");
      const marked = (yield* source.existing("main")).version;
      yield* opened.apply(repo.clean);
      yield* opened.commit("moved");
      const moved = yield* Effect.flip(source.existing("main"));
      yield* opened.markReady("1.0.0");
      yield* source.open("v1.1.0", "main");
      const reopened = yield* Effect.flip(source.existing("main"));
      expect({ before, marked, moved, reopened }).toEqual({ before: notReady, marked: "1.0.0", moved: notReady, reopened: notReady });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("fails, naming the files, when the .rej fallback skips a file the diff changes", () =>
    Effect.gen(function* () {
      const { repo, source } = yield* setup;
      yield* git(repo.folder, "rm", "--quiet", "other.txt");
      yield* git(repo.folder, "commit", "--quiet", "-m", "v1.2.0");
      yield* git(repo.folder, "tag", "v1.2.0");
      const unknown = (repo.conflicting + repo.clean).replace(
        /^index [0-9a-f]+\.\.[0-9a-f]+/gm,
        `index ${"1".repeat(40)}..${"2".repeat(40)}`,
      );
      const workspace = yield* source.open("v1.2.0", "main");
      expect(yield* Effect.flip(workspace.apply(unknown))).toEqual(
        new StepFailed({
          reason: "the diff doesn't apply: error: other.txt: No such file or directory",
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("fails, naming the files, when a three-way merge leaves a conflict with no markers to resolve", () =>
    Effect.gen(function* () {
      const { repo, source, join } = yield* setup;
      const data = join(repo.folder, "data.bin");
      yield* write(data, "head\0base\n");
      yield* git(repo.folder, "add", "data.bin");
      yield* git(repo.folder, "commit", "--quiet", "-m", "v2.0.0");
      yield* write(data, "head\0patched\n");
      const diff = yield* git(repo.folder, "diff", "--binary", "--full-index", "HEAD");
      yield* write(data, "head\0upstream\n");
      yield* git(repo.folder, "commit", "--quiet", "-am", "v2.1.0");
      yield* git(repo.folder, "tag", "v2.1.0");
      const workspace = yield* source.open("v2.1.0", "main");
      expect(yield* Effect.flip(workspace.apply(diff))).toEqual(
        new StepFailed({ reason: "can't merge data.bin (binary or no text conflict); change the patch by hand" }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("reopening a slot resets and cleans it but keeps ignored files", () =>
    Effect.gen(function* () {
      const { repo, source, join } = yield* setup;
      const first = yield* source.open("v1.0.0", "main");
      yield* write(join(first.path, "ignored", "kept.txt"), "kept\n");
      yield* write(join(first.path, "stray.txt"), "stray\n");
      yield* first.apply(repo.conflicting);
      yield* first.commit("patched");
      yield* write(join(first.path, "other.txt"), "edited\n");
      const second = yield* source.open("v1.1.0", "main");
      expect({
        path: second.path === first.path,
        base: second.base,
        ignored: yield* read(join(second.path, "ignored", "kept.txt")),
        stray: yield* exists(join(second.path, "stray.txt")),
        a: yield* read(join(second.path, "a.txt")),
        status: yield* status(second.path),
      }).toEqual({ path: true, base: repo.v11, ignored: "kept\n", stray: false, a: V11, status: "" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("fetches tags made upstream since the mirror was cloned", () =>
    Effect.gen(function* () {
      const { repo, source } = yield* setup;
      yield* source.open("v1.0.0", "main");
      yield* sh(repo.folder, "git", ["tag", "v1.2.0", repo.v1]);
      const later = yield* source.open("v1.2.0", "other");
      expect(later.base).toBe(repo.v1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("fails with a readable reason when the tag doesn't exist", () =>
    Effect.gen(function* () {
      const { repo, source } = yield* setup;
      expect(yield* Effect.flip(source.open("v9.9.9", "main"))).toEqual(
        new StepFailed({ reason: `no tag v9.9.9 in ${repo.folder}` }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
});
