/**
 * overlayRenderer.js — draws the vision results on top of the video.
 *
 * WHY IMPERATIVE CANVAS INSTEAD OF REACT
 * The overlay has to be repainted on every processed frame (~12–15 per second) and
 * must stay locked to the video. Routing that through React state would mean a full
 * reconciliation per frame for something the browser can already do natively, and
 * would put the landmarks a render tick behind the video. So this module is plain
 * canvas drawing, called synchronously right after inference, while React renders
 * only the low-frequency dashboard around it.
 *
 * MIRRORING
 * The video preview is flipped horizontally to behave like a mirror (see
 * `MIRRORED_PREVIEW`). Landmarks arrive in the *unflipped* frame's coordinates, so
 * the canvas is placed inside the same flipped container and drawn in those same
 * coordinates — the flip is applied once, by CSS, to both layers together. That is
 * why there is no `1 - x` arithmetic anywhere below: doing it in two places is how
 * overlays end up subtly misaligned.
 *
 * COLORS
 * Every colour is read from the CSS custom properties in `index.css`, so the canvas
 * and the surrounding dashboard cannot drift apart. The read happens once per
 * canvas per state change (values are cached on the element) rather than per frame.
 */
import { STATE_PRESENTATION } from "../config/constants";
import { LANDMARK_INDEX, LEFT_EYE_INDICES, LEFT_IRIS_INDICES, RIGHT_EYE_INDICES, RIGHT_IRIS_INDICES } from "./attentionEstimator";

/** CSS custom properties the overlay pulls its palette from. */
const THEME_MAP = {
  accent: "--state-accent",
  line: "--overlay-line",
  point: "--overlay-point",
  iris: "--overlay-iris",
  hudText: "--overlay-hud-text",
  track: "--overlay-track",
  trackBand: "--overlay-track-band",
};

/** Fallbacks for the first frame, before styles have resolved. */
const FALLBACK_THEME = {
  accent: "#38bdf8",
  line: "rgba(148, 197, 255, 0.55)",
  point: "#e2e8f0",
  iris: "#facc15",
  hudText: "rgba(226, 232, 240, 0.9)",
  track: "rgba(15, 23, 42, 0.55)",
  trackBand: "rgba(56, 189, 248, 0.25)",
};

/** Landmarks are unit-normalised; these are the drawing sizes in device pixels. */
const LINE_WIDTH = 1;
const EYE_LINE_WIDTH = 1.25;
const POINT_RADIUS = 1.6;
const IRIS_RADIUS = 2.6;

/** Cached theme per canvas element, keyed by the active state so it refreshes on change. */
const themeCache = new WeakMap();

/**
 * Resolve the palette for this frame, reusing the previous read while the state is
 * unchanged. `getComputedStyle` forces a style recalculation, so doing it 15 times a
 * second for seven properties would be needless work.
 */
function readTheme(canvas, stateKey) {
  const cached = themeCache.get(canvas);
  if (cached && cached.stateKey === stateKey) return cached.theme;

  let computed;
  try {
    computed = getComputedStyle(canvas);
  } catch {
    return FALLBACK_THEME;
  }

  const theme = {};
  for (const [key, cssVar] of Object.entries(THEME_MAP)) {
    theme[key] = computed.getPropertyValue(cssVar).trim() || FALLBACK_THEME[key];
  }

  themeCache.set(canvas, { stateKey, theme });
  return theme;
}

/* -------------------------------------------------------------------------- */
/*  Primitive drawing helpers                                                  */
/* -------------------------------------------------------------------------- */

/** Normalised landmark → device pixel on the canvas. */
const toPixel = (point, width, height) => ({ x: point.x * width, y: point.y * height });

