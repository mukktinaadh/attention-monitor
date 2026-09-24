import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  optimizeDeps: {
    /**
     * Serve MediaPipe's bundle to the browser exactly as Google published it.
     *
     * `@mediapipe/tasks-vision` ships as a single self-contained ESM file whose WASM
     * loader depends on its own packaging. Letting esbuild pre-bundle it puts another
     * transformation between the loader and the `.wasm` files we serve from
     * `public/mediapipe/wasm`, which is a class of failure that shows up as an opaque
     * WASM abort rather than a useful error. Excluding it removes that variable
     * entirely and costs nothing — the bundle has no imports of its own to resolve.
     */
    exclude: ["@mediapipe/tasks-vision"],
  },

  build: {
    // Everything is client-side by definition; no SSR pass is involved.
    sourcemap: true,
  },
});
