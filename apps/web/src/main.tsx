// The renderer's composition root: the store is the main process, reached through the preload's bridge.
import { isTallyBridge, TALLY_BRIDGE } from "@app/contracts";
import { current } from "@app/tally";
import * as Effect from "effect/Effect";
import { createRoot } from "react-dom/client";

import { bridgeTallyStore } from "./bridgeStore.ts";
import { TallyView } from "./TallyView.tsx";

const start = async (): Promise<void> => {
  const bridge: unknown = Reflect.get(window, TALLY_BRIDGE);
  const root = document.querySelector("#root");
  if (!isTallyBridge(bridge) || root === null) {
    document.body.textContent = "This page runs inside the desktop app.";
    return;
  }
  const store = bridgeTallyStore(bridge);
  const initial = await Effect.runPromise(current.pipe(Effect.orElseSucceed(() => new Map()), Effect.provide(store)));
  createRoot(root).render(<TallyView initial={initial} store={store} />);
};

start().catch(() => {
  document.body.textContent = "The app couldn't start.";
});
