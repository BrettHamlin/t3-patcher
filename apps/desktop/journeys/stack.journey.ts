// The stack: the patches in order, turned on and off and reordered, kept in the user data folder.
import { StackUi } from "@app/contracts";
import { patcherWorld } from "@app/fixtures";
import { expect, test } from "vite-plus/test";

import { dataFolder, launch, type Screen } from "./support/app.ts";

const shown = async (screen: Screen, line: string): Promise<ReadonlyArray<string>> => {
  await screen.waitForText(StackUi.list, line);
  return screen.lines(StackUi.list);
};

const change = async (screen: Screen, id: string, button: typeof StackUi.toggle): Promise<void> => {
  await screen.fill(StackUi.patch, id);
  await screen.click(button);
};

test("stack_changes_are_saved", async () => {
  const data = await dataFolder("stack_changes_are_saved");
  await patcherWorld(data, { installed: "1.0.0", patches: ["notes-one", "notes-two"], resolver: "fixing" });
  const first = await launch("stack_changes_are_saved", data);
  expect(await shown(first, "1. notes-one [on] — Add notes")).toEqual([
    "1. notes-one [on] — Add notes",
    "2. notes-two [on] — Second note",
  ]);
  await first.checkpoint("listed");
  await change(first, "notes-one", StackUi.toggle);
  await shown(first, "1. notes-one [off] — Add notes");
  await change(first, "notes-two", StackUi.up);
  expect(await shown(first, "1. notes-two [on] — Second note")).toEqual([
    "1. notes-two [on] — Second note",
    "2. notes-one [off] — Add notes",
  ]);
  await first.checkpoint("changed");
  await first.close();

  const again = await launch("stack_changes_are_saved", data);
  expect(await shown(again, "1. notes-two [on] — Second note")).toEqual([
    "1. notes-two [on] — Second note",
    "2. notes-one [off] — Add notes",
  ]);
  await again.checkpoint("after-relaunch");
  await again.close();
});
