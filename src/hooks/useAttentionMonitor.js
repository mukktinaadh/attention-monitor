/**
 * useAttentionMonitor.js — the orchestration layer.
 *
 * RESPONSIBILITY SPLIT (the reason this file is short)
 *   • vision/attentionEstimator.js  — mathematics. Pure functions.
 *   • vision/monitoringEngine.js    — time. Pure logic, injected clock.
 *   • this file                     — browsers. Camera, animation loop, speech, React.
 *
 * Everything browser-specific and everything React-specific lives here so the two
 * layers below it stay portable and testable.
 *
 * THE FRAME LOOP
 *
 *   requestAnimationFrame ─▶ throttle to DETECTION_INTERVAL_MS
 *                                    │
 *                                    ├─▶ MediaPipe detectForVideo(video) ─▶ landmarks
 *                                    ├─▶ engine.update(landmarks)        ─▶ snapshot
 *                                    ├─▶ drawOverlay(canvas, …)          ← imperative, every frame
 *                                    └─▶ setSnapshot(…)                  ← throttled to 10 Hz
 *
 * The overlay is painted imperatively on every processed frame so it stays welded to
 * the video; React state is only updated when the state changes or 100 ms has gone
 * by. That is what stops a 12 fps inference loop from causing 12 reconciliations a
 * second for numbers nobody can read that fast anyway.
 *
 * PRIVACY
 * `getUserMedia` hands us a MediaStream that is assigned to `<video>.srcObject`. The
 * frames are read from that element and pushed straight into a WASM model in this
 * tab. There is no `fetch`, no `XMLHttpRequest`, no WebSocket and no persistence
 * anywhere in the path from camera to decision — see the README for the audit.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DETECTION_INTERVAL_MS,
  DEFAULT_MONITORING_CONFIG,
  DEFAULT_SENSITIVITY,
  SENSITIVITY_PRESETS,
  SNAPSHOT_PUBLISH_INTERVAL_MS,
  VOICE_ALERTS_DEFAULT_ON,
  VOICE_ALERT_TEXT,
} from "../config/constants";
import {
  detectFaceLandmarks,
  disposeFaceLandmarker,
  getFaceOvalConnections,
  loadFaceLandmarker,
} from "../vision/faceLandmarker";
import { AttentionMonitorEngine, ENGINE_EVENT } from "../vision/monitoringEngine";
import { drawOverlay } from "../vision/overlayRenderer";

/** A problem the user can act on: a short message plus a concrete next step. */
const setupError = (message, hint) => ({ message, hint });

/**
 * Translate the `DOMException` names `getUserMedia` produces into something a person
 * can act on (PRD §26). Every browser reports these as terse names like
 * "NotReadableError", which is useless on its own.
 */
function describeCameraError(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return setupError(
        "Camera access was blocked.",
        "Allow camera access for this site (the camera icon in the address bar), then " +
          "press “Start camera” again. The video is analysed in this tab only and is " +
          "never recorded or uploaded.",
      );
    case "NotFoundError":
    case "OverconstrainedError":
      return setupError(
        "No camera was found.",
        "Connect a webcam and reload the page. On a laptop, check that the built-in " +
          "camera is not disabled in your system privacy settings.",
      );
    case "NotReadableError":
      return setupError(
        "The camera is already in use.",
        "Another app or tab is holding the camera. Close it, then press “Start camera” again.",
      );
    case "AbortError":
      return setupError(
        "The camera stopped before it could start.",
        "Try again. If it keeps failing, reload the page.",
      );
    default:
      return setupError(
        `The camera could not be started${error?.name ? ` (${error.name})` : ""}.`,
        error?.message ?? "Reload the page and try again.",
      );
  }
}

/** Normalise anything thrown during setup into `{ message, hint }`. */
function toSetupError(error) {
  if (error && typeof error.message === "string") {
    return setupError(error.message, error.hint ?? "");
  }
  return setupError("Something went wrong while starting the monitor.", String(error ?? ""));
}

