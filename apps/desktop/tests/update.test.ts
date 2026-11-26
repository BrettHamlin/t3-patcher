import { Progress } from "@app/apply";
import type { InstalledRecord, RunReport, Step } from "@app/contracts";
import { defaultSettings, loadInstalled, loadReport, loadSettings, saveSettings } from "@app/files";
import { commitUnpublished, gitIn, headOf, installedFile, publish, publishedWorld, type World } from "@app/fixtures";
import { library, saveStack, StackStore } from "@app/stack";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  applyStack,
  consumePrePulledEnv,
  decodePrePulled,
  PREPULLED_ENV,
  runPublishedUpdate,
  type RecordSource,
  servicesFor,
  stackServices,
  updateCommand,
  updateSource,
  updateStack,
  type UpdateRequest,
} from "../src/services.ts";

const line = (step: Step): string => `${step.status} ${step.kind} ${step.name} — ${step.note}`;

const sourceFor = (data: string): RecordSource => ({
  feed: "https://feed.example/patches/index.json",
  update: {
    command: ["/usr/bin/python3", "/repo/scripts/patcher.py", "update", "--userdata", data],
    cwd: "/repo",
    path: "/opt/homebrew/bin:/usr/bin:/bin",
  },
});

interface Seen {
  readonly report: RunReport;
  /** The run report as Progress saw it, each time. */
  readonly reports: ReadonlyArray<RunReport>;
  readonly lastRun: Option.Option<RunReport>;
  readonly installed: Option.Option<InstalledRecord>;
  readonly stack: ReadonlyArray<string>;
}

/** Run `operation` with the real services over the world in `data`, recording each report. */
const runIn = (
  data: string,
  operation: "update" | "apply",
  request: UpdateRequest = {},
): Promise<Seen> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const settings = yield* loadSettings(data);
      const reports = yield* Ref.make<ReadonlyArray<RunReport>>([]);
      const progress = Layer.succeed(Progress)({ report: (report) => Ref.update(reports, (all) => [...all, report]) });
      const services = Layer.mergeAll(servicesFor(data, settings), progress, NodeServices.layer);
      const report =
        operation === "update"
          ? yield* updateStack(data, settings, request, sourceFor(data)).pipe(Effect.provide(services))
          : yield* applyStack(data, settings, true, sourceFor(data)).pipe(Effect.provide(services));
      const stack = yield* StackStore.use((store) => store.load).pipe(Effect.provide(services));
      return {
        report,
        reports: yield* Ref.get(reports),
        lastRun: yield* loadReport(data),
        installed: yield* loadInstalled(data),
        stack: stack.entries.map((entry) => `${entry.id} ${entry.enabled ? "on" : "off"}`),
      };
    }).pipe(Effect.provide(NodeServices.layer)),
  );

/** A new folder (its real path) holding a published world, removed after `use`. */
const inWorld = async <A>(world: World, use: (data: string) => Promise<A>): Promise<A> => {
  const { data, remove } = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const made = yield* fs.realPath(yield* fs.makeTempDirectory({ prefix: "update-" }));
      return { data: made, remove: fs.remove(made, { recursive: true, force: true }) };
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  try {
    await publishedWorld(data, world);
    return await use(data);
  } finally {
    await Effect.runPromise(remove.pipe(Effect.provide(NodeServices.layer)));
  }
};

const short = (sha: string): string => sha.slice(0, 7);

/** The installed record without its time, and whether that time is a valid ISO date. */
const timeless = (record: Option.Option<InstalledRecord>) =>
  Option.map(record, ({ installedAt, ...rest }) => ({ ...rest, timed: !Number.isNaN(Date.parse(installedAt)) }));

const notesOnly = (): World => ({ installed: "1.0.0", patches: ["notes-one"], resolver: "stubborn" });

/** Turn patch `id` on or off in the world's stack, as the patcher's window or `enable`/`disable` would. */
const setOn = (data: string, id: string, on: boolean): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const settings = yield* loadSettings(data);
      const services = stackServices(data, settings);
      const { stack } = yield* library.pipe(Effect.provide(services));
      const next = { entries: stack.entries.map((entry) => (entry.id === id ? { id: entry.id, enabled: on } : entry)) };
      yield* saveStack(next).pipe(Effect.provide(services));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

