/**
 * attentionEstimator.js — turning facial landmarks into an attention decision.
 *
 * WHERE THIS SITS IN THE PIPELINE
 *
 *     webcam frame ─▶ MediaPipe Face Landmarker ─▶ 478 normalised landmarks
 *                                                       │
 *                                                       ▼
 *                                          ┌────────────────────────────┐
 *                                          │  THIS FILE                 │
 *                                          │  landmarks → geometry      │
 *                                          │  geometry  → LOOKING/AWAY  │
 *                                          └────────────────────────────┘
 *
 * Everything here is a pure function: no DOM, no camera, no MediaPipe import, no
 * timers, no state. Give it an array of landmarks and it returns numbers. That
 * makes it trivially testable and keeps all the "is this person still watching"
 * guessing in one reviewable place.
 *
 * WHAT IT ACTUALLY MEASURES (and what it does NOT)
 * This is geometric analysis on top of a pretrained model's output. It estimates
 * head orientation and rough eye direction. It is deliberately NOT presented as
 * eye tracking and it CANNOT infer intent — a person reading notes off to the side
 * and a person answering a text message produce identical signals.
 *
 *     1. HEAD YAW   — how far the nose tip has swung left/right of the eye line,
 *                     normalised by the distance between the outer eye corners so
 *                     it does not change when the user moves closer to the camera.
 *     2. HEAD PITCH — the same idea vertically: the nose rises toward the eye line
 *                     when the head pitches up and drops away from it when it
 *                     pitches down.
 *     3. GAZE       — where the iris sits inside the eye opening. This catches
 *                     "eyes flicked sideways, head still", which head pose alone
 *                     would miss. Only available because the landmark model
 *                     includes the 10 iris points (mesh indices 468–477).
 *
 * All three are measured *relative to the user's own neutral pose*, which the
 * engine learns at start-up (see monitoringEngine.js). Measuring relative to a
 * baseline is what makes this work on a laptop camera that sits off to one side,
 * or with a user who sits slightly off-axis.
 */
import { MIRRORED_PREVIEW, PITCH_GAIN, YAW_GAIN } from "../config/constants";

const DEG_PER_RAD = 180 / Math.PI;

/** Guards against dividing by a degenerate (sub-pixel) distance. */
const EPSILON = 1e-6;

/** Smallest believable eye width, in normalised image units. */
const MIN_EYE_WIDTH = 1e-4;

/* -------------------------------------------------------------------------- */
/*  Landmark indices we rely on                                                */
/* -------------------------------------------------------------------------- */

/**
 * Hand-picked landmarks from the MediaPipe Face Mesh. The mesh is canonical and
 * stable across the pretrained bundles, so these indices are safe to hard-code.
 *
 * ORIENTATION NOTE — "right" and "left" below follow MediaPipe's own naming, which
 * describes the *subject's* anatomy, not the side of the image. A person facing the
 * camera has their right side on the left of the picture, so `EYE_OUTER_A` (index
 * 33) lands on the image-left for everyone. We only ever use these as a named pair,
 * so the naming never leaks into the decision logic.
 */
export const LANDMARK_INDEX = Object.freeze({
  NOSE_TIP: 1,
  FOREHEAD_TOP: 10,
  CHIN: 152,
  EYE_OUTER_A: 33,
  EYE_INNER_A: 133,
  EYE_OUTER_B: 263,
  EYE_INNER_B: 362,
});

/**
 * The full eyelid outline for each eye, taken from MediaPipe's own connection
 * tables. We use the complete ring rather than two guessed lid points: the ring's
 * bounding box gives a stable eye centre, width and height, and it degrades
 * gracefully if any single point is noisy.
 */
export const RIGHT_EYE_INDICES = Object.freeze([
  33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
]);

export const LEFT_EYE_INDICES = Object.freeze([
  263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466,
]);

