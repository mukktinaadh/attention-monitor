/**
 * syntheticFace.js — a 478-point face with exactly known geometry, for tests.
 *
 * WHY THIS EXISTS
 * The estimator and the engine are the two pieces whose behaviour we can and should
 * verify without a webcam. Feeding them real MediaPipe output would make the tests
 * depend on a model, a browser and a lighting condition; feeding them a face whose yaw
 * ratio is *defined* to be 0.1 makes the assertions exact and the failures readable.
 *
 * The builder is the inverse of the estimator: it places the nose and the irises so
 * that `extractFaceSignals` reads back precisely the requested `yawRatio`,
 * `pitchRatio`, `gazeX` and `gazeY`. That inversion is the point — if the estimator's
 * formulas change, these tests break, which is exactly the alarm we want.
 *
 * THE OVERLAP THAT MAKES THIS DELICATE
 * The four pose anchors (mesh 33, 133, 263, 362) are *also* members of the eyelid ring
 * index sets, and in each ring they are the outermost and innermost points. So the
 * builder cannot place them freely: whatever the pose geometry decides for a corner is
 * also what defines that eye's horizontal extent, and therefore the aperture the gaze
 * signal is normalised by. The layout below keeps both roles consistent rather than
 * fighting them.
 *
 * `rollDeg: 0` is the case where the inversion is exact to floating-point precision;
 * that is the configuration every gaze assertion uses.
 */
import {
  FULL_LANDMARK_COUNT,
  LANDMARK_INDEX,
  LEFT_EYE_INDICES,
  LEFT_IRIS_INDICES,
  RIGHT_EYE_INDICES,
  RIGHT_IRIS_INDICES,
} from "../vision/attentionEstimator";

/**
 * Sensible defaults roughly matching the proportions of a real face.
 * `eyeInset` is where each eye's inner corner sits as a fraction of the inter-eye
 * distance, measured from the outer corner.
 */
const DEFAULTS = {
  /** Signed nose displacement, as a multiple of the inter-eye distance. */
  yawRatio: 0,
  /** Signed vertical nose displacement, as a multiple of the inter-eye distance. */
  pitchRatio: 0,
  /** Iris offset inside the eye opening, as a fraction of the aperture. */
  gazeX: 0,
  gazeY: 0,
  /** Head tilt in degrees. */
  rollDeg: 0,
  /** Distance between the two outer eye corners, in normalised image units. */
  eyeSpanX: 0.2,
};

/** Inner-corner placement, as a multiple of the inter-eye distance. */
const INNER_CORNER_INSET = 0.56;

/** Aperture height, as a multiple of the inter-eye distance. */
const APERTURE_HEIGHT_RATIO = 0.16;

/** A bare landmark that is never read by a test assertion. */
const point = (x, y) => ({ x, y, z: 0, visibility: 1 });

/**
 * Place one eye's lid ring and iris.
 *
 * @param {Array} landmarks
 * @param {number[]} ringIndices  Traversal order; `[0]` is the outer corner and `[8]`
 *                                the inner one, both of which are pose anchors and are
 *                                therefore left exactly where `buildEyeLine` put them.
 */
function placeEye(landmarks, ringIndices, irisIndices, centre, apertureHeight, gazeX, gazeY) {
  const outerCornerIndex = ringIndices[0];
  const innerCornerIndex = ringIndices[8];

  // Collapse the remaining lid points onto the eye centre...
  for (const index of ringIndices) {
    if (index === outerCornerIndex || index === innerCornerIndex) continue;
    landmarks[index] = point(centre.x, centre.y);
  }

  // ...then pull the two eyelid points apart vertically, which is what gives the
  // aperture a height for the vertical gaze signal to be normalised by. Index 12 is
  // the upper lid and index 4 the lower lid in MediaPipe's own connection order.
  landmarks[ringIndices[12]] = point(centre.x, centre.y - apertureHeight / 2);
  landmarks[ringIndices[4]] = point(centre.x, centre.y + apertureHeight / 2);

  // The horizontal aperture is defined by the two corner anchors, so read it back
  // rather than assuming a width — the corners may lie on a tilted eye line.
  const apertureWidth = Math.abs(
    landmarks[innerCornerIndex].x - landmarks[outerCornerIndex].x,
  );

  // Offsets expressed as a fraction of the aperture, which is exactly how the
  // estimator reads them back out.
  const irisX = centre.x + gazeX * apertureWidth;
  const irisY = centre.y + gazeY * apertureHeight;
  for (const index of irisIndices) landmarks[index] = point(irisX, irisY);
}

