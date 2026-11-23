// Journeys: each runs the built app the way a user would and checks what they'd see. feature-map/ names which
// journeys prove which feature; the verify gate runs them and fails on any journey the map doesn't name.
import { TallyUi } from "@app/contracts";
import { savedTally } from "@app/fixtures";
import { expect, test } from "vite-plus/test";

import { dataFolder, launch, type Screen, whileReadOnly } from "./support/app.ts";

const shown = async (screen: Screen, line: string): Promise<ReadonlyArray<string>> => {
  await screen.waitForText(TallyUi.items, line);
  return screen.lines(TallyUi.items);
};

const add = async (screen: Screen, name: string): Promise<void> => {
  await screen.fill(TallyUi.name, name);
  await screen.click(TallyUi.add);
};

test("tally_is_saved_across_runs", async () => {
  const data = await dataFolder("tally_is_saved_across_runs");
  const first = await launch("tally_is_saved_across_runs", data);
  expect(await shown(first, "(empty)")).toEqual(["(empty)"]);
  await add(first, "apple");
  await shown(first, "apple 1");
  await add(first, "apple");
  await add(first, "pear");
  expect(await shown(first, "pear 1")).toEqual(["apple 2", "pear 1"]);
  await first.checkpoint("added");
  await first.close();

  const again = await launch("tally_is_saved_across_runs", data);
  expect(await shown(again, "apple 2")).toEqual(["apple 2", "pear 1"]);
  await again.checkpoint("after-relaunch");
  await again.close();
});

test("failed_save_keeps_the_old_tally", async () => {
  const data = await dataFolder("failed_save_keeps_the_old_tally");
  const first = await launch("failed_save_keeps_the_old_tally", data);
  await add(first, "apple");
  await shown(first, "apple 1");
  await whileReadOnly(data, async () => {
    await add(first, "apple");
    await first.waitForText(TallyUi.error, "the tally couldn't be read or saved");
    expect(await shown(first, "apple 1")).toEqual(["apple 1"]);
    await first.checkpoint("save-failed");
  });
  await first.close();

  const again = await launch("failed_save_keeps_the_old_tally", data);
  expect(await shown(again, "apple 1")).toEqual(["apple 1"]);
  await again.checkpoint("after-relaunch");
  await again.close();
});

test("bad_name_is_refused", async () => {
  const data = await dataFolder("bad_name_is_refused");
  const first = await launch("bad_name_is_refused", data);
  await add(first, "two words");
  await first.waitForText(TallyUi.error, "names are 1 to 32 letters, digits, '-' or '_'");
  expect(await shown(first, "(empty)")).toEqual(["(empty)"]);
  await first.checkpoint("refused");
  await first.close();

  const again = await launch("bad_name_is_refused", data);
  expect(await shown(again, "(empty)")).toEqual(["(empty)"]);
  await again.close();
});

test("saved_tally_is_shown_at_start", async () => {
  const data = await dataFolder("saved_tally_is_shown_at_start");
  await savedTally(data, [["pear", 3], ["apple", 1]]);
  const app = await launch("saved_tally_is_shown_at_start", data);
  expect(await shown(app, "pear 3")).toEqual(["apple 1", "pear 3"]);
  await app.checkpoint("opened");
  await app.close();
});
