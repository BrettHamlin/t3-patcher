import { Commit, type LibraryView, PatchId, type PatchManifest, type RunReport } from "@app/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { defaultUserdata, userdataFolder } from "../src/services.ts";
import { buildEnv, outcome, parse, stackLines, stepLine } from "../src/text.ts";

const id = Schema.decodeSync(PatchId);

const manifest = (name: string, title: string): PatchManifest => ({
  id: id(name),
  title,
  summary: "s",
  base: { version: "1.0.0", commit: Schema.decodeSync(Commit)("0".repeat(40)) },
  checks: [],
  journeys: [{ name: "j", proves: "p", run: "true" }],
});

const report = (steps: RunReport["steps"]): RunReport => ({ version: "1.0.0", install: false, steps });

describe("command line", () => {
  it("separates words, valued options and flags", () => {
    const line = parse(["move", "aa", "up", "--userdata", "/u", "--force", "--title", "A title"]);
    expect({ words: line.words, options: [...line.options], flags: [...line.flags] }).toEqual({
      words: ["move", "aa", "up"],
      options: [
        ["userdata", "/u"],
        ["title", "A title"],
      ],
      flags: ["force"],
    });
  });

  it("reads the user data folder from --userdata or --data, else the default under home", () => {
    expect([
      userdataFolder(["status", "--userdata", "/a"], "/d"),
      userdataFolder(["status", "--data", "/b"], "/d"),
      userdataFolder(["status"], defaultUserdata("/home/me")),
    ]).toEqual(["/a", "/b", "/home/me/.t3/userdata/patcher"]);
  });
});

describe("text", () => {
  it("lists the stack in order with on/off and titles", () => {
    const view: LibraryView = {
      stack: { entries: [{ id: id("bb"), enabled: true }, { id: id("aa"), enabled: false }] },
      patches: [manifest("bb", "Second"), manifest("aa", "First")],
    };
    expect(stackLines(view)).toEqual(["1. bb [on] — Second", "2. aa [off] — First"]);
  });

  it("says how a run ended", () => {
    expect([
      outcome(report([{ kind: "source", name: "src", status: "passed", note: "1.0.0" }])),
      outcome(
        report([
          { kind: "patch", name: "aa", status: "failed", note: "conflicts left" },
          { kind: "build", name: "copy", status: "skipped", note: "" },
        ]),
      ),
      outcome(report([{ kind: "build", name: "copy", status: "running", note: "" }])),
    ]).toEqual(["passed", "failed at aa: conflicts left", "unfinished"]);
  });

  it("prints a step with its note when it has one", () => {
    expect([
      stepLine({ kind: "patch", name: "aa", status: "passed", note: "applied" }),
      stepLine({ kind: "build", name: "copy", status: "skipped", note: "" }),
    ]).toEqual(["[passed] patch aa — applied", "[skipped] build copy"]);
  });
});

describe("build environment", () => {
  it("puts the checkout's node_modules/.bin before the given PATH and every cache under the folder", () => {
    expect(buildEnv("/w/build-env", "/tools/node/bin:/usr/bin:/bin").split("\n")).toEqual([
      "# Source from the checkout root. Written by `t3-patcher init`; keeps the build's caches under $BE.",
      "BE='/w/build-env'",
      `export PATH="$PWD/node_modules/.bin":'/tools/node/bin:/usr/bin:/bin'`,
      `export TMPDIR="$BE/tmp"`,
      `export XDG_CACHE_HOME="$BE/xdg-cache"`,
      `export ELECTRON_CACHE="$BE/electron-cache"`,
      `export ELECTRON_BUILDER_CACHE="$BE/electron-builder-cache"`,
      `export pnpm_config_store_dir="$BE/pnpm-store"`,
      `export pnpm_config_cache_dir="$BE/pnpm-cache"`,
      `export CARGO_HOME="$BE/cargo-home"`,
      `export npm_config_cache="$BE/npm-cache"`,
      `export COREPACK_HOME="$BE/corepack"`,
      `mkdir -p "$TMPDIR" "$XDG_CACHE_HOME" "$ELECTRON_CACHE" "$ELECTRON_BUILDER_CACHE" "$pnpm_config_store_dir" "$pnpm_config_cache_dir" "$CARGO_HOME" "$npm_config_cache" "$COREPACK_HOME"`,
      "",
    ]);
  });

  it("quotes folders so the shell takes them literally", () => {
    expect(buildEnv("/it's here/$HOME", "/a b").split("\n").slice(1, 3)).toEqual([
      `BE='/it'\\''s here/$HOME'`,
      `export PATH="$PWD/node_modules/.bin":'/a b'`,
    ]);
  });
});
