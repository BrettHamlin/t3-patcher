// SKELETON: the preload bridge.
import { PATCHER_BRIDGE } from "@app/contracts/ipc";
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld(PATCHER_BRIDGE, {});