/**
 * Build a face.
 *
 * @param {object} [options] Any subset of DEFAULTS.
 * @returns {Array<{x:number,y:number,z:number,visibility:number}>} 478 landmarks.
 */
export function makeFace(options = {}) {
  const { yawRatio, pitchRatio, gazeX, gazeY, rollDeg, eyeSpanX } = {
    ...DEFAULTS,
    ...options,
  };

  const landmarks = Array.from({ length: FULL_LANDMARK_COUNT }, () => point(0.5, 0.5));

  // --- Eye line, rotated about its own midpoint to produce roll -------------
  const rollRadians = (rollDeg * Math.PI) / 180;
  const direction = { x: Math.cos(rollRadians), y: Math.sin(rollRadians) };
  const halfSpan = eyeSpanX / 2;

  const outerA = point(0.5 - halfSpan * direction.x, 0.5 - halfSpan * direction.y);
  const outerB = point(0.5 + halfSpan * direction.x, 0.5 + halfSpan * direction.y);
  landmarks[LANDMARK_INDEX.EYE_OUTER_A] = outerA;
  landmarks[LANDMARK_INDEX.EYE_OUTER_B] = outerB;

  /**
   * The span the estimator will measure. A rotation about the midpoint leaves the
   * midpoint where it was, so yaw and pitch stay independent of roll — which is what
   * lets the tests vary them separately — but the horizontal span itself shrinks by
   * cos(roll), and every derived measurement has to use the shrunken value.
   */
  const span = Math.abs(outerB.x - outerA.x);

  // Inner corners sit along the same eye line, keeping all four pose anchors
  // collinear. Moving them off the line would tilt the eye line and change the roll.
  const innerA = point(
    outerA.x + direction.x * span * INNER_CORNER_INSET,
    outerA.y + direction.y * span * INNER_CORNER_INSET,
  );
  const innerB = point(
    outerB.x - direction.x * span * INNER_CORNER_INSET,
    outerB.y - direction.y * span * INNER_CORNER_INSET,
  );
  landmarks[LANDMARK_INDEX.EYE_INNER_A] = innerA;
  landmarks[LANDMARK_INDEX.EYE_INNER_B] = innerB;

  // Invert the estimator's definitions exactly:
  //   yawRatio   = (nose.x - eyeMid.x) / span
  //   pitchRatio = (eyeMid.y - nose.y) / span
  const eyeMid = { x: (outerA.x + outerB.x) / 2, y: (outerA.y + outerB.y) / 2 };
  landmarks[LANDMARK_INDEX.NOSE_TIP] = point(
    eyeMid.x + yawRatio * span,
    eyeMid.y - pitchRatio * span,
  );

  // --- Eyes and irises ------------------------------------------------------
  const apertureHeight = span * APERTURE_HEIGHT_RATIO;
  placeEye(
    landmarks,
    RIGHT_EYE_INDICES,
    RIGHT_IRIS_INDICES,
    { x: (outerA.x + innerA.x) / 2, y: (outerA.y + innerA.y) / 2 },
    apertureHeight,
    gazeX,
    gazeY,
  );
  placeEye(
    landmarks,
    LEFT_EYE_INDICES,
    LEFT_IRIS_INDICES,
    { x: (outerB.x + innerB.x) / 2, y: (outerB.y + innerB.y) / 2 },
    apertureHeight,
    gazeX,
    gazeY,
  );

  return landmarks;
}
