/**
 * attentionEstimator.test.js — the mathematics, verified without a camera.
 *
 * These tests are the reason the estimator was written as pure functions. Each one
 * feeds in a face with a *known* pose and asserts the measured angle, which is only
 * possible because the synthetic builder inverts the estimator's own formulas.
 */
import { describe, expect, it } from "vitest";
import { SENSITIVITY_PRESETS, YAW_GAIN } from "../config/constants";
import { makeFace } from "../test/syntheticFace";
import {
  computeNeutralFromSamples,
  estimateAttention,
  extractFaceSignals,
  hasIrisLandmarks,
  smoothSignals,
} from "./attentionEstimator";

const BALANCED = SENSITIVITY_PRESETS.balanced;

/** The nose displacement that should be measured as `degrees` of head yaw. */
const yawRatioFor = (degrees) => YAW_GAIN * Math.sin((degrees * Math.PI) / 180);

/** A neutral baseline learned from the frontal face, as the engine would learn it. */
const frontalNeutral = () => computeNeutralFromSamples([extractFaceSignals(makeFace())]);

describe("extractFaceSignals", () => {
  it("reads a frontal face as zero yaw, zero pitch and centred eyes", () => {
    const signals = extractFaceSignals(makeFace());

    expect(signals.yawRatio).toBeCloseTo(0, 12);
    expect(signals.pitchRatio).toBeCloseTo(0, 12);
    expect(signals.gazeX).toBeCloseTo(0, 12);
    expect(signals.gazeY).toBeCloseTo(0, 12);
    expect(signals.rollDeg).toBeCloseTo(0, 6);
    expect(signals.irisAvailable).toBe(true);
  });

  it("is scale invariant, so moving closer to the camera changes nothing", () => {
    const near = extractFaceSignals(makeFace({ eyeSpanX: 0.24, yawRatio: 0.1, pitchRatio: 0.05 }));
    const far = extractFaceSignals(makeFace({ eyeSpanX: 0.06, yawRatio: 0.1, pitchRatio: 0.05 }));

    // The face is four times smaller, and every ratio is identical.
    expect(far.yawRatio).toBeCloseTo(near.yawRatio, 12);
    expect(far.pitchRatio).toBeCloseTo(near.pitchRatio, 12);
  });

  it("reports head tilt as roll without disturbing yaw or pitch", () => {
    const tilted = extractFaceSignals(makeFace({ rollDeg: 20 }));

    expect(tilted.rollDeg).toBeCloseTo(20, 6);
    expect(tilted.yawRatio).toBeCloseTo(0, 12);
    expect(tilted.pitchRatio).toBeCloseTo(0, 12);
  });

  it("treats gaze as unavailable, not as zero, when the iris points are missing", () => {
    // 468 mesh points without the 10 iris refinements — what a stripped-down model
    // bundle would produce.
    const withoutIris = makeFace().slice(0, 468);
    const signals = extractFaceSignals(withoutIris);

    expect(hasIrisLandmarks(withoutIris)).toBe(false);
    expect(signals.gazeX).toBeNull();
    expect(signals.gazeY).toBeNull();
    expect(signals.irisAvailable).toBe(false);
    // Head pose is still measurable, so the app still works — just without gaze.
    expect(signals.yawRatio).toBeCloseTo(0, 12);
  });
});

