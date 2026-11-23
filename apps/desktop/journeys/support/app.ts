// Launches the built app for a journey and records evidence (screenshots) under .build/evidence/. Journeys see the
// app only as a Screen: elements are found by the typed identifiers in contracts, never by text, role or selector.
import * as NodeFs from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import type { UiId } from "@app/contracts";
import { _electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

const DESKTOP = NodePath.resolve(import.meta.dirname, "../..");
const PROJECT = NodePath.resolve(DESKTOP, "../..");
// Where screenshots go: the verify gate's folder, or another one scripts/package.py names per package.
const EVIDENCE = process.env["BSTACK_EVIDENCE"] ?? NodePath.join(PROJECT, ".build/evidence/latest");

/** The app to launch: the packaged app if $BSTACK_PACKAGED_APP names one (scripts/package.py), else the built one. */
export const command = async (data: string): Promise<{ readonly executablePath: string; readonly args: Array<string> }> => {
  const packaged = process.env["BSTACK_PACKAGED_APP"];
  if (packaged) return { executablePath: packaged, args: ["--data", data] };
  const require = NodeModule.createRequire(import.meta.url);
  const folder = NodePath.dirname(require.resolve("electron/package.json"));
  const relative = (await NodeFs.readFile(NodePath.join(folder, "path.txt"), "utf8")).trim();
  return { executablePath: NodePath.join(folder, "dist", relative), args: [NodePath.join(DESKTOP, "dist/main.cjs"), "--data", data] };
};

/** A new, empty folder for one journey's data. */
export const dataFolder = async (journey: string): Promise<string> => {
  const folder = NodePath.join(PROJECT, ".build/journeys", journey);
  await NodeFs.rm(folder, { recursive: true, force: true });
  await NodeFs.mkdir(folder, { recursive: true });
  return folder;
};

/** Run `body` while `folder` can't be written, then make it writable again. */
export const whileReadOnly = async <A>(folder: string, body: () => Promise<A>): Promise<A> => {
  await NodeFs.chmod(folder, 0o555);
  try {
    return await body();
  } finally {
    await NodeFs.chmod(folder, 0o755);
  }
};

/** The running app, as a journey sees it. */
export interface Screen {
  /** Type into the element. */
  readonly fill: (id: UiId, text: string) => Promise<void>;
  /** Click the element once it's enabled. */
  readonly click: (id: UiId) => Promise<void>;
  /** Wait until the element contains `text` exactly (itself or a descendant). */
  readonly waitForText: (id: UiId, text: string) => Promise<void>;
  /** The text of each of the element's children, in order. */
  readonly lines: (id: UiId) => Promise<ReadonlyArray<string>>;
  /** Wait until the element shows some text, then return it (for text the journey can't know beforehand). */
  readonly text: (id: UiId) => Promise<string>;
  /** Save a screenshot as evidence, named for what it shows. */
  readonly checkpoint: (label: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

const find = (page: Page, id: UiId): Locator => page.getByTestId(id.value);

/** Start the app on `data`, the way a user would open it. */
export const launch = async (journey: string, data: string): Promise<Screen> => {
  const app: ElectronApplication = await _electron.launch({ ...(await command(data)), cwd: DESKTOP });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const folder = NodePath.join(EVIDENCE, journey);
  await NodeFs.mkdir(folder, { recursive: true });
  let count = (await NodeFs.readdir(folder)).length;
  return {
    fill: (id, text) => find(page, id).fill(text),
    click: (id) => find(page, id).click(),
    waitForText: (id, text) => find(page, id).getByText(text, { exact: true }).first().waitFor(),
    lines: (id) => find(page, id).locator(":scope > *").allInnerTexts(),
    text: async (id) => {
      const shown = find(page, id).filter({ hasText: /\S/ });
      await shown.waitFor();
      return shown.innerText();
    },
    checkpoint: async (label) => {
      count += 1;
      await page.screenshot({ path: NodePath.join(folder, `${String(count).padStart(2, "0")}-${label}.png`) });
    },
    close: () => app.close(),
  };
};
