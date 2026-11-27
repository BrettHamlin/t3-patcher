// Prove a packaged app runs on a system where the journeys can't run (Windows and Linux, where CI runs it, and the Intel
// macOS build under Rosetta): open it on an empty data folder, check what it shows, take the steps, check again, then open it again and
// check the result was kept. The checks and steps are the app's own, in apps/desktop/journeys/smoke.json.
// With an expected version, it also waits for the app to download that update, then reopens the app until it runs that
// version (the update installs when the app quits) and checks the result was kept.
// Usage: node scripts/smoke.mjs <executable> <folder with node_modules/playwright-core> <evidence folder> [<version>]
import * as NodeChild from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFsSync from "node:fs";
import * as NodeFs from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

const [executable, tools, evidence, update] = process.argv.slice(2);
if (!executable || !tools || !evidence) {
  throw new Error("usage: node scripts/smoke.mjs <executable> <folder with node_modules/playwright-core> <evidence folder>");
}
const plan = JSON.parse(await NodeFs.readFile(new URL("../apps/desktop/journeys/smoke.json", import.meta.url), "utf8"));
const { _electron } = NodeModule.createRequire(NodePath.join(NodePath.resolve(tools), "noop.js"))("playwright-core");
const data = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "smoke-"));
await NodeFs.mkdir(evidence, { recursive: true });
// CI's Linux runners can't give Chromium's sandbox the setuid helper it needs.
const args = ["--data", data, ...(process.platform === "linux" ? ["--no-sandbox"] : [])];

// The app's stdout, collected from launch on: it reports its version and update steps there.
const said = (app) => {
  const output = { text: "" };
  app.process().stdout.on("data", (chunk) => {
    output.text += String(chunk);
  });
  return output;
};
const log = (line) => process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);
// Every wait has a limit, so a hang fails with what it was waiting for instead of running into the job's timeout.
const within = (promise, ms, what) => {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
};
// The update installs after the app quits: on Windows its installer (<app>-<version>-win-<arch>.exe) runs on, on macOS
// Squirrel's ShipIt swaps the app. Reopening before it's done races it, which a user's next launch doesn't.
const installing = (version) =>
  process.platform === "win32"
    ? NodeChild.execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" }).includes(`-${version}-win-`)
    : process.platform === "darwin" && NodeChild.spawnSync("pgrep", ["-x", "ShipIt"]).status === 0;
// Windows: the app's and its installer's processes and all their children, with parent and command line, for a failure report.
const processes = () =>
  process.platform !== "win32"
    ? ""
    : NodeChild.execFileSync(
        "powershell",
        ["-NoProfile", "-Command",
          "$all = Get-CimInstance Win32_Process; " +
          "$ids = @($all | Where-Object { $_.Name -like 'starter*' } | ForEach-Object { $_.ProcessId }); " +
          "do { $n = $ids.Count; $ids = @($ids + ($all | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId }) | Select-Object -Unique) } while ($ids.Count -gt $n); " +
          "$all | Where-Object { $ids -contains $_.ProcessId } | Format-List ProcessId,ParentProcessId,Name,CreationDate,CommandLine | Out-String -Width 400"],
        { encoding: "utf8" },
      );
// Windows: a picture of the whole desktop, to show a dialog the installer is waiting on.
const desktop = (file) => {
  if (process.platform !== "win32") return;
  NodeChild.execFileSync("powershell", ["-NoProfile", "-Command",
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; " +
    "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen; " +
    "$img = New-Object System.Drawing.Bitmap $b.Width, $b.Height; " +
    "[System.Drawing.Graphics]::FromImage($img).CopyFromScreen($b.Left, $b.Top, 0, 0, $img.Size); " +
    `$img.Save('${NodePath.resolve(file)}')`]);
};
const until = async (output, pattern, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = pattern.exec(output.text);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
};

