/**
 * faceLandmarker.js — the only file that talks to MediaPipe.
 *
 * WHAT MEDIAPIPE GIVES US
 * The Face Landmarker is a *pretrained* deep-learning model that runs in the
 * browser through a WASM runtime. We hand it a video element and it hands back 478
 * normalised points per detected face (468 mesh points + 10 iris points). We do not
 * train anything, and we never send a frame anywhere: the model executes on the
 * user's own machine.
 *
 *      video element ─▶ WASM face landmark model ─▶ 478 landmarks
 *
 * ASSETS — BOTH ARE LOCAL (PRD §21)
 *   • `public/mediapipe/wasm/`  — the WASM runtime, copied out of
 *                                 `node_modules/@mediapipe/tasks-vision/wasm`.
 *   • `public/models/face_landmarker.task` — the model itself (float16, bundle v1),
 *                                 fetched once at install time by
 *                                 `scripts/prepare-assets.mjs`.
 * Both are staged by that script, so at runtime this file only ever requests files
 * from its own origin. No API key, no CDN, no account, no quota.
 *
 * WHY NO FACIAL TRANSFORMATION MATRIX
 * The task can also return a 4×4 transform describing the head in 3D, and we
 * deliberately leave it switched off. Deriving Euler angles from it means picking a
 * matrix convention (row-major vs column-major, left- vs right-handed camera space)
 * whose sign errors are invisible until the classifier mislabels a test, whereas the
 * landmark geometry in `attentionEstimator.js` is symmetric by construction — a
 * frontal face provably produces a yaw of zero. One estimator, one convention, one
 * place to verify. See the README for the full rationale.
 */
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { MAX_FACES, MODEL_ASSET_URL, WASM_ASSET_URL } from "../config/constants";
import { FULL_LANDMARK_COUNT } from "./attentionEstimator";

/** Filename of the WASM loader that `FilesetResolver` is expected to find. */
const WASM_LOADER_FILE = "vision_wasm_internal.js";

/**
 * An error the UI can act on: a short message plus a concrete next step for the
 * user. PRD §26 requires that we never fail silently, and "Failed to load model" is
 * not useful on its own.
 */
export class InferenceSetupError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = "InferenceSetupError";
    this.hint = hint;
  }
}

/**
 * Probe a URL with a cheap HEAD request.
 *
 * The subtlety: many static hosts (and single-page-app rewrites in general) answer
 * *any* unknown path with `200 OK` and a copy of `index.html`. A naive `res.ok`
 * check would then happily report that a missing model exists, and the failure would
 * surface later as an inscrutable WASM abort. So we also reject HTML responses and
 * zero-length bodies.
 */
async function assetIsReachable(url) {
  try {
    const response = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (!response.ok) return false;
    if ((response.headers.get("content-type") ?? "").includes("text/html")) return false;
    const length = response.headers.get("content-length");
    return length === null || Number(length) > 0;
  } catch {
    return false;
  }
}

/**
 * Check that both local inference assets are actually being served, and fail fast
 * with an actionable message if not.
 *
 * Running this *before* booting the WASM runtime matters: a missing model otherwise
 * costs a multi-megabyte runtime start-up before it fails, for a problem that is
 * almost always "the asset script never ran".
 */
export async function assertInferenceAssets() {
  const [modelOk, wasmOk] = await Promise.all([
    assetIsReachable(MODEL_ASSET_URL),
    assetIsReachable(`${WASM_ASSET_URL}/${WASM_LOADER_FILE}`),
  ]);

  if (modelOk && wasmOk) return;

  const missing = [
    !modelOk && "models/face_landmarker.task",
    !wasmOk && "mediapipe/wasm/vision_wasm_internal.js",
  ].filter(Boolean);

  throw new InferenceSetupError(
    `Local inference asset missing: ${missing.join(", ")}`,
    "Run `npm install` (or `npm run prepare:assets`) to stage the model and the " +
      "MediaPipe WASM runtime into public/. Both are local files — no API key or " +
      "account is involved.",
  );
}

/**
 * Load and configure the Face Landmarker.
 *
 * `delegate: "GPU"` runs inference on WebGL and is markedly faster; where WebGL is
 * unavailable (blocklisted driver, headless browser, some VMs) we retry on the CPU
 * backend rather than failing the whole session. Video mode is required for a
 * camera feed and enables MediaPipe's internal frame-to-frame tracking.
 *
 * @returns {Promise<FaceLandmarker>} A ready-to-use landmarker in VIDEO mode.
 * @throws {InferenceSetupError} With a user-facing `hint`.
 */
export async function loadFaceLandmarker() {
  await assertInferenceAssets();

  const buildOptions = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_ASSET_URL, delegate },
    runningMode: "VIDEO",
    // Two, so we can detect and report the multiple-face condition without ever
    // looking at who anyone is.
    numFaces: MAX_FACES,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    // Not needed for attention estimation, and each one costs time per frame.
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  });

  let fileset;
  try {
    fileset = await FilesetResolver.forVisionTasks(WASM_ASSET_URL);
  } catch (cause) {
    throw new InferenceSetupError(
      "The MediaPipe WASM runtime failed to start.",
      "Reload the page and try again. If it keeps failing, run " +
        "`npm run prepare:assets` to re-copy the runtime, and make sure the browser " +
        `supports WebAssembly. (${cause?.message ?? cause})`,
    );
  }

  try {
    return await FaceLandmarker.createFromOptions(fileset, buildOptions("GPU"));
  } catch {
    // GPU is an optimisation, not a requirement — fall back to the CPU backend.
    try {
      return await FaceLandmarker.createFromOptions(fileset, buildOptions("CPU"));
    } catch (cause) {
      throw new InferenceSetupError(
        "The Face Landmarker model could not be initialised.",
        "The model file may be corrupt. Delete public/models/face_landmarker.task " +
          `and run \`npm install\` to re-download it. (${cause?.message ?? cause})`,
      );
    }
  }
}

/**
 * Run one inference on a video element.
 *
 * PRD §6 — this is the boundary of the privacy claim. The frame is read from the
 * `<video>` element in this tab and passed straight into the WASM model. Nothing is
 * serialised, uploaded, or persisted.
 *
 * @param {FaceLandmarker} landmarker
 * @param {HTMLVideoElement} video
 * @param {number} timestampMs Monotonically increasing frame timestamp.
 * @returns {Array<Array<{x:number,y:number,z:number}>>} Normalised landmarks per face.
 */
export function detectFaceLandmarks(landmarker, video, timestampMs) {
  const result = landmarker.detectForVideo(video, timestampMs);
  return result?.faceLandmarks ?? [];
}

/** Release the WASM runtime and its GPU resources. Safe to call more than once. */
export function disposeFaceLandmarker(landmarker) {
  try {
    landmarker?.close?.();
  } catch {
    // A failed teardown must never break unmounting.
  }
}

/**
 * Face-oval connections for the overlay, cached on first use.
 *
 * Read lazily from the same class we already import rather than hard-coding a few
 * hundred index pairs: the library owns the mesh topology, so we cannot drift from
 * it. Returns an empty array if a future version removes the static list, which
 * degrades the overlay to "no face outline" instead of crashing the render.
 */
let faceOvalCache = null;
export function getFaceOvalConnections() {
  if (faceOvalCache === null) {
    faceOvalCache = FaceLandmarker.FACE_LANDMARKS_FACE_OVAL ?? [];
  }
  return faceOvalCache;
}

/** Re-exported so the overlay can sanity-check landmark counts without importing twice. */
export { FULL_LANDMARK_COUNT };
