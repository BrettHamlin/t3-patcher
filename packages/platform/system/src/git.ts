import { Commit, StepFailed } from "@app/contracts";
import { Source, type Workspace } from "@app/apply";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { couldnt, lastLines, run, stepFailed } from "./process.ts";

const AUTHOR = ["-c", "user.name=t3-patcher", "-c", "user.email=t3-patcher@localhost", "-c", "commit.gpgsign=false"] as const;
// Diffs others apply: the standard a/ b/ prefixes and no colour, whatever the user's git config says.
const DIFF = ["--binary", "--full-index", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"] as const;
const ENV = { GIT_TERMINAL_PROMPT: "0" } as const;

const paths = (output: string): ReadonlyArray<string> => output.split("\0").filter((entry) => entry !== "");
const sortedUnique = (entries: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(entries)].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const slotRef = (slot: string): string => `refs/t3-patcher/slots/${slot}`;
const hasMarkers = (content: string): boolean =>
  content.split("\n").some((line) => line.startsWith("<<<<<<< ") || line.startsWith(">>>>>>> "));
// `git apply` error lines that don't name a file with a .rej (a rejected hunk's "while searching for:" names none):
// changes it skipped rather than rejected.
const unaccounted = (stderr: string, rejects: ReadonlyArray<string>): ReadonlyArray<string> =>
  stderr
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("error: ") &&
        line !== "error: while searching for:" &&
        !rejects.some((name) => line.includes(name)),
    );

/**
 * The app's source from git: a bare mirror of `repository` at `<work>/upstream.git`, and each slot a worktree of it
 * at `<work>/slots/<slot>`.
 */