/** The published clone `update` keeps in the world's work folder. */
const cloneOf = (data: string): string => `${data}/work/published`;

/** A file in the published clone, or "(missing)". */
const cloneFile = async (data: string, file: string): Promise<string> =>
  Effect.runPromise(
    FileSystem.FileSystem.use((fs) =>
      fs.exists(`${cloneOf(data)}/${file}`).pipe(
        Effect.flatMap((found) => (found ? fs.readFileString(`${cloneOf(data)}/${file}`) : Effect.succeed("(missing)"))),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

const writeIn = (file: string, text: string): Promise<void> =>
  Effect.runPromise(FileSystem.FileSystem.use((fs) => fs.writeFileString(file, text)).pipe(Effect.provide(NodeServices.layer)));

describe("update", () => {
  it("clones the published patches, adds new ones on by default, installs the stack and records it, leaving the author's checkout alone", async () => {
    await inWorld(notesOnly(), async (data) => {
      const dev = await headOf(`${data}/repo`);
      await publish(data, [
        { kind: "bump", id: "notes-one", version: 2 },
        { kind: "add", id: "red-color" },
      ]);
      const published = await headOf(`${data}/published.git`);
      const seen = await runIn(data, "update");
      expect(seen.report.steps.map(line)).toEqual([
        `passed pull patches — cloned ${data}/published.git at ${short(published)}`,
        "passed source Fixture source — 1.0.0 (v1.0.0)",
        "passed patch notes-one — applied",
        "passed patch red-color — applied",
        "passed check plist — ",
        "passed check notes-one: check — ",
        "passed check red-color: check — ",
        "passed build copy — ",
        "passed journey notes-one: built — ",
        "passed journey red-color: built — ",
        `passed install install — installed; the previous app is at ${data}/work/backups/Installed-1.0.0-1.app`,
      ]);
      expect(seen.report.updating).toEqual([{ name: "notes-one", from: "1", to: "2" }]);
      expect([seen.lastRun, seen.reports.at(-1), seen.reports[0]]).toEqual([
        Option.some(seen.report),
        seen.report,
        { version: "", install: true, steps: [{ kind: "pull", name: "patches", status: "running", note: "" }] },
      ]);
      expect(seen.stack).toEqual(["notes-one on", "red-color on"]);
      expect(timeless(seen.installed)).toEqual(
        Option.some({
          t3Version: "1.0.0",
          patches: [
            { id: "notes-one", title: "Add notes", summary: "Adds a notes file.", version: 2 },
            { id: "red-color", title: "Red color", summary: "Makes the app red.", version: 1 },
          ],
          feed: "https://feed.example/patches/index.json",
          update: sourceFor(data).update,
          timed: true,
        }),
      );
      expect([
        await headOf(`${data}/repo`),
        await headOf(cloneOf(data)),
        await installedFile(data, "Contents/Resources/notes.txt"),
        await installedFile(data, "Contents/Resources/app.txt"),
      ]).toEqual([dev, published, "one\n", "title: Hello\ncolor: red\n"]);

      const again = await runIn(data, "update");
      expect(again.report.steps[0]).toEqual({
        kind: "pull",
        name: "patches",
        status: "passed",
        note: `up to date at ${short(published)}`,
      });
    });
  });

  it("with --t3, builds that version's tag over the installed one, with no save step, leaving the published patches as published", async () => {
    await inWorld(notesOnly(), async (data) => {
      const head = await headOf(`${data}/published.git`);
      const before = await cloneFile(data, "patches/notes-one/patch.json");
      const seen = await runIn(data, "update", { t3: "1.1.0" });
      expect(seen.report.steps.map(line)).toEqual([
        `passed pull patches — cloned ${data}/published.git at ${short(head)}`,
        "passed source Fixture source — 1.1.0 (v1.1.0)",
        "passed patch notes-one — applied; rebased for 1.1.0",
        "passed check plist — ",
        "passed check notes-one: check — ",
        "passed build copy — ",
        "passed journey notes-one: built — ",
        `passed install install — installed; the previous app is at ${data}/work/backups/Installed-1.0.0-1.app`,
      ]);
      expect([seen.report.version, seen.report.updating]).toEqual([
        "1.1.0",
        [{ name: "Fixture", from: "1.0.0", to: "1.1.0" }],
      ]);
      expect([
        await installedFile(data, "Contents/Resources/app.txt"),
        await installedFile(data, "Contents/Resources/notes.txt"),
        before,
        await cloneFile(data, "patches/notes-one/patch.json"),
        await gitIn(cloneOf(data), "status", "--porcelain"),
        await gitIn(`${data}/repo`, "status", "--porcelain"),
      ]).toEqual([
        "title: Hello\ncolor: green\nsize: large\n",
        "one\n",
        "(missing)",
        await gitIn(`${data}/published.git`, "show", "main:patches/notes-one/patch.json"),
        "",
        "",
      ]);
      expect(Option.map(seen.installed, (record) => record.t3Version)).toEqual(Option.some("1.1.0"));
    });
  });

  it("updates though the author's checkout is on another branch with local changes and commits", async () => {
    await inWorld(notesOnly(), async (data) => {
      await gitIn(`${data}/repo`, "checkout", "--quiet", "-b", "feature");
      await commitUnpublished(`${data}/repo`);
      await writeIn(`${data}/repo/stray.txt`, "stray\n");
      const dev = await headOf(`${data}/repo`);
      await publish(data, [{ kind: "bump", id: "notes-one", version: 2 }]);
      const seen = await runIn(data, "update");
      expect([
        seen.report.steps.at(-1)?.status,
        Option.map(seen.installed, (record) => record.patches),
        await headOf(`${data}/repo`),
        await gitIn(`${data}/repo`, "status", "--porcelain"),
      ]).toEqual([
        "passed",
        Option.some([{ id: "notes-one", title: "Add notes", summary: "Adds a notes file.", version: 2 }]),
        dev,
        "?? stray.txt\n",
      ]);
    });
  });

  it("resets a published clone that can't fast-forward to the published branch", async () => {
    await inWorld(notesOnly(), async (data) => {
      await runIn(data, "update");
      await commitUnpublished(cloneOf(data));
      const edited = await headOf(cloneOf(data));
      await publish(data, [{ kind: "bump", id: "notes-one", version: 2 }]);
      const published = await headOf(`${data}/published.git`);
      const seen = await runIn(data, "update");
      expect([seen.report.steps[0]?.note, seen.report.steps.at(-1)?.status, await headOf(cloneOf(data))]).toEqual([
        `${short(edited)} → ${short(published)} (reset to the published branch)`,
        "passed",
        published,
      ]);
    });
  });

  it("fails at the pull, building and installing nothing, when the patches repository has no origin", async () => {
    await inWorld(notesOnly(), async (data) => {
      await gitIn(`${data}/repo`, "remote", "remove", "origin");
      const seen = await runIn(data, "update");
      const refused: RunReport = {
        version: "",
        install: true,
        steps: [
          {
            kind: "pull",
            name: "patches",
            status: "failed",
            note: `the patches repository at ${data}/repo/patches has no origin: updates come from its origin's main`,
          },
        ],
      };
      expect([seen.report, seen.lastRun, seen.installed, await installedFile(data, "Contents/Resources/notes.txt")]).toEqual([
        refused,
        Option.some(refused),
        Option.none(),
        "(missing)",
      ]);
    });
  });

  it("installs nothing when a step fails, leaving the installed app and record as they were", async () => {
    await inWorld(notesOnly(), async (data) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const settings = yield* loadSettings(data);
          yield* saveSettings(data, { ...settings, target: { ...settings.target, build: [{ name: "copy", run: "exit 7" }] } });
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      await publish(data, [{ kind: "bump", id: "notes-one", version: 2 }]);
      const published = await headOf(`${data}/published.git`);
      const seen = await runIn(data, "update", { t3: "1.1.0", relaunch: 99_999_999 });
      expect(seen.report.steps.map(line)).toEqual([
        `passed pull patches — cloned ${data}/published.git at ${short(published)}`,
        "passed source Fixture source — 1.1.0 (v1.1.0)",
        "passed patch notes-one — applied; rebased for 1.1.0",
        "passed check plist — ",
        "passed check notes-one: check — ",
        `failed build copy — copy failed (exit 7; log ${data}/work/logs/copy.log): `,
        "skipped journey notes-one: built — ",
        "skipped install install — ",
      ]);
      expect([
        await installedFile(data, "Contents/Resources/app.txt"),
        await installedFile(data, "Contents/Resources/notes.txt"),
        seen.installed,
      ]).toEqual(["title: Hello\ncolor: blue\n", "(missing)", Option.none()]);
    });
  });
});

describe("update's list of what it changes", () => {
  it("names an installed patch the published patches no longer have as removed", async () => {
    await inWorld({ installed: "1.0.0", patches: ["notes-one", "red-color"], resolver: "fixing" }, async (data) => {
      await runIn(data, "apply");
      await publish(data, [{ kind: "remove", id: "red-color" }]);
      const seen = await runIn(data, "update");
      expect([seen.report.updating, seen.stack, Option.map(seen.installed, (record) => record.patches)]).toEqual([
        [{ name: "red-color", from: "1", to: "removed" }],
        ["notes-one on"],
        Option.some([{ id: "notes-one", title: "Add notes", summary: "Adds a notes file.", version: 1 }]),
      ]);
    });
  });
});

describe("update's list of what it adds", () => {
  it("names a newly published patch or a patch turned on since the last install as added, while keeping disabled ones off", async () => {
    await inWorld({ installed: "1.0.0", patches: ["notes-one", "notes-two"], resolver: "fixing" }, async (data) => {
      await setOn(data, "notes-two", false);
      await runIn(data, "apply");
      await publish(data, [{ kind: "add", id: "red-color" }]);
      const seen = await runIn(data, "update");
      expect([seen.report.updating, seen.stack, Option.map(seen.installed, (record) => record.patches)]).toEqual([
        [{ name: "red-color", from: "", to: "1" }],
        ["notes-one on", "notes-two off", "red-color on"],
        Option.some([
          { id: "notes-one", title: "Add notes", summary: "Adds a notes file.", version: 1 },
          { id: "red-color", title: "Red color", summary: "Makes the app red.", version: 1 },
        ]),
      ]);
    });
  });
});

describe("updateSource", () => {
  it("runs scripts/patcher.py of the checkout holding the patches folder, and is none when that checkout has none", async () => {
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "source-" }));
          const python = `${root}/bin`;
          yield* fs.makeDirectory(python, { recursive: true });
          yield* fs.writeFileString(`${python}/python3`, "");
          for (const checkout of ["patcher", "patches-only"]) {
            yield* fs.makeDirectory(`${root}/${checkout}/.git`, { recursive: true });
            yield* fs.makeDirectory(`${root}/${checkout}/patches`, { recursive: true });
          }
          yield* fs.makeDirectory(`${root}/patcher/scripts`, { recursive: true });
          yield* fs.writeFileString(`${root}/patcher/scripts/patcher.py`, "");
          const settings = defaultSettings({ patches: `${root}/patcher/patches`, work: `${root}/work` });
          return {
            root,
            withScript: yield* updateSource(settings, "/u", `${python}:/usr/bin`),
            without: yield* updateSource({ ...settings, patches: `${root}/patches-only/patches` }, "/u", python),
          };
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    expect([seen.withScript, seen.without]).toEqual([
      {
        command: [`${seen.root}/bin/python3`, `${seen.root}/patcher/scripts/patcher.py`, "update", "--userdata", "/u"],
        cwd: `${seen.root}/patcher`,
        path: `${seen.root}/bin:/usr/bin`,
      },
      undefined,
    ]);
  });
});

