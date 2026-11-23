// What the preload and the main process share. No runtime imports: the sandboxed preload bundles this file alone.
import type { SavedTally } from "./index.ts";

/** IPC channels between the preload bridge and the main process. */
export const TallyChannel = { load: "tally:load", save: "tally:save" } as const;

/** The preload's bridge: the renderer's only way to reach the main process (window.tally). */
export interface TallyBridge {
  readonly load: () => Promise<unknown>;
  readonly save: (tally: SavedTally) => Promise<unknown>;
}

/** The name the preload exposes the bridge under, on the renderer's window. */
export const TALLY_BRIDGE = "tally";

/** Whether `value` (read from the renderer's window) is the preload's bridge. */
export const isTallyBridge = (value: unknown): value is TallyBridge =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "load") === "function" &&
  typeof Reflect.get(value, "save") === "function";
