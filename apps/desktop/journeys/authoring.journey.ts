// Making a patch: open a workspace (the installed version with the stack's patches applied), edit it, capture it.
import { AuthorUi, StackUi } from "@app/contracts";
import { editInWorkspace, patcherWorld, workspaceFile } from "@app/fixtures";
import { expect, test } from "vite-plus/test";

import { dataFolder, launch } from "./support/app.ts";

const LISTED = ["1. blue-title [on] — Blue title", "2. notes-one [on] — Add notes"] as const;

test("new_patch_is_captured", async () => {
  const data = await dataFolder("new_patch_is_captured");
  await patcherWorld(data, { installed: "1.0.0", patches: ["notes-one"], resolver: "fixing" });
  const first = await launch("new_patch_is_captured", data);
  await first.waitForText(StackUi.list, "1. notes-one [on] — Add notes");
  await first.fill(AuthorUi.id, "blue-title");
  await first.click(AuthorUi.open);
  const folder = await first.text(AuthorUi.message);
  expect(await workspaceFile(folder, "Contents/Resources/notes.txt")).toEqual("one\n");
  await first.checkpoint("workspace-open");
  await editInWorkspace(folder, "Contents/Resources/app.txt", "title: Blue\ncolor: blue\n");
  await first.fill(AuthorUi.title, "Blue title");
  await first.fill(AuthorUi.summary, "Makes the title blue.");
  await first.click(AuthorUi.capture);
  await first.waitForText(AuthorUi.message, "captured blue-title");
  await first.waitForText(StackUi.list, LISTED[0]);
  expect(await first.lines(StackUi.list)).toEqual(LISTED);
  await first.checkpoint("captured");
  await first.close();

  const again = await launch("new_patch_is_captured", data);
  await again.waitForText(StackUi.list, LISTED[0]);
  expect(await again.lines(StackUi.list)).toEqual(LISTED);
  await again.checkpoint("after-relaunch");
  await again.close();
});
