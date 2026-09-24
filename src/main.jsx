/**
 * main.jsx — the React entry point.
 *
 * `StrictMode` stays on deliberately. In development it double-invokes effects, which
 * is exactly the kind of pressure a camera session needs: it proves that the teardown
 * in `useAttentionMonitor` (stopping the tracks, cancelling the animation frame,
 * disposing the landmarker) is genuinely idempotent, instead of leaking a camera or a
 * WASM runtime the first time something remounts.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