const launched = new Map();
const killTagged = (launchId) => {
  const marker = `BSTACK_LAUNCH_ID=${launchId}`;
  if (process.platform === "darwin" && process.getuid !== undefined) {
    const res = NodeChild.spawnSync("/bin/ps", ["-E", "-u", String(process.getuid()), "-ww", "-o", "pid=,command="], { encoding: "utf8" });
    for (const line of (res.stdout ?? "").split("\n")) {
      const trimmed = line.trim();
      const space = trimmed.indexOf(" ");
      if (space <= 0) continue;
      const pid = Number.parseInt(trimmed.slice(0, space), 10);
      const rest = trimmed.slice(space + 1);
      if (pid > 1 && pid !== process.pid && new RegExp(`(?:^|\\s)${marker}(?:\\s|$)`).test(rest)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  } else if (process.platform === "linux") {
    for (const name of NodeFsSync.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number.parseInt(name, 10);
      if (pid <= 1 || pid === process.pid) continue;
      try {
        if (NodeFsSync.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(marker)) process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
};
const releaseChild = (child) => {
  const launchId = launched.get(child);
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    child.kill("SIGKILL");
  }
  if (launchId !== undefined) killTagged(launchId);
  for (const stream of child.stdio) {
    stream?.destroy();
  }
  child.unref();
  launched.delete(child);
};
const open = async () => {
  const launchId = NodeCrypto.randomUUID();
  // A first launch can be slow: Rosetta translates an Intel build on a Mac the first time it runs.
  const app = await _electron.launch({
    executablePath: NodePath.resolve(executable),
    args,
    env: { ...process.env, BSTACK_LAUNCH_ID: launchId },
    timeout: 180_000,
  });
  const child = app.process();
  launched.set(child, launchId);
  try {
    const output = said(app);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    return { app, page, output, child };
  } catch (error) {
    await within(app.close().catch(() => {}), 5_000, "closing failed launch").catch(() => {});
    releaseChild(child);
    throw error;
  }
};
// The element's children read exactly `lines` (an empty list too), within 30 seconds.
const shows = async (page, { id, lines }) => {
  const element = page.getByTestId(id);
  await element.waitFor({ timeout: 30_000 });
  const deadline = Date.now() + 30_000;
  let actual = [];
  while (Date.now() < deadline) {
    actual = await element.locator(":scope > *").allInnerTexts();
    if (JSON.stringify(actual) === JSON.stringify(lines)) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`${id}: expected ${JSON.stringify(lines)}, saw ${JSON.stringify(actual)}`);
};

try {
  const first = await open();
  await shows(first.page, plan.start);
  for (const step of plan.steps) {
    if ("fill" in step) await first.page.getByTestId(step.fill).fill(step.text);
    else await first.page.getByTestId(step.click).click();
  }
  await shows(first.page, plan.after);
  await first.page.screenshot({ path: NodePath.join(evidence, "01-after-steps.png") });
  if (update) {
    if (!(await until(first.output, new RegExp(`update ready: ${update.replaceAll(".", "\\.")}`), 180_000))) {
      throw new Error(`no update to ${update} within 3 minutes; the app said:\n${first.output.text}`);
    }
    process.stdout.write(first.output.text);
  }
  log("closing the app");
  // The app may already be gone (the update's installer can end it): don't wait on it for long.
  // On Windows the update's installer starts as the app quits and inherits its output pipe, so the test driver's close
  // doesn't return: close the windows the way a user's click on X does (the app quits when its last window closes) and
  // wait for the process to exit.
  const pid = first.app.process().pid;
  const alive = () => NodeChild.execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" }).includes(`"${pid}"`);
  const exited = async () => {
    for (const end = Date.now() + 60_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 500))) {
      if (!alive()) return;
    }
    throw new Error("the app didn't exit within 60s of closing its window");
  };
  const closeWindows = () => {
    // Not awaited: the app may be gone before it answers.
    first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.close())).catch(() => {});
    return exited();
  };
  const closing = process.platform === "win32" ? closeWindows() : first.app.close();
  await within(closing, 60_000, "closing the app");
  releaseChild(first.child);
  log("closed");

  // The update installs after the app quits (on Windows the installer runs on, on macOS Squirrel stages it): reopen
  // until the new version runs, for up to 3 minutes.
  const deadline = Date.now() + 180_000;
  // Asked of the main process itself. A launch can fail while an installer is replacing the app: try again until the
  // deadline.
  const version = (opened) => within(opened.app.evaluate(({ app }) => app.getVersion()), 30_000, "asking the version");
  let again;
  for (let running = "", failure = ""; ; failure = "") {
    // Give the installer a moment to start before checking for it.
    if (update && Date.now() < deadline - 175_000) {
      failure = "giving its installer a moment to start";
    } else if (update && installing(update)) {
      failure = "its installer is still running";
    } else {
      try {
        again = await within(open(), 200_000, "opening the app");
        running = update ? await version(again) : "";
        log(`running ${running || "(no update expected)"}`);
        if (!update || running === update) break;
        await within(again.app.close(), 60_000, "closing the app");
        releaseChild(again.child);
      } catch (error) {
        if (again) releaseChild(again.child);
        for (const child of [...launched.keys()]) {
          releaseChild(child);
        }
        failure = String(error);
      }
    }
    log(`not yet: ${failure || `runs ${running}`}`);
    if (Date.now() > deadline) {
      desktop(NodePath.join(evidence, "desktop-at-failure.png"));
      throw new Error(`the app still runs ${running || "an unknown version"}, not ${update}: ${failure}\n${processes()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (update) process.stdout.write(`relaunched on ${update}\n`);
  await shows(again.page, plan.after);
  await again.page.screenshot({ path: NodePath.join(evidence, "02-after-relaunch.png") });
  await within(again.app.close().catch(() => {}), 10_000, "closing the app").catch(() => {});
  releaseChild(again.child);
  process.stdout.write(`smoke passed: ${executable}\n`);
} finally {
  for (const child of [...launched.keys()]) {
    releaseChild(child);
  }
}
