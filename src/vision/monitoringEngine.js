/**
 * monitoringEngine.js — the temporal state machine.
 *
 * WHY A SEPARATE ENGINE EXISTS
 * A single webcam frame is a noisy, unreliable witness. Landmarks jitter, the
 * tracker loses the face for 100 ms, and a person blinks. Deciding "the user has
 * stopped paying attention" from one frame would fire warnings constantly.
 *
 * So this class owns everything that unfolds *over time*: smoothing, dwell timers,
 * hysteresis, warning escalation, the voice cooldown and the session metrics. It
 * reads no browser API and takes its clock through the constructor, which means the
 * whole thing — including "look away for 2 seconds and get a warning" — is
 * testable with a fake clock and zero waiting.
 *
 *      ┌──────────┐  face detected   ┌───────────────────┐
 *      │ NO_FACE  │─────────────────▶│ LOOKING_AT_CAMERA │◀──┐
 *      └──────────┘                  └───────────────────┘   │ user looks back
 *            ▲                                 │             │
 *            │                        user looks away        │
 *      face lost                               ▼             │
 *            │                       ┌───────────────────┐   │
 *            └───────────────────────│  LOOKING_AWAY     │───┘
 *                                    └───────────────────┘
 *                                              │ threshold exceeded
 *                                              ▼
 *                                    ┌───────────────────┐
 *                                    │     WARNING       │  ＋ spoken alert
 *                                    └───────────────────┘   (rate-limited)
 *
 * MULTIPLE_FACES is a fifth state (PRD §15) that sits alongside NO_FACE: it is a
 * *condition report*, not a lapse of attention, so it never escalates to a spoken
 * warning and it holds none of the look-away timers open.
 */
import { DEFAULT_MONITORING_CONFIG, SIGNAL_SMOOTHING_MS, STATE } from "../config/constants";
import {
  computeNeutralFromSamples,
  createEmptyNeutral,
  estimateAttention,
  extractFaceSignals,
  smoothSignals,
} from "./attentionEstimator";

/**
 * The monitoring states are declared in `config/constants.js`, next to the strings
 * the UI renders for them. This engine only ever compares and returns them — it
 * holds no presentation copy of its own.
 */

/**
 * Events the engine emits to its host. The engine describes *what happened*; the
 * host decides what to do about it (speak, log, flash the screen). That split is
 * why the engine needs no knowledge of `speechSynthesis` or of React.
 */
export const ENGINE_EVENT = Object.freeze({
  /** Entered the WARNING state — a new warning episode started. */
  WARNING_START: "warningStart",
  /** Time to (re)speak the alert. Already rate-limited by the voice cooldown. */
  VOICE_ALERT: "voiceAlert",
  /** The face left the frame for longer than the grace window. */
  NO_FACE: "noFace",
  /** More than one face entered the frame. */
  MULTIPLE_FACES: "multipleFaces",
  /** Any state transition, with both the previous and the next state. */
  STATE_CHANGE: "stateChange",
});

/**
 * Longest frame gap we will attribute to the session. If the tab is backgrounded
 * the browser throttles `requestAnimationFrame`, and a 30 s gap must not be
 * counted as 30 s of "looking at the camera".
 */
const MAX_ATTRIBUTABLE_FRAME_MS = 250;

export class AttentionMonitorEngine {
  /**
   * @param {object}   [options]
   * @param {object}   [options.config]  Partial override of DEFAULT_MONITORING_CONFIG.
   * @param {Function} [options.onEvent] Called as `onEvent(type, payload)`.
   */
  constructor({ config = {}, onEvent = null } = {}) {
    this.config = { ...DEFAULT_MONITORING_CONFIG, ...config };
    this.onEvent = onEvent;
    this.reset();
  }

  /* ---------------------------------------------------------------------- */
  /*  Public API                                                            */
  /* ---------------------------------------------------------------------- */

  /** Merge new thresholds at runtime (the UI does this when a control changes). */
  setConfig(partial) {
    this.config = { ...this.config, ...partial };
  }

