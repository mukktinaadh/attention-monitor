/**
 * monitoringEngine.test.js — the temporal behaviour, verified without waiting.
 *
 * The engine takes its clock through the constructor, so "look away for two seconds"
 * is a loop of `update()` calls rather than a `setTimeout`. These tests therefore run
 * in microseconds and are completely deterministic, while covering exactly the
 * behaviour PRD §9–§16 describes.
 */
import { describe, expect, it } from "vitest";
import { SENSITIVITY_PRESETS, STATE, YAW_GAIN } from "../config/constants";
import { makeFace } from "../test/syntheticFace";
import { AttentionMonitorEngine, ENGINE_EVENT } from "./monitoringEngine";

/** The nose displacement that reads as `degrees` of head yaw. */
const yawRatioFor = (degrees) => YAW_GAIN * Math.sin((degrees * Math.PI) / 180);

/** A face that is unambiguously looking away, far outside any threshold band. */
const AWAY_FACE = makeFace({ yawRatio: yawRatioFor(75) });

/** Timings that make the arithmetic easy to follow, in milliseconds. */
const TEST_CONFIG = {
  lookAwayThresholdMs: 2000,
  voiceCooldownMs: 5000,
  returnToCameraDwellMs: 350,
  noFaceGraceMs: 800,
  autoCalibrationMs: 1000,
  ...SENSITIVITY_PRESETS.balanced,
};

/**
 * A fake clock plus an event recorder.
 *
 * `step(faces, frames)` advances time by one frame interval per call, which is how the
 * engine is normally driven by the animation loop.
 */
function createHarness(config = TEST_CONFIG) {
  const events = [];
  const engine = new AttentionMonitorEngine({
    config,
    onEvent: (type, payload) => events.push({ type, payload }),
  });

  let now = 0;
  // Establish the clock, as the first real frame would.
  engine.update({ timestampMs: now, faces: [] });

  const step = (faces, frames = 1, frameMs = 100) => {
    for (let i = 0; i < frames; i += 1) {
      now += frameMs;
      engine.update({ timestampMs: now, faces });
    }
  };

  return {
    engine,
    events,
    step,
    /** Count of events of a given type. */
    count: (type) => events.filter((event) => event.type === type).length,
    snapshot: () => engine.getSnapshot(),
  };
}

/** Run the calibration window with the user looking at the camera. */
function calibrate(harness) {
  harness.step([makeFace()], 12);
  expect(harness.snapshot().calibrating).toBe(false);
}

describe("startup", () => {
  it("starts with no state, no metrics and calibration pending", () => {
    const snapshot = new AttentionMonitorEngine({ config: TEST_CONFIG }).getSnapshot();

    expect(snapshot.state).toBe(STATE.NO_FACE);
    expect(snapshot.calibrating).toBe(true);
    expect(snapshot.metrics.sessionDurationMs).toBe(0);
    expect(snapshot.metrics.warnings).toBe(0);
  });

  it("ignores the first frame, which only establishes the clock", () => {
    const engine = new AttentionMonitorEngine({ config: TEST_CONFIG });

    const snapshot = engine.update({ timestampMs: 1_000, faces: [makeFace()] });

    expect(snapshot.metrics.sessionDurationMs).toBe(0);
  });

  it("learns a neutral pose before judging anything", () => {
    const harness = createHarness();

    harness.step([makeFace()], 3);
    expect(harness.snapshot().calibrating).toBe(true);
    expect(harness.snapshot().state).toBe(STATE.LOOKING_AT_CAMERA);
    expect(harness.snapshot().calibrationProgress).toBeGreaterThan(0);

    harness.step([makeFace()], 10);
    expect(harness.snapshot().calibrating).toBe(false);
    expect(harness.snapshot().state).toBe(STATE.LOOKING_AT_CAMERA);
  });
});

