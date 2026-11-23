// What the preload and the main process share. No runtime imports: the sandboxed preload bundles this file alone.
import type { CaptureRequest, Stack } from "./index.ts";

/** IPC channels between the preload bridge and the main process. */
export const PatcherChannel = {
  library: "patcher:library",
  saveStack: "patcher:save-stack",
  apply: "patcher:apply",
  lastReport: "patcher:last-report",
  report: "patcher:report",
  workspace: "patcher:workspace",
  capture: "patcher:capture",
} as const;

/** The preload's bridge: the renderer's only way to reach the main process (window.patcher). Answers are unchecked. */
export interface PatcherBridge {
  readonly library: () => Promise<unknown>;
  readonly saveStack: (stack: typeof Stack.Encoded) => Promise<unknown>;
  readonly apply: (install: boolean) => Promise<unknown>;
  readonly lastReport: () => Promise<unknown>;
  /** Calls `listener` with each report while a run goes on; returns a function that stops listening. */
  readonly onReport: (listener: (report: unknown) => void) => () => void;
  readonly workspace: (id: string) => Promise<unknown>;
  readonly capture: (request: typeof CaptureRequest.Encoded) => Promise<unknown>;
}

/** The name the preload exposes the bridge under, on the renderer's window. */
export const PATCHER_BRIDGE = "patcher";

/** Whether `value` (read from the renderer's window) is the preload's bridge. */
export const isPatcherBridge = (value: unknown): value is PatcherBridge =>
  typeof value === "object" &&
  value !== null &&
  ["library", "saveStack", "apply", "lastReport", "onReport", "workspace", "capture"].every(
    (key) => typeof Reflect.get(value, key) === "function",
  );