  /**
   * Attach or replace the event sink.
   *
   * Exposed as a method rather than as a writable field so the host can construct the
   * engine first and wire up its listener later — which is what the React hook needs,
   * since the handler closes over state that does not exist at construction time. It
   * also keeps the field private in spirit: nothing outside this class assigns it.
   *
   * @param {((type: string, payload: object) => void)|null} handler
   */
  setEventHandler(handler) {
    this.onEvent = handler ?? null;
  }

  /**
   * Feed one inference result to the engine.
   *
   * @param {object} frame
   * @param {number} frame.timestampMs Wall-clock timestamp, in ms (must be monotonic).
   * @param {Array<Array<{x:number,y:number,z:number}>>} frame.faces
   *        Zero or more detected faces, each an array of 478 normalised landmarks.
   * @returns {object} The resulting snapshot (see `getSnapshot`).
   */
  update({ timestampMs, faces }) {
    const faceCount = Array.isArray(faces) ? faces.length : 0;
    const dt = this.#advanceClock(timestampMs, faceCount);

    // First frame establishes the clock; there is no elapsed time to attribute yet.
    if (dt === null) return this.getSnapshot();

    if (faceCount === 0) {
      this.#handleNoFace(timestampMs, dt);
      return this.getSnapshot();
    }

    this.noFaceSinceMs = null;

    if (faceCount > 1) {
      this.#handleMultipleFaces(timestampMs, dt);
      return this.getSnapshot();
    }

    this.#handleSingleFace(timestampMs, dt, faces[0]);
    return this.getSnapshot();
  }

  /** Throw away every timer, metric and learned baseline — a brand new session. */
  reset() {
    this.state = STATE.NO_FACE;
    this.lastTimestampMs = null;

    this.calibrating = true;
    this.calibrationSamples = [];
    this.calibrationStartedAtMs = null;
    this.neutral = createEmptyNeutral();

    this.smoothedSignals = null;
    this.attention = null;

    this.awaySinceMs = null;
    this.cameraDwellMs = 0;
    this.noFaceSinceMs = null;

    this.lastVoiceAtMs = Number.NEGATIVE_INFINITY;
    this.facesDetected = 0;

    this.metrics = {
      sessionDurationMs: 0,
      lookingAtCameraMs: 0,
      lookingAwayMs: 0,
      noFaceMs: 0,
      multipleFaceMs: 0,
      warnings: 0,
      noFaceEvents: 0,
      multipleFaceEvents: 0,
    };
  }

  /**
   * Re-learn the neutral pose. Used both automatically at session start and by the
   * "Set neutral pose" button when a user shifts in their chair or the camera moves.
   */
  recalibrate() {
    this.calibrating = true;
    this.calibrationSamples = [];
    this.calibrationStartedAtMs = null;
    // Drop the smoothed history too, so old pose data cannot bleed into the new baseline.
    this.smoothedSignals = null;
    this.awaySinceMs = null;
    this.cameraDwellMs = 0;
  }

  /**
   * An immutable-for-practice view of everything the UI needs. A fresh object each
   * call, so React can compare it cheaply and never sees the engine mutate
   * underneath it.
   */
  getSnapshot() {
    const awayElapsedMs =
      this.awaySinceMs === null ? 0 : (this.lastTimestampMs ?? 0) - this.awaySinceMs;

    return {
      state: this.state,
      calibrating: this.calibrating,
      calibrationProgress: this.#calibrationProgress(),
      facesDetected: this.facesDetected,

      pose: {
        yawDeg: this.attention?.yawDeg ?? 0,
        pitchDeg: this.attention?.pitchDeg ?? 0,
        rollDeg: this.attention?.rollDeg ?? 0,
        gazeX: this.attention?.gazeX ?? null,
        gazeY: this.attention?.gazeY ?? null,
        irisAvailable: this.smoothedSignals?.irisAvailable ?? false,
        direction: this.attention?.direction ?? null,
        avertedReasons: this.attention?.avertedReasons ?? [],
      },

      /** How long the user has been away right now, and where the warning fires. */
      awayElapsedMs,
      lookAwayThresholdMs: this.config.lookAwayThresholdMs,

      isLookingAway: this.state === STATE.LOOKING_AWAY || this.state === STATE.WARNING,
      isWarning: this.state === STATE.WARNING,

      metrics: { ...this.metrics },
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Clock                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance the session clock and return the elapsed milliseconds.
   * @returns {number|null} null on the very first frame.
   */
  #advanceClock(timestampMs, faceCount) {
    this.facesDetected = faceCount;

    if (this.lastTimestampMs === null) {
      this.lastTimestampMs = timestampMs;
      return null;
    }

    // Clamp so a backgrounded tab or a paused feed cannot inflate the metrics.
    const dt = Math.min(Math.max(timestampMs - this.lastTimestampMs, 0), MAX_ATTRIBUTABLE_FRAME_MS);
    this.lastTimestampMs = timestampMs;
    this.metrics.sessionDurationMs += dt;
    return dt;
  }

  /**
   * Frame-rate independent EMA weight. A fixed alpha would smooth differently at
   * 15 fps than at 60 fps; deriving it from dt keeps the response identical.
   */
  #smoothingAlpha(dt) {
    return 1 - Math.exp(-dt / SIGNAL_SMOOTHING_MS);
  }