describe("attention tracking", () => {
  it("reports looking at the camera while the user faces it", () => {
    const harness = createHarness();
    calibrate(harness);

    harness.step([makeFace()], 5);

    expect(harness.snapshot().state).toBe(STATE.LOOKING_AT_CAMERA);
    expect(harness.snapshot().isWarning).toBe(false);
  });

  it("moves to LOOKING_AWAY immediately but does not warn yet", () => {
    const harness = createHarness();
    calibrate(harness);

    harness.step([AWAY_FACE], 3);

    expect(harness.snapshot().state).toBe(STATE.LOOKING_AWAY);
    expect(harness.snapshot().awayElapsedMs).toBeGreaterThan(0);
    expect(harness.snapshot().metrics.warnings).toBe(0);
    expect(harness.count(ENGINE_EVENT.VOICE_ALERT)).toBe(0);
  });

  it("escalates to WARNING once the threshold is exceeded, and speaks once", () => {
    const harness = createHarness();
    calibrate(harness);

    harness.step([AWAY_FACE], 30); // 3 s away, past the 2 s threshold

    const snapshot = harness.snapshot();
    expect(snapshot.state).toBe(STATE.WARNING);
    expect(snapshot.isWarning).toBe(true);
    expect(snapshot.metrics.warnings).toBe(1);
    expect(harness.count(ENGINE_EVENT.WARNING_START)).toBe(1);
    expect(harness.count(ENGINE_EVENT.VOICE_ALERT)).toBe(1);
  });

  it("speaks once, waits out the cooldown, then reminds the user", () => {
    const harness = createHarness();
    calibrate(harness);

    harness.step([AWAY_FACE], 30); // warning fires, first alert speaks
    expect(harness.count(ENGINE_EVENT.VOICE_ALERT)).toBe(1);

    harness.step([AWAY_FACE], 20); // +2 s: still inside the 5 s cooldown
    expect(harness.count(ENGINE_EVENT.VOICE_ALERT)).toBe(1);

    harness.step([AWAY_FACE], 40); // +4 s: cooldown elapsed, one reminder
    expect(harness.count(ENGINE_EVENT.VOICE_ALERT)).toBe(2);

    // It is still the same warning episode, so the counter did not move.
    expect(harness.snapshot().metrics.warnings).toBe(1);
    expect(harness.count(ENGINE_EVENT.WARNING_START)).toBe(1);
  });

  it("returns to LOOKING_AT_CAMERA when the user looks back", () => {
    const harness = createHarness();
    calibrate(harness);

    harness.step([AWAY_FACE], 30);
    expect(harness.snapshot().state).toBe(STATE.WARNING);

    harness.step([makeFace()], 5);

    expect(harness.snapshot().state).toBe(STATE.LOOKING_AT_CAMERA);
    expect(harness.snapshot().metrics.warnings).toBe(1);
  });

  it("counts a second episode as a second warning", () => {
    const harness = createHarness();
    calibrate(harness);

    harness.step([AWAY_FACE], 30);
    harness.step([makeFace()], 10); // fully back
    harness.step([AWAY_FACE], 30);

    expect(harness.snapshot().metrics.warnings).toBe(2);
    expect(harness.count(ENGINE_EVENT.WARNING_START)).toBe(2);
  });
});

describe("hysteresis", () => {
  it("lets a real return to the camera reset the away timer", () => {
    const harness = createHarness();
    calibrate(harness);

    harness.step([AWAY_FACE], 15); // 1.5 s away: below threshold
    harness.step([makeFace()], 10); // 1 s back: past the 350 ms dwell, timer cleared
    harness.step([AWAY_FACE], 15); // 1.5 s away again: below threshold *from the reset*

    expect(harness.snapshot().metrics.warnings).toBe(0);
    expect(harness.snapshot().state).toBe(STATE.LOOKING_AWAY);
  });

  it("does not let a brief glance at the camera cancel an accumulating timer", () => {
    const harness = createHarness();
    calibrate(harness);

    harness.step([AWAY_FACE], 15); // 1.5 s away
    harness.step([makeFace()], 3); // 300 ms glance — under the 350 ms dwell
    harness.step([AWAY_FACE], 6); // 0.6 s away again

    // Total away time is 1.5 + 0.3 + 0.6 = 2.4 s, past the 2 s threshold. Had the
    // glance cleared the timer, only 0.6 s would have accumulated and nothing would
    // have fired. This is the single most important behaviour in the engine.
    expect(harness.snapshot().metrics.warnings).toBe(1);
  });

  it("tolerates a momentary tracking dropout without leaving the current state", () => {
    const harness = createHarness();
    calibrate(harness);

    harness.step([AWAY_FACE], 30);
    expect(harness.snapshot().state).toBe(STATE.WARNING);

    harness.step([], 1); // one frame with no face: inside the 800 ms grace window

    expect(harness.snapshot().state).toBe(STATE.WARNING);
    expect(harness.snapshot().metrics.noFaceEvents).toBe(0);
  });
});

