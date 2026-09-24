/**
 * constants.js — the single source of truth for every tunable value in the app.
 *
 * WHY THIS FILE EXISTS
 * The monitoring behaviour is spread over a vision layer, a decision engine and a
 * React layer. If a threshold literal lived in each of them, changing "how long is
 * too long to look away" would mean hunting through the codebase and would almost
 * certainly drift out of sync. So every magic number is declared exactly once,
 * named after what it means, and imported from here.
 *
 * NOTHING in this file requires a network call, an API key, or a paid service.
 * The only two URLs are paths to files we serve ourselves out of `public/`
 * (staged by `scripts/prepare-assets.mjs`).
 */

/* -------------------------------------------------------------------------- */
/*  Timing thresholds                                                          */
/* -------------------------------------------------------------------------- */

/** PRD §9 — how long the user may look away before we escalate to a warning. */
export const LOOK_AWAY_THRESHOLD_MS = 2000;

/** PRD §13 — minimum gap between two spoken warnings, so we never nag. */
export const VOICE_ALERT_COOLDOWN_MS = 5000;

/**
 * Hysteresis in the *other* direction: a single noisy frame that looks like the
 * user returned to the camera must not cancel a look-away timer that is already
 * running. They have to hold the "looking" pose for this long to clear it.
 *
 * Without this, one bad frame every 1.9s would suppress a warning forever.
 */
export const RETURN_TO_CAMERA_DWELL_MS = 350;

/**
 * How long we tolerate losing the face before we treat it as a real NO_FACE
 * event rather than a momentary tracking dropout. Blink-and-you-miss-it gaps
 * inside this window keep the previous state alive.
 */
export const NO_FACE_GRACE_MS = 800;

/**
 * PRD §44 (auto-calibration) — the user is assumed to be looking at the camera
 * right after they press Start, so we spend this long learning their neutral
 * pose before we judge them against it.
 */
export const AUTO_CALIBRATION_MS = 1500;

/** PRD §6 — no point running inference faster than the webcam produces frames. */
export const DETECTION_INTERVAL_MS = 80;

/**
 * Time constant of the exponential moving average applied to the pose signals.
 * Bigger = smoother and slower to react. The engine converts this into a
 * per-frame alpha using the measured frame interval, so the amount of smoothing
 * is identical whether the webcam runs at 15 fps or 60 fps.
 */
export const SIGNAL_SMOOTHING_MS = 120;

/**
 * React only needs to repaint the dashboard a few times a second. Face landmarks
 * are drawn on a canvas imperatively (see CameraView) so they stay smooth, while
 * the numeric panels update at this much lower rate. This is what keeps a 15 Hz
 * inference loop from causing 15 React re-renders per second.
 */
export const SNAPSHOT_PUBLISH_INTERVAL_MS = 100;

/* -------------------------------------------------------------------------- */
/*  MediaPipe configuration                                                    */
/* -------------------------------------------------------------------------- */

/**
 * PRD §15 — we must be able to *detect* the "more than one face" condition, so we
 * ask for 2. We never look at who they are, only how many there are.
 *
 * Note: MediaPipe only applies its internal landmark smoothing when numFaces is 1.
 * We do our own smoothing anyway (see `smoothSignals`), so this costs us nothing.
 */
export const MAX_FACES = 2;

/**
 * PRD §21 — assets are bundled, not fetched from a CDN.
 * `import.meta.env.BASE_URL` is Vite's base path (normally "/"), so these keep
 * working if the app is ever hosted under a sub-path.
 */
const assetUrl = (relativePath) => `${import.meta.env.BASE_URL}${relativePath}`;

/** The pretrained Face Landmarker bundle (float16, v1). Staged into `public/models/`. */
export const MODEL_ASSET_URL = assetUrl("models/face_landmarker.task");

/** The MediaPipe WASM runtime. Staged into `public/mediapipe/wasm/`. */
export const WASM_ASSET_URL = assetUrl("mediapipe/wasm");

/* -------------------------------------------------------------------------- */
/*  Attention estimator tuning                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The estimator turns landmark geometry into a normalised "how far has the nose
 * swung away from the eye line" ratio, then converts that ratio to degrees with
 * `asin(ratio / gain)`.
 *
 * These gains are the one genuinely empirical part of the maths: they describe how
 * much a real head moves the normalised ratio per degree of rotation, and the true
 * value depends on the face and the camera's field of view. They are documented,
 * exposed live in the UI as a "Pose" readout, and are the first thing to tune if
 * the pose numbers feel too twitchy or too sluggish on a given webcam.
 */
export const YAW_GAIN = 0.35;
export const PITCH_GAIN = 0.3;

/**
 * PRD §25 — a dashboard-wide fix for the fact that this is an approximation:
 * users pick how strict the judgement is instead of editing source code.
 * Each preset is a full threshold set, so switching presets never leaves a stale
 * value behind from the previous one.
 */
export const SENSITIVITY_PRESETS = Object.freeze({
  relaxed: Object.freeze({
    label: "Relaxed",
    yawThresholdDeg: 30,
    pitchThresholdDeg: 24,
    gazeXThreshold: 0.34,
    gazeYThreshold: 0.36,
  }),
  balanced: Object.freeze({
    label: "Balanced",
    yawThresholdDeg: 22,
    pitchThresholdDeg: 18,
    gazeXThreshold: 0.26,
    gazeYThreshold: 0.3,
  }),
  strict: Object.freeze({
    label: "Strict",
    yawThresholdDeg: 15,
    pitchThresholdDeg: 12,
    gazeXThreshold: 0.18,
    gazeYThreshold: 0.22,
  }),
});

