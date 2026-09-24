#!/usr/bin/env node
/**
 * prepare-assets.mjs — one-shot asset staging for fully local inference.
 *
 * MediaPipe Tasks Vision needs two things at runtime, and neither is a web API:
 *
 *   1. A WASM runtime (`vision_wasm_internal.js` + `.wasm`, plus the no-SIMD and
 *      module-internal variants). These already ship inside the
 *      `@mediapipe/tasks-vision` npm package, so we copy them out of
 *      `node_modules/` into `public/` verbatim. No download, no CDN.
 *
 *   2. A trained model file (`face_landmarker.task`, ~3.7 MB), which is NOT part of
 *      the npm package. It is downloaded exactly once from Google's public
 *      MediaPipe model bucket and committed to `public/models/` so every later
 *      `npm run dev` / `npm run build` is completely offline.
 *
 * This script is the ONLY network-touching code in the project, it runs at install
 * time (never at runtime), and it needs no credentials. The app itself never calls
 * out to anything.
 *
 * Usage:
 *   node scripts/prepare-assets.mjs            # warn-and-continue (postinstall)
 *   node scripts/prepare-assets.mjs --strict   # exit 1 if assets are missing (build)
 *
 * Both output directories are regenerable build inputs and are git-ignored, so a
 * fresh clone stays small: `npm install` restores everything.
 */
import { createWriteStream } from "node:fs";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");

/** Where the WASM runtime gets copied, and the URL prefix the app asks FilesetResolver for. */
const WASM_SRC = path.join(ROOT, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const WASM_DEST = path.join(ROOT, "public", "mediapipe", "wasm");

/** The pretrained Face Landmarker (float16, bundle version 1). */
const MODEL_DEST = path.join(ROOT, "public", "models", "face_landmarker.task");
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const log = (msg) => console.log(`[prepare-assets] ${msg}`);

/** True when `p` exists and is non-empty (a truncated download must not count as present). */
async function exists(p) {
  try {
    const s = await stat(p);
    return s.size > 0;
  } catch {
    return false;
  }
}

/** Stage 1: copy the WASM runtime out of node_modules. Pure file copy — always offline. */
async function stageWasm() {
  if (!(await exists(WASM_SRC))) {
    return "skipped: @mediapipe/tasks-vision is not installed yet";
  }
  // Wipe first so a package upgrade can never leave stale (incompatible) .wasm files behind.
  await rm(WASM_DEST, { recursive: true, force: true });
  await mkdir(WASM_DEST, { recursive: true });
  await cp(WASM_SRC, WASM_DEST, { recursive: true });
  return "copied from node_modules";
}

/** Stage 2: fetch the model once, streaming straight to disk. */
async function downloadModel() {
  const res = await fetch(MODEL_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  await mkdir(path.dirname(MODEL_DEST), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(MODEL_DEST));
}

async function stageModel() {
  if (await exists(MODEL_DEST)) return "already present";
  log("downloading face_landmarker.task (~3.7 MB, one time only)...");
  await downloadModel();
  return `downloaded to ${path.relative(ROOT, MODEL_DEST)}`;
}

/** Run a stage, logging its outcome, and collect failures instead of throwing immediately. */
async function attempt(label, fn) {
  try {
    log(`${label}: ${await fn()}`);
    return true;
  } catch (err) {
    log(`${label}: FAILED — ${err.message}`);
    return false;
  }
}

async function main() {
  const wasmOk = await attempt("wasm runtime", stageWasm);
  const modelOk = await attempt("face landmarker model", stageModel);

  if (wasmOk && modelOk) {
    log("all local inference assets ready — no API key required.");
    return;
  }

  const missing = [
    !wasmOk && path.relative(ROOT, WASM_DEST),
    !modelOk && path.relative(ROOT, MODEL_DEST),
  ].filter(Boolean);

  const guidance =
    `\nMissing local assets: ${missing.join(", ")}\n` +
    `  • Run \`npm install\` (the postinstall step stages these), then re-run\n` +
    `    \`npm run prepare:assets\`.\n` +
    `  • If this machine has no internet, copy the files in by hand from another\n` +
    `    machine that ran \`npm install\`. The app needs no network after that.\n`;

  if (STRICT) {
    console.error(guidance);
    process.exit(1);
  }
  // Non-strict (install-time): do NOT break `npm install`. The app surfaces its own
  // actionable error screen when the model is missing, which beats a cryptic install abort.
  console.warn(guidance);
}

main();