/** The iris points. Index 468/473 is the iris centre, the rest form its ring. */
export const RIGHT_IRIS_INDICES = Object.freeze([468, 469, 470, 471, 472]);
export const LEFT_IRIS_INDICES = Object.freeze([473, 474, 475, 476, 477]);

/**
 * Total landmarks the Face Landmarker bundle emits: 468 mesh points + 10 iris
 * points. If a result has fewer than this, the iris refinement is unavailable and
 * gaze signals must be treated as missing rather than silently read as zero.
 */
export const FULL_LANDMARK_COUNT = 478;

/* -------------------------------------------------------------------------- */
/*  Small numeric helpers                                                      */
/* -------------------------------------------------------------------------- */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Divide, but never produce Infinity/NaN — degenerate geometry returns `fallback`. */
const safeDivide = (numerator, denominator, fallback = 0) =>
  Math.abs(denominator) < EPSILON ? fallback : numerator / denominator;

/** Median is the robust choice for calibration: a few outlier frames cannot shift it. */
export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Arithmetic centre of a set of landmarks. */
function centroidOf(landmarks, indices) {
  let x = 0;
  let y = 0;
  for (const i of indices) {
    x += landmarks[i].x;
    y += landmarks[i].y;
  }
  return { x: x / indices.length, y: y / indices.length };
}

/**
 * Axis-aligned bounding box of a set of landmarks, in normalised image units
 * (0–1, origin top-left). Used both to size the eye aperture and to place the
 * canvas overlay.
 */