/**
 * @returns {object} Everything the dashboard needs: refs to attach, the current
 *   snapshot, session controls, and the flags the UI renders notices from.
 */
export function useAttentionMonitor() {
  /* ---------------------------------------------------------------------- */
  /*  Refs: values the animation loop reads without causing re-renders       */
  /* ---------------------------------------------------------------------- */

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const landmarkerRef = useRef(null);
  const streamRef = useRef(null);
  const frameHandleRef = useRef(null);

  const lastDetectAtRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const lastPublishAtRef = useRef(0);
  const publishedStateRef = useRef(null);

  /** Mirrors `voiceEnabled` for the speech path, which runs outside React renders. */
  const voiceEnabledRef = useRef(VOICE_ALERTS_DEFAULT_ON);
  const isRunningRef = useRef(false);

  /** Active thresholds, read by the overlay each frame. */
  const thresholdsRef = useRef(SENSITIVITY_PRESETS[DEFAULT_SENSITIVITY]);

  /* ---------------------------------------------------------------------- */
  /*  React state: low-frequency, user-visible                              */
  /* ---------------------------------------------------------------------- */

  const [isRunning, setIsRunning] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [voiceEnabled, setVoiceEnabled] = useState(VOICE_ALERTS_DEFAULT_ON);
  const [sensitivity, setSensitivity] = useState(DEFAULT_SENSITIVITY);
  const [lookAwayThresholdMs, setLookAwayThresholdMs] = useState(
    DEFAULT_MONITORING_CONFIG.lookAwayThresholdMs,
  );

  /**
   * Is the browser able to speak at all? Checked once, and surfaced to the UI so the
   * voice toggle can be disabled with an explanation instead of silently doing
   * nothing when pressed (PRD §26 — "speech synthesis unavailable").
   */
  const speechSupported = useMemo(
    () =>
      typeof window !== "undefined" &&
      "speechSynthesis" in window &&
      typeof window.SpeechSynthesisUtterance === "function",
    [],
  );

  /* ---------------------------------------------------------------------- */
  /*  Engine: created once, for the lifetime of the hook                     */
  /* ---------------------------------------------------------------------- */

  /**
   * The engine instance, created once by a lazy state initialiser.
   *
   * A ref would be the reflexive choice here, but refs must not be written during
   * render — and the engine has to exist before the first snapshot can be read out of
   * it. A lazy `useState` initialiser gives a value created exactly once, stable for
   * the component's lifetime, and legal to read while rendering.
   *
   * It is constructed *without* an event handler. The handler is attached in an effect
   * below so that it can close over fresh React state; the engine starts emitting
   * nothing until the user presses Start, by which point the effect has long since run.
   */
  const [engine] = useState(
    () => new AttentionMonitorEngine({ config: DEFAULT_MONITORING_CONFIG }),
  );

  const [snapshot, setSnapshot] = useState(() => engine.getSnapshot());

  /* ---------------------------------------------------------------------- */
  /*  Speech (PRD §12)                                                      */
  /* ---------------------------------------------------------------------- */

  const speak = useCallback(
    (text) => {
      // The toggle is authoritative, and it is read from the ref so the animation
      // loop and this callback never disagree about the current setting.
      if (!voiceEnabledRef.current || !speechSupported) return;
      try {
        // Cancel anything still being spoken: a queue of reminders would keep
        // talking long after the user looked back at the camera.
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.95;
        utterance.volume = 1;
        window.speechSynthesis.speak(utterance);
      } catch (speechError) {
        setNotice(`The voice alert could not be played. ${speechError?.message ?? ""}`.trim());
      }
    },
    [speechSupported],
  );

  /**
   * Route engine events to their browser effects. Only one event causes a sound.
   *
   * Re-attached whenever `speak` changes (it depends on whether the browser supports
   * speech), so the engine always calls the current handler without holding a stale
   * closure over React state.
   */
  useEffect(() => {
    engine.setEventHandler((type) => {
      // The engine has already applied the cooldown and decided the timing; this is
      // the only place a spoken alert can originate, so there is exactly one code
      // path from "user looked away too long" to "the browser speaks" to audit.
      if (type === ENGINE_EVENT.VOICE_ALERT) speak(VOICE_ALERT_TEXT);
    });
    return () => engine.setEventHandler(null);
  }, [engine, speak]);

  /** Keep the engine's runtime-configurable thresholds in sync with the controls. */
  useEffect(() => {
    const activeThresholds = SENSITIVITY_PRESETS[sensitivity];
    thresholdsRef.current = activeThresholds;
    engine.setConfig({ ...activeThresholds, lookAwayThresholdMs });
  }, [engine, sensitivity, lookAwayThresholdMs]);

  /* ---------------------------------------------------------------------- */
  /*  Lifecycle                                                             */
  /* ---------------------------------------------------------------------- */

  const stopLoop = useCallback(() => {
    if (frameHandleRef.current !== null) {
      cancelAnimationFrame(frameHandleRef.current);
      frameHandleRef.current = null;
    }
  }, []);

  /** Release the camera and stop the loop. Idempotent, so cleanup is always safe. */
  const teardown = useCallback(() => {
    stopLoop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;

    lastVideoTimeRef.current = -1;
    lastDetectAtRef.current = 0;
    publishedStateRef.current = null;
  }, [stopLoop]);

  /** Stop monitoring but keep the loaded model — recreating it costs a WASM boot. */
  const stop = useCallback(() => {
    teardown();
    isRunningRef.current = false;
    setIsRunning(false);
    // Park the engine in NO_FACE so the dashboard does not freeze on the last
    // judgement it made, which would look like live data.
    engine.reset();
    setSnapshot(engine.getSnapshot());
  }, [engine, teardown]);

  /**
   * One processed frame. Returns early unless the camera has a fresh frame ready, so
   * this is safe to call from every animation frame.
   */
  const processFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const landmarker = landmarkerRef.current;
    if (!video || !canvas || !landmarker) return;
    if (video.readyState < 2 || video.videoWidth === 0) return;

    const now = performance.now();
    // Cap inference so the WASM model cannot saturate the main thread.
    if (now - lastDetectAtRef.current < DETECTION_INTERVAL_MS) return;
    // MediaPipe needs monotonically increasing timestamps, and reprocessing the same
    // frame would waste inference on data we have already seen.
    if (video.currentTime === lastVideoTimeRef.current) return;
    lastDetectAtRef.current = now;
    lastVideoTimeRef.current = video.currentTime;

    let faces;
    try {
      faces = detectFaceLandmarks(landmarker, video, now);
    } catch (inferenceError) {
      // An inference failure means the WASM runtime is gone; continuing would spin
      // the loop forever producing nothing, so stop with an explanation instead.
      setError(
        setupError(
          "Face detection stopped unexpectedly.",
          `${inferenceError?.message ?? ""} Press “Start camera” to restart the monitor.`,
        ),
      );
      stop();
      return;
    }

    const nextSnapshot = engine.update({ timestampMs: now, faces });

    // Overlay first, and unconditionally: it must keep up with the video.
    drawOverlay({
      canvas,
      video,
      faces,
      snapshot: nextSnapshot,
      thresholds: thresholdsRef.current,
      faceConnections: getFaceOvalConnections(),
    });

    // ...then tell React, but only when it matters.
    const stateChanged = nextSnapshot.state !== publishedStateRef.current;
    if (stateChanged || now - lastPublishAtRef.current >= SNAPSHOT_PUBLISH_INTERVAL_MS) {
      publishedStateRef.current = nextSnapshot.state;
      lastPublishAtRef.current = now;
      setSnapshot(nextSnapshot);
    }
  }, [engine, stop]);

  const runLoop = useCallback(() => {
    const tick = () => {
      frameHandleRef.current = requestAnimationFrame(tick);
      processFrame();
    };
    frameHandleRef.current = requestAnimationFrame(tick);
  }, [processFrame]);

  /** Request the camera, load the model, and start monitoring (PRD §6, §22). */
  const start = useCallback(async () => {
    if (isRunningRef.current || isStarting) return;
    setError(null);
    setNotice(null);
    setIsStarting(true);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw setupError(
          "This browser cannot access the camera.",
          "Camera access requires a secure context (https:// or localhost) and a " +
            "browser with MediaDevices support. Try a recent version of Chrome, Edge, " +
            "Firefox or Safari over https or on localhost.",
        );
      }

      let stream;
      try {
        // PRD §6 — video only. We never request the microphone.
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (cameraError) {
        throw describeCameraError(cameraError);
      }
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) throw setupError("The video element is not available.", "Reload the page.");
      video.srcObject = stream;
      // `play()` rejects if the element is not yet in the document, so this is part
      // of the failure story rather than a fire-and-forget call.
      await video.play();

      // Load the model lazily and only once. A failure here carries its own
      // actionable hint from the vision layer.
      if (landmarkerRef.current === null) {
        landmarkerRef.current = await loadFaceLandmarker();
      }

      // A restart after a stop begins a new session with a fresh baseline.
      engine.reset();
      isRunningRef.current = true;
      setIsRunning(true);
      setSnapshot(engine.getSnapshot());
      runLoop();
    } catch (startError) {
      // Never leave a half-acquired camera behind.
      teardown();
      isRunningRef.current = false;
      setIsRunning(false);
      setError(toSetupError(startError));
    } finally {
      setIsStarting(false);
    }
  }, [engine, isStarting, runLoop, teardown]);

  /** Clear metrics, timers and the learned baseline (PRD §25). */
  const resetSession = useCallback(() => {
    engine.reset();
    setSnapshot(engine.getSnapshot());
  }, [engine]);

  /** Re-learn the neutral pose without restarting the session (PRD §8). */
  const recalibrate = useCallback(() => {
    engine.recalibrate();
    setSnapshot(engine.getSnapshot());
  }, [engine]);

  /* ---------------------------------------------------------------------- */
  /*  Controls                                                              */
  /* ---------------------------------------------------------------------- */

  const changeVoiceEnabled = useCallback(
    (enabled) => {
      voiceEnabledRef.current = enabled;
      setVoiceEnabled(enabled);
      if (!enabled && speechSupported) {
        // Stop mid-sentence rather than finishing a warning the user just disabled.
        window.speechSynthesis.cancel();
      }
    },
    [speechSupported],
  );

  const changeSensitivity = useCallback((next) => {
    if (SENSITIVITY_PRESETS[next]) setSensitivity(next);
  }, []);

  /* ---------------------------------------------------------------------- */
  /*  Teardown on unmount                                                   */
  /* ---------------------------------------------------------------------- */

  useEffect(
    () => () => {
      teardown();
      // The WASM runtime and its GPU buffers are the heaviest thing we hold, so they
      // are only released when the component really goes away.
      disposeFaceLandmarker(landmarkerRef.current);
      landmarkerRef.current = null;
    },
    [teardown],
  );

  /* ---------------------------------------------------------------------- */

  return {
    // Element refs for the camera view to attach.
    videoRef,
    canvasRef,

    snapshot,
    isRunning,
    isStarting,
    error,
    notice,
    speechSupported,

    voiceEnabled,
    sensitivity,
    lookAwayThresholdMs,

    start,
    stop,
    resetSession,
    recalibrate,
    changeVoiceEnabled,
    changeSensitivity,
    setLookAwayThresholdMs,
  };
}