describe("updateCommand", () => {
  it("records the PATH it ran with, each folder once, and the python3 on it; a run with that PATH records the same", async () => {
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "path-" }));
          const tools = `${root}/tools`;
          const python = `${root}/python/bin`;
          yield* fs.makeDirectory(python, { recursive: true });
          yield* fs.makeDirectory(tools, { recursive: true });
          yield* fs.writeFileString(`${python}/python3`, "");
          // As the CLI sees it: the pinned tools first, then the user's PATH.
          const first = yield* updateCommand("/repo", "/u", `${tools}:${python}:/usr/bin:${tools}:/bin`);
          // Run by the app with the recorded PATH, the CLI puts the pinned tools in front again.
          const second = yield* updateCommand("/repo", "/u", `${tools}:${first.path}`);
          return { first, second, python, tools };
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    const expected = {
      command: [`${seen.python}/python3`, "/repo/scripts/patcher.py", "update", "--userdata", "/u"],
      cwd: "/repo",
      path: `${seen.tools}:${seen.python}:/usr/bin:/bin`,
    };
    expect([seen.first, seen.second]).toEqual([expected, expected]);
  });
});

describe("apply --install", () => {
  it("records what it installed, and how to update it", async () => {
    await inWorld(notesOnly(), async (data) => {
      const seen = await runIn(data, "apply");
    expect([seen.report.steps.at(-1)?.status, timeless(seen.installed)]).toEqual([
      "passed",
      Option.some({
        t3Version: "1.0.0",
        patches: [{ id: "notes-one", title: "Add notes", summary: "Adds a notes file.", version: 1 }],
        feed: "https://feed.example/patches/index.json",
        update: sourceFor(data).update,
        timed: true,
      }),
    ]);
    });
  });
});

