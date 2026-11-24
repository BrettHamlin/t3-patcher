import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vite-plus/test";

import { linkElectronCache } from "../src/services.ts";

/** In a new temporary folder standing for home: run `use` with it, the Electron cache folder and the work cache. */
const inHome = <A, E>(
  use: (home: string, link: string, cache: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
        const path = yield* Path.Path;
        return yield* use(home, path.join(home, "Library", "Caches", "electron"), path.join(home, "work", "electron-cache"));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

describe("linkElectronCache", () => {
  it("links the Electron download cache to the work cache when there is none, so downloads land there", async () => {
    const seen = await inHome((home, link, cache) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const said = yield* linkElectronCache(home, cache);
        yield* fs.writeFileString(`${link}/electron.zip`, "zip");
        const found = { said, target: yield* fs.readLink(link), landed: yield* fs.readFileString(`${cache}/electron.zip`) };
        return { found, link, cache };
      }),
    );
    expect(seen.found).toEqual({
      said: `electron download cache: linked ${seen.link} -> ${seen.cache}`,
      target: seen.cache,
      landed: "zip",
    });
  });

  it("keeps a link that is already there", async () => {
    const seen = await inHome((home, link, cache) =>
      Effect.gen(function* () {
        yield* linkElectronCache(home, cache);
        return { said: yield* linkElectronCache(home, cache), link, cache };
      }),
    );
    expect(seen.said).toEqual(`electron download cache: ${seen.link} -> ${seen.cache} (kept)`);
  });

  it("leaves a real folder and its files alone, and says how to move it", async () => {
    const seen = await inHome((home, link, cache) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(link, { recursive: true });
        yield* fs.writeFileString(`${link}/electron.zip`, "zip");
        const said = yield* linkElectronCache(home, cache);
        return { said, kept: yield* fs.readFileString(`${link}/electron.zip`), linked: yield* fs.readLink(link).pipe(Effect.isSuccess), link, cache };
      }),
    );
    expect({ said: seen.said, kept: seen.kept, linked: seen.linked }).toEqual({
      said: `electron download cache: ${seen.link} is a folder on this drive; move its contents to ${seen.cache}, delete it, and run init --force to link it`,
      kept: "zip",
      linked: false,
    });
  });
});
