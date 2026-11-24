import { Progress } from "@app/apply";
import type { InstalledRecord, RunReport, Step } from "@app/contracts";
import { loadInstalled, loadReport, loadSettings, saveSettings } from "@app/files";
import { commitUnpublished, headOf, installedFile, publish, publishedWorld, type World } from "@app/fixtures";
import { StackStore } from "@app/stack";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { describe, expect, it } from "vite-plus/test";

import { applyStack, type RecordSource, servicesFor, updateStack, type UpdateRequest } from "../src/services.ts";

const line = (step: Step): string => `${step.status} ${step.kind} ${step.name} — ${step.note}`;

const sourceFor = (data: string): RecordSource => ({
  feed: "https://feed.example/patches/index.json",
  update: { command: ["/usr/bin/python3", "/repo/scripts/patcher.py", "update", "--userdata", data], cwd: "/repo" },
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
      const report = yield* (operation === "update"
        ? updateStack(data, settings, request, sourceFor(data))
        : applyStack(data, settings, true, sourceFor(data))
      ).pipe(Effect.provide(services));
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

describe("update", () => {
  it("pulls published versions, adds new patches off, installs the stack and records it", async () => {
    await inWorld(notesOnly(), async (data) => {
      const before = await headOf(`${data}/repo`);
      await publish(data, [
        { kind: "bump", id: "notes-one", version: 2 },
        { kind: "add", id: "red-color" },
      ]);
      const after = await headOf(`${data}/published.git`);
      const seen = await runIn(data, "update");
      expect(seen.report.steps.map(line)).toEqual([
        `passed pull patches — ${short(before)} → ${short(after)}`,
        "passed source Fixture source — 1.0.0 (v1.0.0)",
        "passed patch notes-one — applied",
        "passed check plist — ",
        "passed check notes-one: check — ",
        "passed build copy — ",
        "passed journey notes-one: built — ",
        "passed save save patches — nothing to save",
        `passed install install — installed; the previous app is at ${data}/work/backups/Installed-1.0.0-1.app`,
      ]);
      expect(seen.report.updating).toEqual([{ name: "notes-one", from: "1", to: "2" }]);
      expect([seen.lastRun, seen.reports.at(-1), seen.reports[0]]).toEqual([
        Option.some(seen.report),
        seen.report,
        { version: "", install: true, steps: [{ kind: "pull", name: "patches", status: "running", note: "" }] },
      ]);
      expect(seen.stack).toEqual(["notes-one on", "red-color off"]);
      expect(timeless(seen.installed)).toEqual(
        Option.some({
          t3Version: "1.0.0",
          patches: [{ id: "notes-one", version: 2 }],
          feed: "https://feed.example/patches/index.json",
          update: sourceFor(data).update,
          timed: true,
        }),
      );
      expect([await headOf(`${data}/repo`), await installedFile(data, "Contents/Resources/notes.txt")]).toEqual([
        after,
        "one\n",
      ]);
    });
  });

  it("with --t3, builds that version's tag over the installed one and says so", async () => {
    await inWorld(notesOnly(), async (data) => {
      const head = await headOf(`${data}/repo`);
      const seen = await runIn(data, "update", { t3: "1.1.0" });
      expect(seen.report.steps.map(line)).toEqual([
        `passed pull patches — up to date at ${short(head)}`,
        "passed source Fixture source — 1.1.0 (v1.1.0)",
        "passed patch notes-one — applied; to be saved for 1.1.0",
        "passed check plist — ",
        "passed check notes-one: check — ",
        "passed build copy — ",
        "passed journey notes-one: built — ",
        "passed save save patches — saved notes-one",
        `passed install install — installed; the previous app is at ${data}/work/backups/Installed-1.0.0-1.app`,
      ]);
      expect([seen.report.version, seen.report.updating]).toEqual([
        "1.1.0",
        [{ name: "Fixture", from: "1.0.0", to: "1.1.0" }],
      ]);
      expect([
        await installedFile(data, "Contents/Resources/app.txt"),
        await installedFile(data, "Contents/Resources/notes.txt"),
      ]).toEqual(["title: Hello\ncolor: green\nsize: large\n", "one\n"]);
      expect(Option.map(seen.installed, (record) => record.t3Version)).toEqual(Option.some("1.1.0"));
    });
  });

  it("refuses a repository with local changes, before building or installing anything", async () => {
    await inWorld(notesOnly(), async (data) => {
      await Effect.runPromise(
        FileSystem.FileSystem.use((fs) => fs.writeFileString(`${data}/repo/stray.txt`, "stray\n")).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );
      await publish(data, [{ kind: "bump", id: "notes-one", version: 2 }]);
      const before = await headOf(`${data}/repo`);
      const seen = await runIn(data, "update");
      const refused: RunReport = {
        version: "",
        install: true,
        steps: [
          {
            kind: "pull",
            name: "patches",
            status: "failed",
            note: `the patches repository at ${data}/repo has local changes: commit or remove them, then update again`,
          },
        ],
      };
      expect([seen.report, seen.lastRun, seen.installed]).toEqual([refused, Option.some(refused), Option.none()]);
      expect([await headOf(`${data}/repo`), await installedFile(data, "Contents/Resources/notes.txt")]).toEqual([
        before,
        "(missing)",
      ]);
    });
  });

  it("refuses a repository that has diverged from the published one", async () => {
    await inWorld(notesOnly(), async (data) => {
      await commitUnpublished(data);
      await publish(data, [{ kind: "bump", id: "notes-one", version: 2 }]);
      const before = await headOf(`${data}/repo`);
      const seen = await runIn(data, "update");
      expect(seen.report.steps.map(line)).toEqual([
        `failed pull patches — the patches repository at ${data}/repo has commits that aren't on origin/main, so it can't fast-forward: push or drop them, then update again`,
      ]);
      expect([await headOf(`${data}/repo`), seen.installed]).toEqual([before, Option.none()]);
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
      const before = await headOf(`${data}/repo`);
      const after = await headOf(`${data}/published.git`);
      const seen = await runIn(data, "update", { t3: "1.1.0", relaunch: 99_999_999 });
      expect(seen.report.steps.map(line)).toEqual([
        `passed pull patches — ${short(before)} → ${short(after)}`,
        "passed source Fixture source — 1.1.0 (v1.1.0)",
        "passed patch notes-one — applied; to be saved for 1.1.0",
        "passed check plist — ",
        "passed check notes-one: check — ",
        `failed build copy — copy failed (exit 7; log ${data}/work/logs/copy.log): `,
        "skipped journey notes-one: built — ",
        "skipped save save patches — ",
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

describe("apply --install", () => {
  it("records what it installed, and how to update it", async () => {
    await inWorld(notesOnly(), async (data) => {
      const seen = await runIn(data, "apply");
      expect([seen.report.steps.at(-1)?.status, timeless(seen.installed)]).toEqual([
        "passed",
        Option.some({
          t3Version: "1.0.0",
          patches: [{ id: "notes-one", version: 1 }],
          feed: "https://feed.example/patches/index.json",
          update: sourceFor(data).update,
          timed: true,
        }),
      ]);
    });
  });
});