const HandoffCapture = Schema.Struct({
  cwd: Schema.String,
  argv: Schema.Array(Schema.String),
  path: Schema.String,
  lockHolder: Schema.String,
  cliBundleExists: Schema.Boolean,
  prePulled: Schema.String,
});
const decodeHandoff = Schema.decodeUnknownEffect(Schema.fromJsonString(HandoffCapture));

const commitPublishedScript = async (data: string, scriptBody: string): Promise<string> => {
  const scratch = await Effect.runPromise(
    FileSystem.FileSystem.use((fs) => fs.makeTempDirectory({ directory: data, prefix: "publish-script-" })).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
  await gitIn(data, "clone", "--quiet", `${data}/published.git`, `${scratch}/clone`);
  await Effect.runPromise(
    FileSystem.FileSystem.use((fs) =>
      fs
        .makeDirectory(`${scratch}/clone/scripts`, { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(`${scratch}/clone/scripts/patcher.py`, scriptBody))),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  await gitIn(`${scratch}/clone`, "add", "--all");
  await gitIn(`${scratch}/clone`, "commit", "--quiet", "-m", "Add published patcher script");
  await gitIn(`${scratch}/clone`, "push", "--quiet", "origin", "main");
  return headOf(`${data}/published.git`);
};

describe("runPublishedUpdate self-handoff", () => {
  it("holds patcher.lock through handoff, resolves relative userdata, invalidates stale cli.cjs on commit changes, relaunches from published too, and preserves disabled published-only patches", async () => {
    await inWorld(notesOnly(), async (data) => {
      const devHead = await headOf(`${data}/repo`);
      await publish(data, [
        { kind: "bump", id: "notes-one", version: 2 },
        { kind: "add", id: "red-color" },
      ]);
      // Disable the published-only patch (`red-color`, which `${data}/repo` lacks) in stack.json before updating.
      await Effect.runPromise(
        FileSystem.FileSystem.use((fs) =>
          fs.writeFileString(
            `${data}/stack.json`,
            `${JSON.stringify({ entries: [{ id: "notes-one", enabled: true }, { id: "red-color", enabled: false }] })}\n`,
          ),
        ).pipe(Effect.provide(NodeServices.layer)),
      );

      const capturePath = `${data}/handoff.json`;
      const scriptBody = [
        "import json, os, pathlib, sys",
        `lock = pathlib.Path(${JSON.stringify(`${data}/work/patcher.lock`)})`,
        'cli_bundle = pathlib.Path("apps/desktop/dist/cli.cjs")',
        `pathlib.Path(${JSON.stringify(capturePath)}).write_text(json.dumps({`,
        '  "cwd": os.getcwd(),',
        '  "argv": sys.argv[1:],',
        '  "path": os.environ.get("PATH", ""),',
        '  "lockHolder": lock.read_text().strip() if lock.exists() else "",',
        '  "cliBundleExists": cli_bundle.exists(),',
        `  "prePulled": os.environ.get(${JSON.stringify(PREPULLED_ENV)}, ""),`,
        "}))",
        'print("handed-off stdout")',
      ].join("\n");
      const firstHead = await commitPublishedScript(data, scriptBody);

      const settings = await Effect.runPromise(loadSettings(data).pipe(Effect.provide(NodeServices.layer)));
      const stdout: Array<string> = [];
      const stderr: Array<string> = [];
      const reports: Array<RunReport> = [];
      const progress = Layer.succeed(Progress)({
        report: (report) => Effect.sync(() => void reports.push(report)),
      });
      const services = Layer.mergeAll(servicesFor(data, settings), progress, NodeServices.layer);
      const relativeUserdata = await Effect.runPromise(
        Path.Path.use((path) => Effect.succeed(path.relative(process.cwd(), data))).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );

      const parentOutcome = await Effect.runPromise(
        runPublishedUpdate({
          userdata: relativeUserdata,
          settings,
          request: { t3: "1.0.0", relaunch: 4242 },
          source: sourceFor(data),
          runningRepository: `${data}/repo`,
          searchPath: `${data}/repo/node_modules/.bin:/opt/homebrew/bin:/usr/bin:/bin`,
          onOutput: {
            stdout: (chunk) => Effect.sync(() => void stdout.push(chunk)),
            stderr: (chunk) => Effect.sync(() => void stderr.push(chunk)),
          },
        }).pipe(Effect.provide(services)),
      );

      const captured = await Effect.runPromise(
        FileSystem.FileSystem.use((fs) => fs.readFileString(capturePath)).pipe(
          Effect.flatMap(decodeHandoff),
          Effect.provide(NodeServices.layer),
        ),
      );
      process.env[PREPULLED_ENV] = captured.prePulled;
      const consumedOnce = consumePrePulledEnv();
      const consumedTwice = consumePrePulledEnv();
      expect([consumedOnce, consumedTwice]).toEqual([captured.prePulled, undefined]);
      const prePulled = await Effect.runPromise(decodePrePulled(consumedOnce ?? ""));

      expect([
        parentOutcome,
        stdout.join(""),
        stderr.join(""),
        captured.cwd,
        captured.argv,
        captured.path,
        captured.lockHolder,
        prePulled.lockPid,
        await headOf(`${data}/repo`),
      ]).toEqual([
        { kind: "handed-off", code: 0 },
        "handed-off stdout\n",
        "",
        cloneOf(data),
        ["update", "--userdata", data, "--t3", "1.0.0", "--relaunch", "4242"],
        "/opt/homebrew/bin:/usr/bin:/bin",
        String(process.pid),
        process.pid,
        devHead,
      ]);

      // Simulate the child running while the parent still holds `<work>/patcher.lock`, and keep `red-color` disabled.
      const lockPath = `${data}/work/patcher.lock`;
      await writeIn(lockPath, `${process.pid}\n`);
      const childOutcome = await Effect.runPromise(
        runPublishedUpdate({
          userdata: data,
          settings,
          request: { prePulled },
          source: sourceFor(data),
          runningRepository: cloneOf(data),
          searchPath: "/opt/homebrew/bin:/usr/bin:/bin",
        }).pipe(
          Effect.ensuring(
            FileSystem.FileSystem.use((fs) => fs.remove(lockPath, { force: true }).pipe(Effect.ignore)),
          ),
          Effect.provide(Layer.mergeAll(servicesFor(data, settings), progress, NodeServices.layer)),
        ),
      );
      const savedStack = await Effect.runPromise(
        StackStore.use((store) => store.load).pipe(Effect.provide(stackServices(data, settings))),
      );

      expect([
        childOutcome.kind === "in-process" ? childOutcome.report.steps.map(line) : [],
        savedStack.entries.map((entry) => `${entry.id} ${entry.enabled ? "on" : "off"}`),
      ]).toEqual([
        [
          `passed pull patches — cloned ${data}/published.git at ${short(firstHead)}`,
          "passed source Fixture source — 1.0.0 (v1.0.0)",
          "passed patch notes-one — applied",
          "passed check plist — ",
          "passed check notes-one: check — ",
          "passed build copy — ",
          "passed journey notes-one: built — ",
          `passed install install — installed; the previous app is at ${data}/work/backups/Installed-1.0.0-1.app`,
        ],
        ["notes-one on", "red-color off"],
      ]);

      // Seed a built `cli.cjs` in `<work>/published`, publish a new commit, and invoke from `<work>/published` itself:
      // it still relaunches AND deletes the stale `cli.cjs` before `scripts/patcher.py` starts.
      await Effect.runPromise(
        FileSystem.FileSystem.use((fs) =>
          fs
            .makeDirectory(`${cloneOf(data)}/apps/desktop/dist`, { recursive: true })
            .pipe(Effect.andThen(fs.writeFileString(`${cloneOf(data)}/apps/desktop/dist/cli.cjs`, "// stale"))),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
      await publish(data, [{ kind: "bump", id: "notes-one", version: 3 }]);
      const fromPublishedOutcome = await Effect.runPromise(
        runPublishedUpdate({
          userdata: data,
          settings,
          request: {},
          source: sourceFor(data),
          runningRepository: cloneOf(data),
          searchPath: "/opt/homebrew/bin:/usr/bin:/bin",
          onOutput: { stdout: () => Effect.void, stderr: () => Effect.void },
        }).pipe(Effect.provide(services)),
      );
      const secondCaptured = await Effect.runPromise(
        FileSystem.FileSystem.use((fs) => fs.readFileString(capturePath)).pipe(
          Effect.flatMap(decodeHandoff),
          Effect.provide(NodeServices.layer),
        ),
      );
      expect([fromPublishedOutcome, secondCaptured.cliBundleExists]).toEqual([
        { kind: "handed-off", code: 0 },
        false,
      ]);
    });
  });

  it("records a failed pull report when python cannot start or the published patcher exits before reaching the CLI", async () => {
    await inWorld(notesOnly(), async (data) => {
      await commitPublishedScript(
        data,
        ['import sys', 'sys.stderr.write("Cache folder is not available\\n")', "sys.exit(1)"].join("\n"),
      );
      const settings = await Effect.runPromise(loadSettings(data).pipe(Effect.provide(NodeServices.layer)));
      const progress = Layer.succeed(Progress)({ report: () => Effect.void });
      const layer = Layer.mergeAll(servicesFor(data, settings), progress, NodeServices.layer);

      const missingPython = `${data}/no-such-python3`;
      const spawnFailed = await Effect.runPromise(
        runPublishedUpdate({
          userdata: data,
          settings,
          request: {},
          source: sourceFor(data),
          runningRepository: `${data}/repo`,
          searchPath: "/opt/homebrew/bin:/usr/bin:/bin",
          pythonCommand: missingPython,
          onOutput: { stdout: () => Effect.void, stderr: () => Effect.void },
        }).pipe(Effect.provide(layer)),
      );
      const afterSpawnFail = await Effect.runPromise(loadReport(data).pipe(Effect.provide(NodeServices.layer)));
      expect([
        spawnFailed.kind,
        Option.map(afterSpawnFail, (report) => report.steps[0]?.status),
        Option.map(afterSpawnFail, (report) => report.steps[0]?.note.startsWith(`couldn't run ${missingPython}:`)),
      ]).toEqual(["failed-before-cli", Option.some("failed"), Option.some(true)]);

      const stderr: Array<string> = [];
      const scriptFailed = await Effect.runPromise(
        runPublishedUpdate({
          userdata: data,
          settings,
          request: {},
          source: sourceFor(data),
          runningRepository: `${data}/repo`,
          searchPath: "/opt/homebrew/bin:/usr/bin:/bin",
          onOutput: {
            stdout: () => Effect.void,
            stderr: (chunk) => Effect.sync(() => void stderr.push(chunk)),
          },
        }).pipe(Effect.provide(layer)),
      );
      const expectedReport: RunReport = {
        version: "",
        install: true,
        steps: [{ kind: "pull", name: "patches", status: "failed", note: "Cache folder is not available" }],
      };
      const saved = await Effect.runPromise(loadReport(data).pipe(Effect.provide(NodeServices.layer)));
      expect([scriptFailed, stderr.join(""), saved]).toEqual([
        { kind: "failed-before-cli", report: expectedReport, code: 1 },
        "Cache folder is not available\n",
        Option.some(expectedReport),
      ]);
    });
  });
});