export const gitSource = (input: {
  readonly work: string;
  readonly repository: string;
}): Layer.Layer<Source, never, ChildProcessSpawner | FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Source)(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const mirror = path.join(input.work, "upstream.git");
      const slots = path.join(input.work, "slots");
      // One open at a time: they share the mirror.
      const opening = yield* Semaphore.make(1);

      const attempt = (cwd: string, args: ReadonlyArray<string>) => run(spawner, "git", args, { cwd, env: ENV });
      const git = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<string, StepFailed> =>
        attempt(cwd, args).pipe(
          Effect.flatMap((output) =>
            output.code === 0
              ? Effect.succeed(output.stdout)
              : Effect.fail(
                  stepFailed(
                    `git ${args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? ""} failed (exit ${output.code}): ${lastLines(output.stderr === "" ? output.stdout : output.stderr)}`,
                  ),
                ),
          ),
        );
      const commitOf = (cwd: string, revision: string): Effect.Effect<Commit, StepFailed> =>
        git(cwd, ["rev-parse", "--verify", "--quiet", revision]).pipe(
          Effect.flatMap((sha) => Schema.decodeEffect(Commit)(sha.trim())),
          Effect.mapError(() => stepFailed(`no commit ${revision}`)),
        );

      const readyFile = (slot: string): string => path.join(slots, `${slot}.ready`);
      const head = (folder: string) => commitOf(folder, "HEAD");

      const workspace = (folder: string, base: Commit, ready: string): Workspace => {
        const untracked = git(folder, ["ls-files", "--others", "--exclude-standard", "-z"]).pipe(Effect.map(paths));
        const unmerged = git(folder, ["diff", "--name-only", "--diff-filter=U", "-z"]).pipe(Effect.map(paths));
        const rejected = untracked.pipe(
          Effect.map((files) => files.filter((name) => name.endsWith(".rej")).map((name) => name.slice(0, -4))),
        );
        const withMarkers = Effect.fn("Workspace.withMarkers")(function* (candidates: ReadonlyArray<string>) {
          const found: Array<string> = [];
          for (const name of candidates) {
            const content = yield* fs.readFileString(path.join(folder, name)).pipe(Effect.orElseSucceed(() => ""));
            if (hasMarkers(content)) found.push(name);
          }
          return found;
        });
        const marked = Effect.gen(function* () {
          const changed = paths(yield* git(folder, ["diff", "--name-only", "--no-renames", "-z", "HEAD"]));
          return yield* withMarkers(sortedUnique([...changed, ...(yield* untracked)]));
        });
        const addAll = git(folder, ["add", "-A"]);
        return {
          path: folder,
          base,
          apply: Effect.fn("Workspace.apply")(function* (diff: string) {
            if (diff.trim() === "") return [];
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const temporary = yield* fs
                  .makeTempDirectoryScoped({ prefix: "t3-patcher-" })
                  .pipe(Effect.mapError(couldnt("make a temporary folder")));
                const patch = path.join(temporary, "changes.patch");
                yield* fs.writeFileString(patch, diff).pipe(Effect.mapError(couldnt(`write ${patch}`)));
                const merged = yield* attempt(folder, ["apply", "--3way", "--whitespace=nowarn", patch]);
                if (merged.code === 0) return [];
                const conflicted = yield* unmerged;
                if (conflicted.length > 0) {
                  const textual = yield* withMarkers(conflicted);
                  const unmarked = sortedUnique(conflicted.filter((name) => !textual.includes(name)));
                  if (unmarked.length > 0) {
                    return yield* stepFailed(
                      `can't merge ${unmarked.join(", ")} (binary or no text conflict); change the patch by hand`,
                    );
                  }
                  // Keep the conflict markers in the files, but leave the index as at HEAD, with nothing unmerged.
                  yield* git(folder, ["reset", "-q"]);
                  return sortedUnique(conflicted);
                }
                // No three-way merge (e.g. the repository lacks the diff's base blobs): apply what fits, rest to .rej.
                const partial = yield* attempt(folder, ["apply", "--reject", "--whitespace=nowarn", patch]);
                const rejects = yield* rejected;
                if (partial.code !== 0 && rejects.length === 0) {
                  return yield* stepFailed(`the diff doesn't apply: ${lastLines(partial.stderr)}`);
                }
                // A file-level error (e.g. the file is gone) skips that file without a .rej: the change would be lost.
                const skipped = unaccounted(partial.stderr, rejects);
                if (skipped.length > 0) {
                  return yield* stepFailed(`the diff doesn't apply: ${skipped.join("; ")}`);
                }
                return sortedUnique(rejects);
              }),
            );
          }),
          conflicts: Effect.gen(function* () {
            return sortedUnique([...(yield* unmerged), ...(yield* marked), ...(yield* rejected)]);
          }),
          commit: Effect.fn("Workspace.commit")(function* (message: string) {
            for (const name of yield* untracked) {
              if (name.endsWith(".orig") || name.endsWith(".rej")) {
                yield* fs.remove(path.join(folder, name)).pipe(Effect.mapError(couldnt(`remove ${name}`)));
              }
            }
            yield* addAll;
            yield* git(folder, [
              ...AUTHOR,
              "commit",
              "--quiet",
              "--no-verify",
              "--allow-empty",
              "--allow-empty-message",
              "-m",
              message,
            ]);
            const sha = yield* commitOf(folder, "HEAD");
            yield* git(folder, ["update-ref", `refs/t3-patcher/kept/${sha}`, sha]);
            return yield* git(folder, ["diff", ...DIFF, "HEAD~1", "HEAD"]);
          }),
          pending: Effect.gen(function* () {
            yield* addAll;
            return yield* git(folder, ["diff", "--cached", ...DIFF, "HEAD"]);
          }),
          markReady: Effect.fn("Workspace.markReady")(function* (version: string) {
            const sha = yield* head(folder);
            yield* fs.writeFileString(ready, `${version}\n${sha}\n`).pipe(Effect.mapError(couldnt(`write ${ready}`)));
          }),
        };
      };

      const isWorktree = (folder: string) =>
        fs.exists(path.join(folder, ".git")).pipe(Effect.mapError(couldnt(`read ${folder}`)));

      const updateMirror = Effect.gen(function* () {
        if (!(yield* fs.exists(path.join(mirror, "HEAD")).pipe(Effect.mapError(couldnt(`read ${mirror}`))))) {
          yield* fs.makeDirectory(input.work, { recursive: true }).pipe(Effect.mapError(couldnt(`make ${input.work}`)));
          yield* git(input.work, ["clone", "--bare", "--quiet", input.repository, mirror]).pipe(
            Effect.mapError((error) => stepFailed(`couldn't clone ${input.repository}: ${error.reason}`)),
          );
        }
        // Offline is fine when the tag is already here; `open` says why if it isn't.
        return yield* attempt(mirror, ["fetch", "--quiet", "--tags", "--force", "origin"]);
      });

      return {
        open: Effect.fn("Source.open")(function* (tag: string, slot: string) {
          return yield* opening.withPermit(
            Effect.gen(function* () {
              const ready = readyFile(slot);
              yield* fs.remove(ready, { force: true }).pipe(Effect.mapError(couldnt(`remove ${ready}`)));
              const fetched = yield* updateMirror;
              const base = yield* commitOf(mirror, `refs/tags/${tag}^{commit}`).pipe(
                Effect.mapError(() =>
                  stepFailed(
                    fetched.code === 0
                      ? `no tag ${tag} in ${input.repository}`
                      : `no tag ${tag} in ${input.repository} (couldn't fetch: ${lastLines(fetched.stderr, 5)})`,
                  ),
                ),
              );
              const folder = path.join(slots, slot);
              if (!(yield* isWorktree(folder))) {
                yield* fs.makeDirectory(slots, { recursive: true }).pipe(Effect.mapError(couldnt(`make ${slots}`)));
                yield* git(mirror, ["worktree", "prune"]);
                yield* git(mirror, ["worktree", "add", "--quiet", "--detach", folder, base]);
              }
              yield* git(folder, ["checkout", "--quiet", "--force", "--detach", base]);
              yield* git(folder, ["reset", "--quiet", "--hard"]);
              yield* git(folder, ["clean", "-ffdq"]);
              yield* git(mirror, ["update-ref", slotRef(slot), base]);
              return workspace(folder, base, ready);
            }),
          );
        }),
        existing: Effect.fn("Source.existing")(function* (slot: string) {
          const folder = path.join(slots, slot);
          const missing = stepFailed(`no workspace ${slot}; open it first`);
          if (!(yield* isWorktree(folder))) return yield* missing;
          const base = yield* commitOf(folder, slotRef(slot)).pipe(Effect.mapError(() => missing));
          const ready = readyFile(slot);
          const notReady = stepFailed(`workspace ${slot} isn't ready: open it again`);
          const [version = "", sha = ""] = (yield* fs
            .readFileString(ready)
            .pipe(Effect.mapError(() => notReady))).split("\n");
          if (version === "" || sha !== (yield* head(folder))) return yield* notReady;
          return { workspace: workspace(folder, base, ready), version };
        }),
      };
    }),
  );
