import type { PatchManifest } from "@app/contracts";
import { Resolver, Shell } from "@app/apply";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { couldnt, lastLines, runLogged, stepFailed } from "./process.ts";

const fileName = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, "-");

/** Runs commands with /bin/sh; each command's output goes to `<logs>/<command name>.log`. */
export const commandShell = (
  logs: string,
  defaults: Readonly<Record<string, string>> = {},
): Layer.Layer<Shell, never, ChildProcessSpawner | FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Shell)(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return {
        run: Effect.fn("Shell.run")(function* (folder, command, env) {
          yield* fs.makeDirectory(logs, { recursive: true }).pipe(Effect.mapError(() => stepFailed(`couldn't make ${logs}`)));
          const log = path.join(logs, `${fileName(command.name)}.log`);
          const result = yield* runLogged(spawner, fs, { folder, script: command.run, env, defaults, log });
          if (result.code !== 0) {
            return yield* stepFailed(`${command.name} failed (exit ${result.code}; log ${log}): ${lastLines(result.output)}`);
          }
        }),
      };
    }),
  );

const prompt = (patch: PatchManifest, files: ReadonlyArray<string>): string =>
  [
    `# Resolve the conflicts of patch "${patch.title}"`,
    "",
    "This folder is the app's source at a newer version than the patch was made for. The patch below was applied",
    "over it, and some of its changes didn't fit.",
    "",
    "## The patch",
    "",
    `- Name: ${patch.id}`,
    `- Title: ${patch.title}`,
    `- Made for version ${patch.base.version} (commit ${patch.base.commit})`,
    "",
    patch.summary,
    "",
    "## Files with conflicts",
    "",
    "Each has conflict markers (<<<<<<< / ======= / >>>>>>>), or a `.rej` file beside it holding the changes that",
    "didn't apply.",
    "",
    ...files.map((file) => `- ${file}`),
    "",
    "## What to do",
    "",
    "- Resolve each file so that upstream's changes are kept AND the patch's intent is preserved.",
    "- Remove every conflict marker, and delete the `.rej` files once their changes are in.",
    "- Change nothing else.",
    "- Don't commit.",
    "",
  ].join("\n");

/** Resolves conflicts by running `command` (an agent) with /bin/sh in the workspace; $T3_PATCHER_PROMPT names the task. */
export const commandResolver = (input: {
  readonly command: string;
  readonly logs: string;
}): Layer.Layer<Resolver, never, ChildProcessSpawner | FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Resolver)(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return {
        resolve: Effect.fn("Resolver.resolve")(function* (workspace, patch, files) {
          yield* fs.makeDirectory(input.logs, { recursive: true }).pipe(Effect.mapError(couldnt(`make ${input.logs}`)));
          const file = path.join(input.logs, `resolve-${patch.id}.md`);
          yield* fs.writeFileString(file, prompt(patch, files)).pipe(Effect.mapError(couldnt(`write ${file}`)));
          const log = path.join(input.logs, `resolve-${patch.id}.log`);
          const result = yield* runLogged(spawner, fs, {
            folder: workspace,
            script: input.command,
            env: { T3_PATCHER_PROMPT: file },
            log,
          });
          if (result.code !== 0) {
            return yield* stepFailed(`resolver failed (exit ${result.code}; log ${log}): ${lastLines(result.output)}`);
          }
        }),
      };
    }),
  );