  /* ---------------------------------------------------------------------- */
  /*  Per-condition handlers                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * PRD §16 — no face is its own state, never an immediate "look at the camera".
   * A short grace window absorbs tracker dropouts; the episode is only counted once
   * it lasts longer than that.
   */
  #handleNoFace(timestampMs, dt) {
    if (this.noFaceSinceMs === null) this.noFaceSinceMs = timestampMs;
    const missingFor = timestampMs - this.noFaceSinceMs;

    // Momentary dropout: hold whatever state we were in and say nothing.
    if (missingFor < this.config.noFaceGraceMs && this.state !== STATE.NO_FACE) {
      this.metrics.noFaceMs += dt;
      return;
    }

    if (this.state !== STATE.NO_FACE) {
      this.metrics.noFaceEvents += 1;
      this.#emit(ENGINE_EVENT.NO_FACE, { timestampMs });
    }

    // Leaving the frame ends the look-away episode: that was absence, not distraction.
    this.awaySinceMs = null;
    this.cameraDwellMs = 0;
    // Forget the stale pose so a different person's face is never blended with the last one.
    this.smoothedSignals = null;
    this.attention = null;

    this.#setState(STATE.NO_FACE);
    this.metrics.noFaceMs += dt;
  }

  /** PRD §15 — report the condition, identify nobody, warn nobody. */
  #handleMultipleFaces(timestampMs, dt) {
    if (this.state !== STATE.MULTIPLE_FACES) {
      this.metrics.multipleFaceEvents += 1;
      this.#emit(ENGINE_EVENT.MULTIPLE_FACES, { facesDetected: this.facesDetected });
    }

    this.awaySinceMs = null;
    this.cameraDwellMs = 0;
    this.smoothedSignals = null;
    this.attention = null;

    this.#setState(STATE.MULTIPLE_FACES);
    this.metrics.multipleFaceMs += dt;
  }

  /** Exactly one face: measure it and run the attention logic. */
  #handleSingleFace(timestampMs, dt, landmarks) {
    // Smooth the raw ratios rather than the final angles: averaging the inputs is
    // linear and well-behaved, whereas averaging asin-transformed outputs is not.
    this.smoothedSignals = smoothSignals(
      this.smoothedSignals,
      extractFaceSignals(landmarks),
      this.#smoothingAlpha(dt),
    );

    if (this.calibrating) {
      this.#accumulateCalibration(timestampMs);
      // Deliberately report LOOKING_AT_CAMERA while calibrating: we have no baseline
      // to judge against yet, and the user has just started the session. The UI
      // shows a "calibrating" badge so this is never mistaken for a judgement.
      this.#setState(STATE.LOOKING_AT_CAMERA);
      this.metrics.lookingAtCameraMs += dt;
      return;
    }

    this.attention = estimateAttention(this.smoothedSignals, this.neutral, this.config);

    if (this.attention.isLookingAtCamera) {
      this.#handleLookingAtCamera(dt);
    } else {
      this.#handleLookingAway(timestampMs, dt);
    }
  }

  /**
   * The user is facing the camera.
   *
   * Note the asymmetry: the *displayed state* flips to LOOKING_AT_CAMERA on the very
   * first confident frame (the UI must feel instant when you look back), but the
   * look-away timer is only cleared after `returnToCameraDwellMs` of sustained
   * attention. One stray frame therefore cannot cancel a warning that was about to
   * fire — it can only delay the cancel.
   */
  #handleLookingAtCamera(dt) {
    this.cameraDwellMs += dt;
    if (this.cameraDwellMs >= this.config.returnToCameraDwellMs) {
      this.awaySinceMs = null;
    }
    this.#setState(STATE.LOOKING_AT_CAMERA);
    this.metrics.lookingAtCameraMs += dt;
  }

  /**
   * The user is facing away — either below the threshold (LOOKING_AWAY) or long
   * enough to escalate (WARNING).
   */
  #handleLookingAway(timestampMs, dt) {
    this.cameraDwellMs = 0;

    // Start the stopwatch on the first away frame, and never restart it while the
    // user keeps looking away — that is what makes the threshold a duration and not
    // a frame count.
    if (this.awaySinceMs === null) this.awaySinceMs = timestampMs;

    const awayFor = timestampMs - this.awaySinceMs;

    if (awayFor >= this.config.lookAwayThresholdMs) {
      this.#escalateToWarning(timestampMs);
    } else {
      this.#setState(STATE.LOOKING_AWAY);
    }

    this.metrics.lookingAwayMs += dt;
  }

  /**
   * WARNING state, plus the spoken alert.
   *
   * The voice cooldown is enforced *here* rather than by the host so it cannot be
   * bypassed by a second caller, and so the engine's own tests can assert it.
   *
   * Repeated reminders are intentional: while the user is still away and the
   * cooldown has elapsed, the alert is re-emitted. A cooldown would serve no
   * purpose at all if the sentence were ever spoken exactly once, and "continue
   * monitoring, speak again when appropriate" (PRD §13) reads as a reminder loop
   * rather than a one-shot. `metrics.warnings` still counts distinct episodes.
   */
  #escalateToWarning(timestampMs) {
    if (this.state !== STATE.WARNING) {
      this.metrics.warnings += 1;
      this.#emit(ENGINE_EVENT.WARNING_START, { timestampMs });
    }

    this.#setState(STATE.WARNING);

    if (timestampMs - this.lastVoiceAtMs >= this.config.voiceCooldownMs) {
      this.lastVoiceAtMs = timestampMs;
      this.#emit(ENGINE_EVENT.VOICE_ALERT, { timestampMs });
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Calibration                                                           */
  /* ---------------------------------------------------------------------- */

  #accumulateCalibration(timestampMs) {
    if (this.calibrationStartedAtMs === null) this.calibrationStartedAtMs = timestampMs;
    this.calibrationSamples.push(this.smoothedSignals);

    if (timestampMs - this.calibrationStartedAtMs < this.config.autoCalibrationMs) return;

    this.neutral = computeNeutralFromSamples(this.calibrationSamples);
    this.calibrating = false;
    this.calibrationSamples = [];
  }

  /** 0 → 1 progress for the calibration badge. */
  #calibrationProgress() {
    if (!this.calibrating) return 1;
    if (this.calibrationStartedAtMs === null || this.lastTimestampMs === null) return 0;
    const elapsed = this.lastTimestampMs - this.calibrationStartedAtMs;
    return Math.min(1, Math.max(0, elapsed / this.config.autoCalibrationMs));
  }

  /* ---------------------------------------------------------------------- */
  /*  Plumbing                                                              */
  /* ---------------------------------------------------------------------- */

  #setState(nextState) {
    if (this.state === nextState) return;
    const previous = this.state;
    this.state = nextState;
    this.#emit(ENGINE_EVENT.STATE_CHANGE, { previous, next: nextState });
  }

  #emit(type, payload) {
    this.onEvent?.(type, payload ?? {});
  }
}