function boundsOf(landmarks, indices) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const i of indices) {
    const { x, y } = landmarks[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Bounding box of every landmark in a face — the overlay uses it to frame the face. */
export function computeFaceBounds(landmarks) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of landmarks) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/* -------------------------------------------------------------------------- */
/*  Raw signal extraction                                                      */
/* -------------------------------------------------------------------------- */

/** True when the result carried iris refinements, so gaze signals are meaningful. */
export function hasIrisLandmarks(landmarks) {
  return landmarks.length >= FULL_LANDMARK_COUNT;
}

/**
 * Where is the iris sitting inside its eye opening?
 *
 * Returns offsets normalised by the eye's own width/height, so the value is a
 * fraction of the aperture rather than a pixel count:
 *   `x` → -0.5 fully left of the aperture … +0.5 fully right
 *   `y` → -0.5 up … +0.5 down
 *
 * Both eyes are averaged, which cancels out most single-eye noise.
 */
function extractGaze(landmarks) {
  if (!hasIrisLandmarks(landmarks)) {
    // Do not invent a neutral 0 here — the caller must know gaze is unavailable.
    return { x: null, y: null, available: false };
  }

  const gazeFromOneEye = (eyeIndices, irisIndices) => {
    const eye = boundsOf(landmarks, eyeIndices);
    const iris = centroidOf(landmarks, irisIndices);
    const eyeCentreX = (eye.minX + eye.maxX) / 2;
    const eyeCentreY = (eye.minY + eye.maxY) / 2;
    return {
      x: safeDivide(iris.x - eyeCentreX, Math.max(eye.width, MIN_EYE_WIDTH)),
      y: safeDivide(iris.y - eyeCentreY, Math.max(eye.height, MIN_EYE_WIDTH)),
    };
  };

  const right = gazeFromOneEye(RIGHT_EYE_INDICES, RIGHT_IRIS_INDICES);
  const left = gazeFromOneEye(LEFT_EYE_INDICES, LEFT_IRIS_INDICES);

  return { x: (right.x + left.x) / 2, y: (right.y + left.y) / 2, available: true };
}

/**
 * Measure one frame of landmarks.
 *
 * This returns *raw, uncalibrated* ratios. They are monotonic in head rotation but
 * their zero point depends on where the user sits relative to the camera, which is
 * exactly why the engine subtracts a learned neutral baseline before judging them.
 *
 * @param {Array<{x:number,y:number,z:number}>} landmarks One face, 478 normalised points.
 * @returns {{
 *   yawRatio: number, pitchRatio: number, rollDeg: number,
 *   gazeX: number|null, gazeY: number|null, irisAvailable: boolean,
 *   eyeSpanX: number, faceBounds: object
 * }}
 */
export function extractFaceSignals(landmarks) {
  const nose = landmarks[LANDMARK_INDEX.NOSE_TIP];
  const eyeA = landmarks[LANDMARK_INDEX.EYE_OUTER_A];
  const eyeB = landmarks[LANDMARK_INDEX.EYE_OUTER_B];

  /**
   * Inter-outer-eye distance. Every other measurement is divided by this, which
   * makes all of the ratios scale-invariant: leaning toward the camera, or sitting
   * further back, changes the pixel size of the face but not these numbers.
   */
  const eyeSpanX = Math.max(Math.abs(eyeB.x - eyeA.x), EPSILON);
  const eyeMidX = (eyeA.x + eyeB.x) / 2;
  const eyeMidY = (eyeA.y + eyeB.y) / 2;

  const gaze = extractGaze(landmarks);

  return {
    /**
     * Signed horizontal swing of the nose relative to the eye line. Grows when the
     * head turns; sign flips between left and right. See `directionFromPose` for
     * how the sign is translated into a human-facing label.
     */
    yawRatio: (nose.x - eyeMidX) / eyeSpanX,

    /**
     * Vertical counterpart. Because image y grows downwards and the nose tip sits
     * below the eye line, a frontal face yields a clearly negative value. Looking
     * up makes the nose approach the eye line, so this number rises toward 0.
     * The absolute zero point is meaningless — only its change from the calibrated
     * neutral matters.
     */
    pitchRatio: (eyeMidY - nose.y) / eyeSpanX,

    /**
     * Head tilt (roll), measured as the inclination of the eye line. Reported for
     * telemetry only: tilting your head while still facing the camera is not a loss
     * of attention, so this deliberately does not feed the classifier.
     */
    rollDeg: Math.atan2(eyeB.y - eyeA.y, eyeB.x - eyeA.x) * DEG_PER_RAD,

    gazeX: gaze.x,
    gazeY: gaze.y,
    irisAvailable: gaze.available,

    /** Kept for the overlay and for debugging odd geometry. */
    eyeSpanX,
    faceBounds: computeFaceBounds(landmarks),
  };
}

/* -------------------------------------------------------------------------- */
/*  Temporal smoothing                                                         */
/* -------------------------------------------------------------------------- */

/** The signal fields that get smoothed and compared against a neutral baseline. */
const SMOOTHED_FIELDS = ["yawRatio", "pitchRatio", "rollDeg", "gazeX", "gazeY"];

/**
 * Exponential moving average of one frame of signals.
 *
 * `alpha` is computed by the caller from the actual frame interval (see
 * monitoringEngine) rather than being a fixed constant, so the amount of smoothing
 * stays the same in wall-clock time whether the webcam runs at 15 fps or 60 fps.
 *
 * Null (unavailable) gaze values are copied straight through instead of being
 * averaged into numbers, so a browser without iris landmarks cannot quietly drag
 * the gaze signal toward zero.
 */
export function smoothSignals(previous, next, alpha) {
  if (!previous) return { ...next };
  const clampedAlpha = clamp(alpha, 0, 1);
  const smoothed = { ...next };
  for (const field of SMOOTHED_FIELDS) {
    const previousValue = previous[field];
    const nextValue = next[field];
    smoothed[field] =
      previousValue === null || nextValue === null
        ? nextValue
        : previousValue + (nextValue - previousValue) * clampedAlpha;
  }
  return smoothed;
}

/* -------------------------------------------------------------------------- */
/*  Neutral (calibration) baseline                                             */
/* -------------------------------------------------------------------------- */

/** A neutral baseline of all zeros, used until the engine finishes calibrating. */
export function createEmptyNeutral() {
  return { yawRatio: 0, pitchRatio: 0, rollDeg: 0, gazeX: 0, gazeY: 0 };
}

/**
 * Build a neutral baseline from a window of observed samples.
 *
 * Median, not mean: if the user glances away once during the calibration window,
 * a mean would pull the baseline sideways. The median shrugs that off.
 */
export function computeNeutralFromSamples(samples) {
  if (samples.length === 0) return createEmptyNeutral();
  const picked = (field) =>
    median(samples.map((s) => s[field]).filter((v) => v !== null));
  return {
    yawRatio: picked("yawRatio"),
    pitchRatio: picked("pitchRatio"),
    rollDeg: picked("rollDeg"),
    gazeX: picked("gazeX"),
    gazeY: picked("gazeY"),
  };
}

/* -------------------------------------------------------------------------- */
/*  Classification                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Translate a signed yaw angle into the direction the *user* is facing.
 *
 * In the raw camera frame a person's right side appears on the left of the image
 * (two people facing each other mirror each other's handedness). The preview is
 * also flipped to behave like a mirror. Those two flips are why the sign has to be
 * inverted here, and why the flip is tied to `MIRRORED_PREVIEW` in one place rather
 * than written into the label logic.
 */
function directionFromPose(yawDeg, pitchDeg) {
  const horizontalFlip = MIRRORED_PREVIEW ? -1 : 1;
  // Whichever axis is pulled furthest out of the threshold band names the direction.
  if (Math.abs(yawDeg) >= Math.abs(pitchDeg)) {
    return yawDeg * horizontalFlip < 0 ? "right" : "left";
  }
  return pitchDeg > 0 ? "up" : "down";
}

/**
 * Decide whether the user is attending to the camera.
 *
 * The four signals must ALL be inside their threshold band to count as looking at
 * the camera — that is what makes this a conservative test. Being strict in this
 * direction is the right call, because a false "looking away" produces a false
 * spoken warning, which is the failure mode users actually notice.
 *
 * @param {object} signals      Smoothed signals from `extractFaceSignals`.
 * @param {object} neutral      Learned baseline from `computeNeutralFromSamples`.
 * @param {object} thresholds   One entry from SENSITIVITY_PRESETS.
 */
export function estimateAttention(signals, neutral, thresholds) {
  /** Ratio → degrees, via asin so the mapping saturates like a real rotation. */
  const ratioToDegrees = (ratio, baseline, gain) =>
    Math.asin(clamp(safeDivide(ratio - baseline, gain), -1, 1)) * DEG_PER_RAD;

  const yawDeg = ratioToDegrees(signals.yawRatio, neutral.yawRatio, YAW_GAIN);
  const pitchDeg = ratioToDegrees(signals.pitchRatio, neutral.pitchRatio, PITCH_GAIN);
  const rollDeg = signals.rollDeg - neutral.rollDeg;

  // Gaze is a difference in aperture fractions; no gain conversion is needed.
  const gazeX = signals.gazeX === null ? null : signals.gazeX - neutral.gazeX;
  const gazeY = signals.gazeY === null ? null : signals.gazeY - neutral.gazeY;

  /** Collect every reason the user failed the test — the UI shows these verbatim. */
  const avertedReasons = [];
  if (Math.abs(yawDeg) > thresholds.yawThresholdDeg) {
    avertedReasons.push("head turned");
  }
  if (Math.abs(pitchDeg) > thresholds.pitchThresholdDeg) {
    avertedReasons.push("head tilted");
  }
  if (gazeX !== null && Math.abs(gazeX) > thresholds.gazeXThreshold) {
    avertedReasons.push("eyes off-centre");
  }
  if (gazeY !== null && Math.abs(gazeY) > thresholds.gazeYThreshold) {
    avertedReasons.push("eyes down");
  }

  const isLookingAtCamera = avertedReasons.length === 0;

  return {
    yawDeg,
    pitchDeg,
    rollDeg,
    gazeX,
    gazeY,
    isLookingAtCamera,
    avertedReasons,
    direction: isLookingAtCamera ? null : directionFromPose(yawDeg, pitchDeg),
  };
}
