// Builds the renderer (vp build) into dist/, which the desktop app loads from disk.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({ base: "./", plugins: [react()], build: { outDir: "dist", emptyOutDir: true } });
