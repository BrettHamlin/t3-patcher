// Runs in the renderer before the page, sandboxed: exposes the bridge and nothing else.
import type { CaptureRequest, Stack } from "@app/contracts";
import { PATCHER_BRIDGE, PatcherChannel, type PatcherBridge } from "@app/contracts/ipc";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const ask = async (channel: string, ...args: ReadonlyArray<unknown>): Promise<unknown> => {
  const answer: unknown = await ipcRenderer.invoke(channel, ...args);
  return answer;
};

contextBridge.exposeInMainWorld(PATCHER_BRIDGE, {
  library: () => ask(PatcherChannel.library),
  saveStack: (stack: typeof Stack.Encoded) => ask(PatcherChannel.saveStack, stack),
  apply: (install: boolean) => ask(PatcherChannel.apply, install),
  lastReport: () => ask(PatcherChannel.lastReport),
  onReport: (listener: (report: unknown) => void) => {
    const heard = (_event: IpcRendererEvent, report: unknown): void => listener(report);
    ipcRenderer.on(PatcherChannel.report, heard);
    return () => {
      ipcRenderer.off(PatcherChannel.report, heard);
    };
  },
  workspace: (id: string) => ask(PatcherChannel.workspace, id),
  capture: (request: typeof CaptureRequest.Encoded) => ask(PatcherChannel.capture, request),
} satisfies PatcherBridge);
