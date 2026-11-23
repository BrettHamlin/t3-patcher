// SKELETON: the renderer's composition root.
import { isPatcherBridge, PATCHER_BRIDGE } from "@app/contracts";

const bridge: unknown = Reflect.get(window, PATCHER_BRIDGE);
document.body.textContent = isPatcherBridge(bridge) ? "T3 Patcher" : "This page runs inside the desktop app.";