export const DEFAULT_SENSITIVITY = "balanced";

/** Selectable look-away thresholds offered in the UI (milliseconds). */
export const LOOK_AWAY_THRESHOLD_CHOICES = Object.freeze([1000, 2000, 3000, 5000]);

/* -------------------------------------------------------------------------- */
/*  Presentation conventions                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The preview is flipped horizontally so it behaves like a mirror, which is what
 * people expect from a selfie camera. The canvas overlay lives inside the same
 * flipped element, so landmarks stay perfectly aligned with the video.
 *
 * Because of that flip, a signed head-pose angle has to be re-interpreted before
 * we label it "left" or "right" for the user — see `directionFromPose`.
 */
export const MIRRORED_PREVIEW = true;

/** PRD §12 — the exact sentence the browser speaks. */
export const VOICE_ALERT_TEXT = "Please look at the camera.";

/* -------------------------------------------------------------------------- */
/*  Monitoring states                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The five monitoring states. Exactly one is active at any moment.
 *
 * These live in the config module rather than inside the engine so that the state
 * names and the strings the UI shows for them are declared side by side and can be
 * derived from each other — keys in `STATE_PRESENTATION` are computed from `STATE`,
 * so a rename cannot leave the UI pointing at a state that no longer exists.
 *
 * PRD §10 defines four states; MULTIPLE_FACES is split out of it as a fifth because
 * PRD §15 requires it to be *reported* without being treated as a lapse of
 * attention. Modelling it as a flag on top of the other four would have meant every
 * consumer checking two things instead of one.
 */
export const STATE = Object.freeze({
  NO_FACE: "NO_FACE",
  MULTIPLE_FACES: "MULTIPLE_FACES",
  LOOKING_AT_CAMERA: "LOOKING_AT_CAMERA",
  LOOKING_AWAY: "LOOKING_AWAY",
  WARNING: "WARNING",
});

/**
 * How each state is presented. The `tone` drives colour through a single
 * `data-tone` attribute on the app shell, which is also what the canvas overlay
 * reads its accent colour from — so the dashboard and the landmarks can never
 * disagree about what "warning red" is.
 */
export const STATE_PRESENTATION = Object.freeze({
  [STATE.NO_FACE]: Object.freeze({
    label: "No face detected",
    short: "NO FACE",
    tone: "neutral",
    glyph: "◉",
    description: "Nobody is in view. This is reported as its own condition and never as a warning.",
  }),
  [STATE.MULTIPLE_FACES]: Object.freeze({
    label: "Multiple faces detected",
    short: "MULTIPLE FACES",
    tone: "notice",
    glyph: "⚠️",
    description:
      "More than one face is in view, so attention cannot be attributed to a single person. No identities are examined.",
  }),
  [STATE.LOOKING_AT_CAMERA]: Object.freeze({
    label: "Looking at camera",
    short: "LOOKING AT CAMERA",
    tone: "good",
    glyph: "🟢",
    description: "Head orientation and eye position are both inside the threshold band.",
  }),
  [STATE.LOOKING_AWAY]: Object.freeze({
    label: "Looking away",
    short: "LOOKING AWAY",
    tone: "warn",
    glyph: "🟡",
    description: "Outside the threshold band. A warning fires if this continues past the threshold.",
  }),
  [STATE.WARNING]: Object.freeze({
    label: "Please look at the camera",
    short: "PLEASE LOOK AT THE CAMERA",
    tone: "alert",
    glyph: "🔴",
    description: "The look-away threshold has been exceeded and the alert above has been raised.",
  }),
});

/**
 * The user-facing text on the status card while the neutral baseline is still being
 * learned. Kept next to the other presentation strings so all copy lives together.
 */
export const CALIBRATING_PRESENTATION = Object.freeze({
  label: "Calibrating neutral pose",
  short: "CALIBRATING",
  tone: "notice",
  glyph: "◌",
  description:
    "Learning your neutral head position. Keep looking at the camera for a moment — every later measurement is relative to this baseline.",
});

/**
 * Resolve what the dashboard should show for a given engine snapshot.
 *
 * Calibration overrides the state on purpose: while the baseline is being learned
 * there is nothing meaningful to judge against, so showing "LOOKING AT CAMERA" would
 * be a claim the engine cannot yet support.
 */
export function resolveStatePresentation(snapshot) {
  if (snapshot.calibrating) return CALIBRATING_PRESENTATION;
  return STATE_PRESENTATION[snapshot.state] ?? STATE_PRESENTATION[STATE.NO_FACE];
}

/**
 * The voice toggle's state is stored in a module-level constant so the hook and the
 * control panel agree on the default. Voice alerts start ON (PRD §14).
 */
export const VOICE_ALERTS_DEFAULT_ON = true;

/* -------------------------------------------------------------------------- */
/*  Assembled default config                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The decision engine is constructed from a config object rather than reading
 * these constants directly. That is what lets the UI change a threshold at
 * runtime *and* lets tests drive the engine with a deterministic config.
 */
export const DEFAULT_MONITORING_CONFIG = Object.freeze({
  lookAwayThresholdMs: LOOK_AWAY_THRESHOLD_MS,
  voiceCooldownMs: VOICE_ALERT_COOLDOWN_MS,
  returnToCameraDwellMs: RETURN_TO_CAMERA_DWELL_MS,
  noFaceGraceMs: NO_FACE_GRACE_MS,
  autoCalibrationMs: AUTO_CALIBRATION_MS,
  ...SENSITIVITY_PRESETS[DEFAULT_SENSITIVITY],
});