/** Trace a closed polyline through a list of landmark indices. */
function traceRing(ctx, landmarks, indices, width, height) {
  ctx.beginPath();
  indices.forEach((index, position) => {
    const { x, y } = toPixel(landmarks[index], width, height);
    if (position === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

/** Trace the face outline from MediaPipe's own connection table ({start,end} pairs). */
function traceConnections(ctx, landmarks, connections, width, height) {
  ctx.beginPath();
  for (const { start, end } of connections) {
    const from = toPixel(landmarks[start], width, height);
    const to = toPixel(landmarks[end], width, height);
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
  }
}

/** Rounded rectangle that degrades to a plain one on older canvas implementations. */
function roundedRect(ctx, x, y, width, height, radius) {
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    return;
  }
  ctx.beginPath();
  ctx.rect(x, y, width, height);
}

/* -------------------------------------------------------------------------- */
/*  Layers                                                                     */
/* -------------------------------------------------------------------------- */

/** One face: outline, eyelids, irises and the nose tip used for the pose signals. */
function drawFace(ctx, landmarks, theme, width, height, connections) {
  ctx.lineWidth = LINE_WIDTH;
  ctx.strokeStyle = theme.line;
  traceConnections(ctx, landmarks, connections, width, height);
  ctx.stroke();

  ctx.lineWidth = EYE_LINE_WIDTH;
  traceRing(ctx, landmarks, RIGHT_EYE_INDICES, width, height);
  traceRing(ctx, landmarks, LEFT_EYE_INDICES, width, height);
  ctx.stroke();

  // Irises are the gaze signal, so they get the accent colour to make them legible.
  ctx.fillStyle = theme.iris;
  for (const index of [...RIGHT_IRIS_INDICES, ...LEFT_IRIS_INDICES]) {
    const { x, y } = toPixel(landmarks[index], width, height);
    ctx.beginPath();
    ctx.arc(x, y, IRIS_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }

  // Nose tip — the landmark the whole pose estimate is built around.
  const nose = toPixel(landmarks[LANDMARK_INDEX.NOSE_TIP], width, height);
  ctx.fillStyle = theme.accent;
  ctx.beginPath();
  ctx.arc(nose.x, nose.y, POINT_RADIUS * 2, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Each meter's track spans ±2 × the threshold, so the "still looking" band is
 * always the middle half. Every value plotted against a meter is therefore
 * `angle / (2 × threshold)`.
 */
const METER_SPAN_IN_THRESHOLDS = 2;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * One threshold meter: a track, the "still looking" band, and a knob at the current
 * value. Showing the band is what makes the judgement inspectable rather than
 * mysterious — the user can watch the knob leave the band and understand why a
 * warning fired.
 *
 * @param {number} value      Signed value in units where 1 = one whole threshold.
 */
function drawMeter(ctx, { x, y, length, thickness, value }, theme) {
  ctx.fillStyle = theme.track;
  roundedRect(ctx, x, y, length, thickness, thickness / 2);
  ctx.fill();

  const bandLength = length / METER_SPAN_IN_THRESHOLDS;
  ctx.fillStyle = theme.trackBand;
  roundedRect(ctx, x + (length - bandLength) / 2, y, bandLength, thickness, thickness / 2);
  ctx.fill();

  const knobX = x + ((clamp(value, -1, 1) + 1) / 2) * length;
  ctx.fillStyle = theme.accent;
  ctx.beginPath();
  ctx.arc(knobX, y + thickness / 2, thickness / 2 + 1.5, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * The overlay's heads-up display: the current state (PRD §17) plus the two pose
 * meters. Meters are only drawn when a pose estimate is actually meaningful — one
 * face, and calibration finished — so they are never showing numbers derived from a
 * baseline that does not exist yet.
 */
function drawHud(ctx, snapshot, thresholds, width, height, theme, { showMeters }) {
  const padding = 12;
  const thickness = 8;
  const length = 132;

  // --- State chip -------------------------------------------------------
  const presentation = STATE_PRESENTATION[snapshot.state];
  const label = snapshot.calibrating
    ? "CALIBRATING"
    : (presentation?.short ?? "—");

  ctx.font = "600 13px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.textBaseline = "middle";
  const chipWidth = ctx.measureText(label).width + 22;
  const chipHeight = 26;

  ctx.fillStyle = theme.track;
  roundedRect(ctx, padding, padding, chipWidth, chipHeight, chipHeight / 2);
  ctx.fill();
  ctx.fillStyle = theme.accent;
  ctx.fillText(label, padding + 11, padding + chipHeight / 2 + 1);

  if (!showMeters) return;

  // --- Yaw meter (horizontal) -------------------------------------------
  const yawY = height - padding - thickness;
  drawMeter(
    ctx,
    {
      x: padding,
      y: yawY,
      length,
      thickness,
      value: snapshot.pose.yawDeg / (thresholds.yawThresholdDeg * METER_SPAN_IN_THRESHOLDS),
    },
    theme,
  );

  // --- Pitch meter (the same drawing, rotated a quarter turn) -----------
  // Rotating by -90° turns the local +x axis upward, so a positive value (head
  // pitched up) moves the knob up the screen with no bespoke maths.
  ctx.save();
  ctx.translate(padding + thickness / 2, yawY - padding);
  ctx.rotate(-Math.PI / 2);
  drawMeter(
    ctx,
    {
      x: 0,
      y: -thickness / 2,
      length: 44,
      thickness,
      value: snapshot.pose.pitchDeg / (thresholds.pitchThresholdDeg * METER_SPAN_IN_THRESHOLDS),
    },
    theme,
  );
  ctx.restore();
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Repaint the whole overlay for one frame.
 *
 * @param {object}  options
 * @param {HTMLCanvasElement} options.canvas
 * @param {HTMLVideoElement}  options.video
 * @param {Array<Array<object>>} options.faces       Detected faces, if any.
 * @param {object}  options.snapshot                 Engine snapshot for this frame.
 * @param {object}  options.thresholds               The active sensitivity preset.
 * @param {Array}   options.faceConnections          Face-oval connections from MediaPipe.
 */
export function drawOverlay({ canvas, video, faces, snapshot, thresholds, faceConnections }) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Match the drawing surface to the video's intrinsic resolution so one landmark
  // unit maps to the same pixel in both layers. Only resize when it actually changed:
  // assigning width/height clears the canvas and is comparatively expensive.
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  if (videoWidth === 0 || videoHeight === 0) return;
  if (canvas.width !== videoWidth || canvas.height !== videoHeight) {
    canvas.width = videoWidth;
    canvas.height = videoHeight;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!faces || faces.length === 0) return;

  const theme = readTheme(canvas, snapshot.state);

  // Face 0 is the one the engine measures. Any extra faces are outlined faintly so
  // the user can see what triggered the multiple-face condition, then skipped.
  for (let index = 1; index < faces.length; index += 1) {
    ctx.save();
    ctx.globalAlpha = 0.25;
    drawFace(ctx, faces[index], theme, canvas.width, canvas.height, faceConnections);
    ctx.restore();
  }

  drawFace(ctx, faces[0], theme, canvas.width, canvas.height, faceConnections);

  drawHud(ctx, snapshot, thresholds, canvas.width, canvas.height, theme, {
    // A pose estimate only means something once there is exactly one face and a
    // learned baseline to compare it against.
    showMeters: faces.length === 1 && !snapshot.calibrating,
  });
}
