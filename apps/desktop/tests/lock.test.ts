import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vite-plus/test";

import { Busy, locked } from "../src/services.ts";

/** In a new temporary work folder: run `use` with it and the lock file's path. */
const inWork = <A, E>(
  use: (work: string, lock: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const work = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
        return yield* use(work, (yield* Path.Path).join(work, "patcher.lock"));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

/** A pid no process has: above the largest pid macOS and Linux hand out by default. */
const ENDED = 99_999_999;

describe("locked", () => {
  it("holds the lock file with this pid while running, and removes it after, even on failure", async () => {
    const seen = await inWork((work, lock) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const during = yield* locked(work, fs.readFileString(lock));
        const failed = yield* locked(work, Effect.fail("broke")).pipe(Effect.exit);
        return { during, failed: Exit.isFailure(failed), after: yield* fs.exists(lock) };
      }),
    );
    expect(seen).toEqual({ during: `${process.pid}\n`, failed: true, after: false });
  });

  it("refuses while a live process holds it, and leaves its lock", async () => {
    const seen = await inWork((work, lock) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(lock, `${process.ppid}\n`);
        const refused = yield* locked(work, Effect.succeed("ran")).pipe(Effect.flip);
        return { refused, kept: yield* fs.readFileString(lock) };
      }),
    );
    expect(seen).toEqual({ refused: new Busy({ pid: process.ppid }), kept: `${process.ppid}\n` });
    expect(seen.refused.message).toEqual(`another run is going (pid ${process.ppid})`);
  });

  it("takes over a lock whose process has ended", async () => {
    const seen = await inWork((work, lock) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(lock, `${ENDED}\n`);
        const ran = yield* locked(work, Effect.succeed("ran"));
        return { ran, after: yield* fs.exists(lock) };
      }),
    );
    expect(seen).toEqual({ ran: "ran", after: false });
  });
});
