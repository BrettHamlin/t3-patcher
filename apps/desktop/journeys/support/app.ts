// Launches the built app for a journey and records evidence (screenshots) under .build/evidence/. Journeys see the
// app only as a Screen: elements are found by the typed identifiers in contracts, never by text, role or selector.
import * as NodeChild from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFsSync from "node:fs";
import * as NodeFs from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { UiId } from "@app/contracts";
import { _electron, type ElectronApplication, type Locator, type Page } from "playwright-core";
import { onTestFinished } from "vite-plus/test";

const DESKTOP = NodePath.resolve(import.meta.dirname, "../..");
const PROJECT = NodePath.resolve(DESKTOP, "../..");
const CLOSE_TIMEOUT_MS = 5_000;
// Where screenshots go: the verify gate's folder, or another one scripts/package.py names per package.
const EVIDENCE = process.env["BSTACK_EVIDENCE"] ?? NodePath.join(PROJECT, ".build/evidence/latest");

/** The app to launch: the packaged app if $BSTACK_PACKAGED_APP names one (scripts/package.py), else the built one. */
export const command = async (data: string): Promise<{ readonly executablePath: string; readonly args: Array<string> }> => {
  const packaged = process.env["BSTACK_PACKAGED_APP"];
  if (packaged) return { executablePath: packaged, args: ["--data", data, "--background"] };
  const require = NodeModule.createRequire(import.meta.url);
  const folder = NodePath.dirname(require.resolve("electron/package.json"));
  const relative = (await NodeFs.readFile(NodePath.join(folder, "path.txt"), "utf8")).trim();
  return {
    executablePath: NodePath.join(folder, "dist", relative),
    args: [NodePath.join(DESKTOP, "dist/main.cjs"), "--data", data, "--background"],
  };
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

/** The part of Electron's main-process module the visibility check uses. */
interface MainProcess {
  readonly BrowserWindow: { readonly getAllWindows: () => ReadonlyArray<{ readonly isVisible: () => boolean }> };
}

type Visibility = "hidden" | "shown" | "unknown";

const find = (page: Page, id: UiId): Locator => page.getByTestId(id.value);

const killTaggedDescendants = (launchId: string): void => {
  const marker = `BSTACK_LAUNCH_ID=${launchId}`;
  if (process.platform === "darwin" && process.getuid !== undefined) {
    const res = NodeChild.spawnSync("/bin/ps", ["-E", "-u", String(process.getuid()), "-ww", "-o", "pid=,command="], {
      encoding: "utf8",
    });
    for (const line of (res.stdout ?? "").split("\n")) {
      const trimmed = line.trim();
      const space = trimmed.indexOf(" ");
      if (space <= 0) continue;
      const pid = Number.parseInt(trimmed.slice(0, space), 10);
      const rest = trimmed.slice(space + 1);
      if (pid > 1 && pid !== process.pid && new RegExp(`(?:^|\\s)${marker}(?:\\s|$)`).test(rest)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already exited.
        }
      }
    }
  } else if (process.platform === "linux") {
    for (const name of NodeFsSync.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number.parseInt(name, 10);
      if (pid <= 1 || pid === process.pid) continue;
      try {
        const entries = NodeFsSync.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        if (entries.includes(marker)) process.kill(pid, "SIGKILL");
      } catch {
        // Unreadable or already exited.
      }
    }
  }
};

const forceKill = (child: ReturnType<ElectronApplication["process"]>, launchId?: string): void => {
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Process group already exited.
      }
    }
    child.kill("SIGKILL");
  }
  if (launchId !== undefined) {
    killTaggedDescendants(launchId);
  }
  // Release every stdio pipe (including Playwright's CDP FDs 3 and 4) so an escaped descendant cannot keep Node alive.
  for (const stream of child.stdio) {
    stream?.destroy();
  }
  child.unref();
};

/** Close `app` within 5s, then SIGKILL its POSIX process group and any `launchId`-tagged helpers. */
export const closeApp = async (
  app: ElectronApplication,
  child: ReturnType<ElectronApplication["process"]>,
  launchId?: string,
): Promise<void> => {
  const timer = new AbortController();
  try {
    await Promise.race([
      app.close().catch(() => undefined),
      delay(CLOSE_TIMEOUT_MS, undefined, { signal: timer.signal }).catch(() => undefined),
    ]);
  } finally {
    timer.abort();
    forceKill(child, launchId);
  }
};

const probeVisibility = async (app: ElectronApplication): Promise<Visibility> => {
  const timer = new AbortController();
  const fallback: Visibility = "unknown";
  try {
    return await Promise.race([
      app
        .evaluate((electron: MainProcess): Visibility =>
          electron.BrowserWindow.getAllWindows().some((window) => window.isVisible()) ? "shown" : "hidden",
        )
        .catch((): Visibility => "unknown"),
      delay(CLOSE_TIMEOUT_MS, fallback, { signal: timer.signal }).catch((): Visibility => "unknown"),
    ]);
  } finally {
    timer.abort();
  }
};

/** Copy `process.env` with `BSTACK_LAUNCH_ID` set so teardown can reap same-launch helpers even if the parent exits. */
export const launchEnv = (launchId: string): Record<string, string> => {
  const env: Record<string, string> = { BSTACK_LAUNCH_ID: launchId };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
};

/** Start the app on `data`, the way a user would open it. */
export const launch = async (journey: string, data: string): Promise<Screen> => {
  const launchId = NodeCrypto.randomUUID();
  const app: ElectronApplication = await _electron.launch({ ...(await command(data)), cwd: DESKTOP, env: launchEnv(launchId) });
  const child = app.process();
  let tearingDown: Promise<void> | undefined;
  const teardown = (): Promise<void> => {
    tearingDown ??= closeApp(app, child, launchId);
    return tearingDown;
  };
  onTestFinished(teardown);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const folder = NodePath.join(EVIDENCE, journey);
    await NodeFs.mkdir(folder, { recursive: true });
    let count = (await NodeFs.readdir(folder)).length;
    let closingWithCheck: Promise<Visibility> | undefined;
    let checkedVisibility = false;
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
      close: async () => {
        // Journeys run in the background (--background): a window on screen would get in the user's way.
        const firstCaller = !checkedVisibility;
        checkedVisibility = true;
        closingWithCheck ??= (async (): Promise<Visibility> => {
          const visibility = await probeVisibility(app);
          await teardown();
          return visibility;
        })();
        const visibility = await closingWithCheck;
        if (!firstCaller) return;
        if (visibility === "unknown") throw new Error("couldn't check whether a window was shown");
        if (visibility === "shown") throw new Error("a window was shown on screen; journeys must stay in the background");
      },
    };
  } catch (error) {
    await teardown();
    throw error;
  }
};
