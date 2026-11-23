// Bundles the main process and the preload (vp pack). Electron loads dist/main.cjs.
import { defineConfig } from "vite-plus";

const bundle = (entry: string) => ({
  entry: [entry],
  format: "cjs" as const,
  outDir: "dist",
  dts: false,
  clean: false,
  outExtensions: () => ({ js: ".cjs" }),
  outputOptions: { codeSplitting: false },
  deps: { neverBundle: ["electron"], alwaysBundle: (id: string) => !id.startsWith("node:") && id !== "electron" },
});

export default defineConfig({ pack: [bundle("src/main.ts"), bundle("src/preload.ts")] });
