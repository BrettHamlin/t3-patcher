// SKELETON: the main process.
import { app, BrowserWindow } from "electron";

const open = async (): Promise<void> => {
  await app.whenReady();
  const window = new BrowserWindow({
    width: 900,
    height: 760,
    webPreferences: { preload: `${import.meta.dirname}/preload.cjs`, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  await window.loadFile(`${import.meta.dirname}/renderer/index.html`);
};

app.on("window-all-closed", () => app.quit());
open().catch(() => app.exit(1));