describe("no face", () => {
  it("is its own state and cancels the look-away episode", () => {
    const harness = createHarness();
    calibrate(harness);
    harness.step([AWAY_FACE], 30);

    harness.step([], 1);
    harness.step([], 15); // 1.6 s with nobody in frame

    const snapshot = harness.snapshot();
    expect(snapshot.state).toBe(STATE.NO_FACE);
    expect(snapshot.metrics.noFaceEvents).toBe(1);
    // The earlier warning was already counted; leaving the frame starts a new episode,
    // so looking away again must accumulate a fresh threshold rather than resume.
    expect(snapshot.metrics.warnings).toBe(1);
    expect(snapshot.awayElapsedMs).toBe(0);
  });

  it("never raises a warning or speaks on its own", () => {
    const harness = createHarness();
    calibrate(harness);
    harness.events.length = 0;

    harness.step([], 40); // 4 s of an empty frame

    expect(harness.snapshot().state).toBe(STATE.NO_FACE);
    expect(harness.snapshot().metrics.warnings).toBe(0);
    expect(harness.count(ENGINE_EVENT.VOICE_ALERT)).toBe(0);
    expect(harness.count(ENGINE_EVENT.WARNING_START)).toBe(0);
  });

  it("counts one event per absence, not one per frame", () => {
    const harness = createHarness();
    calibrate(harness);

    harness.step([], 30);
    harness.step([makeFace()], 5);
    harness.step([], 30);

    expect(harness.snapshot().metrics.noFaceEvents).toBe(2);
  });
});

describe("multiple faces", () => {
  it("reports the condition without warning or speaking", () => {
    const harness = createHarness();
    calibrate(harness);
    harness.events.length = 0;

    harness.step([makeFace(), makeFace()], 20);

    const snapshot = harness.snapshot();
    expect(snapshot.state).toBe(STATE.MULTIPLE_FACES);
    expect(snapshot.facesDetected).toBe(2);
    expect(snapshot.metrics.multipleFaceEvents).toBe(1);
    expect(harness.count(ENGINE_EVENT.MULTIPLE_FACES)).toBe(1);
    expect(harness.count(ENGINE_EVENT.VOICE_ALERT)).toBe(0);
    expect(snapshot.metrics.warnings).toBe(0);
  });
});

describe("metrics", () => {
  it("keeps the time buckets summing to the session duration", () => {
    const harness = createHarness();
    calibrate(harness);

    harness.step([makeFace()], 10);
    harness.step([AWAY_FACE], 30);
    harness.step([], 20);
    harness.step([makeFace(), makeFace()], 10);
    harness.step([makeFace()], 5);

    const { metrics } = harness.snapshot();
    const summed =
      metrics.lookingAtCameraMs + metrics.lookingAwayMs + metrics.noFaceMs + metrics.multipleFaceMs;

    expect(summed).toBeCloseTo(metrics.sessionDurationMs, 6);
    expect(metrics.sessionDurationMs).toBeGreaterThan(0);
  });

  it("clamps a long stall so a backgrounded tab is not counted as attendance", () => {
    const harness = createHarness();
    calibrate(harness);
    const before = harness.snapshot().metrics.sessionDurationMs;

    // The browser throttles rAF in a hidden tab; a 10 s gap must not be attributed.
    harness.step([makeFace()], 1, 10_000);

    const attributed = harness.snapshot().metrics.sessionDurationMs - before;
    expect(attributed).toBeLessThanOrEqual(250);
  });
});

describe("session control", () => {
  it("reset() clears every metric and re-arms calibration", () => {
    const harness = createHarness();
    calibrate(harness);
    harness.step([AWAY_FACE], 30);
    expect(harness.snapshot().metrics.warnings).toBe(1);

    harness.engine.reset();

    const snapshot = harness.snapshot();
    expect(snapshot.state).toBe(STATE.NO_FACE);
    expect(snapshot.calibrating).toBe(true);
    expect(snapshot.metrics.sessionDurationMs).toBe(0);
    expect(snapshot.metrics.warnings).toBe(0);
    expect(snapshot.awayElapsedMs).toBe(0);
  });

  it("recalibrate() re-arms calibration without clearing the metrics", () => {
    const harness = createHarness();
    calibrate(harness);
    harness.step([makeFace()], 10);
    const { sessionDurationMs } = harness.snapshot().metrics;

    harness.engine.recalibrate();

    expect(harness.snapshot().calibrating).toBe(true);
    expect(harness.snapshot().metrics.sessionDurationMs).toBe(sessionDurationMs);
  });

  it("adopts a new threshold at runtime", () => {
    const harness = createHarness();
    calibrate(harness);

    harness.engine.setConfig({ lookAwayThresholdMs: 500 });
    harness.step([AWAY_FACE], 8); // 0.8 s away

    expect(harness.snapshot().state).toBe(STATE.WARNING);
  });
});
