// Explore the built app: open it on a data folder, run a few steps, and save what it shows. Exploring isn't proof;
// once a behaviour works, write the journey that proves it. Run through `python3 scripts/verify.py look`.
// Usage: node journeys/support/look.ts <data folder> <output folder> [fill <test id> <text> | click <test id>]...
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import { _electron } from "playwright-core";

import { command } from "./app.ts";

type Step = { readonly fill: string; readonly text: string } | { readonly click: string };

const parse = (words: ReadonlyArray<string>): ReadonlyArray<Step> => {
  const [action, id, text, ...rest] = words;
  if (action === undefined) return [];
  if (action === "fill" && id !== undefined && text !== undefined) return [{ fill: id, text }, ...parse(rest)];
  if (action === "click" && id !== undefined) return [{ click: id }, ...parse(text === undefined ? rest : [text, ...rest])];
  throw new Error(`unknown step at "${words.join(" ")}": use fill <test id> <text> or click <test id>`);
};

const [data, out, ...words] = process.argv.slice(2);
if (data === undefined || out === undefined) {
  throw new Error("usage: look.ts <data folder> <output folder> [fill <test id> <text> | click <test id>]...");
}
const steps = parse(words);
await NodeFs.mkdir(data, { recursive: true });
await NodeFs.mkdir(out, { recursive: true });
const app = await _electron.launch({ ...(await command(data)) });
try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await steps.reduce(
    (done, step) => done.then(() => ("fill" in step ? page.getByTestId(step.fill).fill(step.text) : page.getByTestId(step.click).click())),
    Promise.resolve(),
  );
  await page.waitForLoadState("networkidle");
  const elements = await page.locator("[data-testid]").all();
  const ids = await Promise.all(
    elements.map(async (element) => `${(await element.getAttribute("data-testid")) ?? ""}: ${((await element.textContent()) ?? "").trim().slice(0, 80)}`),
  );
  await page.screenshot({ path: NodePath.join(out, "look.png") });
  await NodeFs.writeFile(NodePath.join(out, "look.txt"), `${ids.join("\n")}\n`);
  process.stdout.write(`${NodePath.join(out, "look.png")}\n${ids.join("\n")}\n`);
} finally {
  await app.close();
}
