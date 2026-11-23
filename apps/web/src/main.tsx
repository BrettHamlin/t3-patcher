// The renderer's composition root: the main process, reached through the preload's bridge.
import { isPatcherBridge, PATCHER_BRIDGE } from "@app/contracts";
import * as Effect from "effect/Effect";
import { createRoot } from "react-dom/client";

import { bridgePatcher } from "./patcher.ts";
import { PatcherView } from "./PatcherView.tsx";

const start = async (): Promise<void> => {
  const bridge: unknown = Reflect.get(window, PATCHER_BRIDGE);
  const root = document.querySelector("#root");
  if (!isPatcherBridge(bridge) || root === null) {
    document.body.textContent = "This page runs inside the desktop app.";
    return;
  }
  const patcher = bridgePatcher(bridge);
  const [view, report] = await Effect.runPromise(
    Effect.all([
      patcher.library.pipe(Effect.result),
      patcher.lastReport.pipe(Effect.orElseSucceed(() => null)),
    ]),
  );
  createRoot(root).render(
    <PatcherView
      patcher={patcher}
      view={view._tag === "Success" ? view.success : undefined}
      problem={view._tag === "Failure" ? view.failure.message : ""}
      report={report ?? undefined}
    />,
  );
};

start().catch(() => {
  document.body.textContent = "The app couldn't start.";
});
