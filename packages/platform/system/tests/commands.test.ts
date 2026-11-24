import { Resolver, Shell } from "@app/apply";
import { Commit, PatchId, StepFailed } from "@app/contracts";
import { commandResolver, commandShell } from "@app/system";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { read, temporary } from "./support/repo.ts";

const shellIn = (logs: string) =>
  Shell.useSync((service) => service).pipe(Effect.provide(commandShell(logs).pipe(Layer.provide(NodeServices.layer))));
const resolverWith = (command: string, logs: string) =>
  Resolver.useSync((service) => service).pipe(
    Effect.provide(commandResolver({ command, logs }).pipe(Layer.provide(NodeServices.layer))),
  );
const numbers = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i)).join("\n");

describe("commandShell", () => {
  it.live("runs the command in the folder with the extra environment, logging stdout and stderr", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temporary;
      const logs = path.join(root, "logs");
      const shell = yield* shellIn(logs);
      yield* shell.run(root, { name: "say hello/there", run: 'echo "$GREETING from $(pwd -P)"; echo oops >&2' }, { GREETING: "hi" });
      expect(yield* read(path.join(logs, "say-hello-there.log"))).toBe(`hi from ${root}\noops\n`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("fails with the exit code and the last 20 lines of output", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temporary;
      const logs = path.join(root, "logs");
      const shell = yield* shellIn(logs);
      const failed = yield* Effect.flip(shell.run(root, { name: "count", run: "seq 1 25; exit 3" }, {}));
      expect(failed).toEqual(
        new StepFailed({ reason: `count failed (exit 3; log ${path.join(logs, "count.log")}): ${numbers(6, 25)}` }),
      );
      expect(yield* read(path.join(logs, "count.log"))).toBe(`${numbers(1, 25)}\n`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
});

describe("commandResolver", () => {
  const manifest = Effect.gen(function* () {
    return {
      id: yield* Schema.decodeEffect(PatchId)("dark-mode"),
      title: "Dark mode",
      summary: "Adds a dark theme to the settings.",
      version: 1,
      base: { version: "1.0.0", commit: yield* Schema.decodeEffect(Commit)("a".repeat(40)) },
      checks: [],
      journeys: [{ name: "dark", proves: "the theme switches", run: "true" }],
    };
  }).pipe(Effect.orDie);

  it.live("runs the command in the workspace with T3_PATCHER_PROMPT naming the prompt file", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temporary;
      const logs = path.join(root, "logs");
      const resolver = yield* resolverWith('echo "$T3_PATCHER_PROMPT" > seen.txt; pwd -P >> seen.txt', logs);
      yield* resolver.resolve(root, yield* manifest, ["a.txt", "src/b.ts"]);
      const prompt = path.join(logs, "resolve-dark-mode.md");
      expect(yield* read(path.join(root, "seen.txt"))).toBe(`${prompt}\n${root}\n`);
      const lines = (yield* read(prompt)).split("\n");
      expect(lines.filter((line) => line.startsWith("- "))).toEqual([
        "- Name: dark-mode",
        "- Title: Dark mode",
        `- Made for version 1.0.0 (commit ${"a".repeat(40)})`,
        "- a.txt",
        "- src/b.ts",
        "- Resolve each file so that upstream's changes are kept AND the patch's intent is preserved.",
        "- Remove every conflict marker, and delete the `.rej` files once their changes are in.",
        "- Change nothing else.",
        "- Don't commit.",
      ]);
      expect(lines.filter((line) => line === "Adds a dark theme to the settings.")).toEqual(["Adds a dark theme to the settings."]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("fails with the exit code and the end of the output", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temporary;
      const logs = path.join(root, "logs");
      const resolver = yield* resolverWith("echo gave up; exit 2", logs);
      const failed = yield* Effect.flip(resolver.resolve(root, yield* manifest, ["a.txt"]));
      expect(failed).toEqual(
        new StepFailed({ reason: `resolver failed (exit 2; log ${path.join(logs, "resolve-dark-mode.log")}): gave up` }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
});
