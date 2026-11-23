// Applying the stack over the installed app. Each step is one line, "<status> <kind> <name>"; its note shows under
// it on screen but isn't part of the line's text, so these lines are exact. A failed step's note is in the outcome.
import { RunUi } from "@app/contracts";
import { installedFile, patcherWorld, savedBase } from "@app/fixtures";
import { expect, test } from "vite-plus/test";

import { dataFolder, launch, type Screen } from "./support/app.ts";

const steps = async (screen: Screen, outcome: string): Promise<ReadonlyArray<string>> => {
  await screen.waitForText(RunUi.outcome, outcome);
  return screen.lines(RunUi.steps);
};

const NOTES_INSTALLED = [
  "passed source Fixture source",
  "passed patch notes-one",
  "passed patch notes-two",
  "passed check plist",
  "passed check notes-one: check",
  "passed check notes-two: check",
  "passed build copy",
  "passed journey notes-one: built",
  "passed journey notes-two: built",
  "passed save save patches",
  "passed install install",
] as const;

test("patches_apply_in_order_and_install", async () => {
  const data = await dataFolder("patches_apply_in_order_and_install");
  await patcherWorld(data, { installed: "1.0.0", patches: ["notes-one", "notes-two"], resolver: "fixing" });
  const first = await launch("patches_apply_in_order_and_install", data);
  await first.click(RunUi.install);
  await first.click(RunUi.apply);
  expect(await steps(first, "passed")).toEqual(NOTES_INSTALLED);
  await first.checkpoint("passed");
  expect(await installedFile(data, "Contents/Resources/notes.txt")).toEqual("one\ntwo\n");
  await first.close();

  const again = await launch("patches_apply_in_order_and_install", data);
  expect(await steps(again, "passed")).toEqual(NOTES_INSTALLED);
  await again.checkpoint("last-run-after-relaunch");
  await again.close();
});

test("conflict_is_resolved_and_patch_saved", async () => {
  const data = await dataFolder("conflict_is_resolved_and_patch_saved");
  await patcherWorld(data, { installed: "1.1.0", patches: ["red-color"], resolver: "fixing" });
  const app = await launch("conflict_is_resolved_and_patch_saved", data);
  await app.click(RunUi.apply);
  expect(await steps(app, "passed")).toEqual([
    "passed source Fixture source",
    "passed patch red-color",
    "passed check plist",
    "passed check red-color: check",
    "passed build copy",
    "passed journey red-color: built",
    "passed save save patches",
  ]);
  await app.checkpoint("resolved");
  expect(await savedBase(data, "red-color")).toEqual("1.1.0");
  expect(await installedFile(data, "Contents/Resources/app.txt")).toEqual("title: Hello\ncolor: green\nsize: large\n");
  await app.close();
});

test("unresolved_conflict_stops_the_run", async () => {
  const data = await dataFolder("unresolved_conflict_stops_the_run");
  await patcherWorld(data, { installed: "1.1.0", patches: ["red-color"], resolver: "stubborn" });
  const app = await launch("unresolved_conflict_stops_the_run", data);
  await app.click(RunUi.install);
  await app.click(RunUi.apply);
  expect(await steps(app, "failed at red-color: conflicts left in Contents/Resources/app.txt")).toEqual([
    "passed source Fixture source",
    "failed patch red-color",
    "skipped check plist",
    "skipped check red-color: check",
    "skipped build copy",
    "skipped journey red-color: built",
    "skipped save save patches",
    "skipped install install",
  ]);
  await app.checkpoint("stopped");
  expect(await installedFile(data, "Contents/Resources/app.txt")).toEqual("title: Hello\ncolor: green\nsize: large\n");
  expect(await savedBase(data, "red-color")).toEqual("1.0.0");
  await app.close();
});