describe("estimateAttention", () => {
  it("classifies a frontal face as looking at the camera", () => {
    const attention = estimateAttention(extractFaceSignals(makeFace()), frontalNeutral(), BALANCED);

    expect(attention.yawDeg).toBeCloseTo(0, 6);
    expect(attention.pitchDeg).toBeCloseTo(0, 6);
    expect(attention.isLookingAtCamera).toBe(true);
    expect(attention.direction).toBeNull();
    expect(attention.avertedReasons).toEqual([]);
  });

  it("converts a nose swing into the angle it represents", () => {
    const turned = estimateAttention(
      extractFaceSignals(makeFace({ yawRatio: yawRatioFor(30) })),
      frontalNeutral(),
      BALANCED,
    );

    expect(turned.yawDeg).toBeCloseTo(30, 4);
    expect(turned.isLookingAtCamera).toBe(false);
    expect(turned.avertedReasons).toContain("head turned");
    expect(turned.direction).not.toBeNull();
  });

  it("keeps a small head turn inside the threshold band", () => {
    const attention = estimateAttention(
      extractFaceSignals(makeFace({ yawRatio: yawRatioFor(15) })),
      frontalNeutral(),
      BALANCED,
    );

    expect(attention.isLookingAtCamera).toBe(true);
  });

  it("moves the same 25° turn in and out of the band as sensitivity changes", () => {
    const signals = extractFaceSignals(makeFace({ yawRatio: yawRatioFor(25) }));
    const neutral = frontalNeutral();

    // The measurement is identical in all three; only the tolerance differs, which is
    // the entire point of making it a user-facing control.
    expect(estimateAttention(signals, neutral, SENSITIVITY_PRESETS.relaxed).isLookingAtCamera).toBe(true);
    expect(estimateAttention(signals, neutral, BALANCED).isLookingAtCamera).toBe(false);
    expect(estimateAttention(signals, neutral, SENSITIVITY_PRESETS.strict).isLookingAtCamera).toBe(false);
  });

  it("detects the eyes looking aside even when the head does not move", () => {
    const attention = estimateAttention(
      extractFaceSignals(makeFace({ gazeX: 0.4 })),
      frontalNeutral(),
      BALANCED,
    );

    expect(attention.yawDeg).toBeCloseTo(0, 6);
    expect(attention.isLookingAtCamera).toBe(false);
    expect(attention.avertedReasons).toContain("eyes off-centre");
  });

  it("does not treat a head tilt as a loss of attention", () => {
    // Calibrated upright, then tilted. Roll is deliberately excluded from the
    // decision: tilting your head while still facing the camera is not distraction.
    const attention = estimateAttention(
      extractFaceSignals(makeFace({ rollDeg: 25 })),
      frontalNeutral(),
      BALANCED,
    );

    expect(attention.rollDeg).toBeCloseTo(25, 6);
    expect(attention.isLookingAtCamera).toBe(true);
  });

  it("judges against the calibrated baseline, not against zero", () => {
    // This user sits off to the side of their camera, so a "neutral" pose already has
    // a large raw yaw ratio. Calibrating must absorb it.
    const offAxis = extractFaceSignals(makeFace({ yawRatio: 0.12 }));
    const neutral = computeNeutralFromSamples([offAxis]);

    expect(estimateAttention(offAxis, neutral, BALANCED).yawDeg).toBeCloseTo(0, 6);
    expect(estimateAttention(offAxis, neutral, BALANCED).isLookingAtCamera).toBe(true);
  });

  it("still decides on head pose when gaze is unavailable", () => {
    const neutral = frontalNeutral();
    const noIris = extractFaceSignals(makeFace().slice(0, 468));
    const attention = estimateAttention(noIris, neutral, BALANCED);

    expect(attention.gazeX).toBeNull();
    expect(attention.isLookingAtCamera).toBe(true);
  });
});

describe("smoothSignals", () => {
  const base = {
    yawRatio: 0,
    pitchRatio: 0,
    rollDeg: 0,
    gazeX: 0,
    gazeY: 0,
    irisAvailable: true,
  };

  it("moves toward the new sample by exactly alpha", () => {
    const smoothed = smoothSignals({ ...base }, { ...base, yawRatio: 1 }, 0.5);

    expect(smoothed.yawRatio).toBeCloseTo(0.5, 12);
  });

  it("adopts a gaze value that was previously unavailable instead of averaging with null", () => {
    const smoothed = smoothSignals(
      { ...base, gazeX: null },
      { ...base, gazeX: 0.2 },
      0.5,
    );

    expect(smoothed.gazeX).toBe(0.2);
  });

  it("never invents a gaze value when the new sample has none", () => {
    const smoothed = smoothSignals({ ...base, gazeX: 0.2 }, { ...base, gazeX: null }, 0.5);

    expect(smoothed.gazeX).toBeNull();
  });

  it("returns the first sample unchanged when there is no history", () => {
    const smoothed = smoothSignals(null, { ...base, yawRatio: 0.3 }, 0.5);

    expect(smoothed.yawRatio).toBe(0.3);
  });
});

describe("computeNeutralFromSamples", () => {
  it("uses the median, so one glance away cannot shift the baseline", () => {
    const frontal = extractFaceSignals(makeFace());
    const glancing = extractFaceSignals(makeFace({ yawRatio: 0.3 }));

    const neutral = computeNeutralFromSamples([frontal, glancing, frontal, frontal]);

    expect(neutral.yawRatio).toBeCloseTo(frontal.yawRatio, 12);
  });

  it("returns a zero baseline when there is nothing to learn from", () => {
    expect(computeNeutralFromSamples([])).toEqual({
      yawRatio: 0,
      pitchRatio: 0,
      rollDeg: 0,
      gazeX: 0,
      gazeY: 0,
    });
  });
});
