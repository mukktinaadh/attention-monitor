/**
 * App.jsx — the dashboard shell.
 *
 * Composition only: it calls one hook and lays out four components. All of the
 * behaviour lives below it in `hooks/useAttentionMonitor` (browser orchestration),
 * `vision/monitoringEngine` (timing and decisions) and `vision/attentionEstimator`
 * (mathematics), so there is nothing here that needs a camera to reason about.
 *
 * The `data-tone` attribute on the root is the one piece of cross-cutting state: it
 * selects the `--state-accent` custom property that colours the status card, the
 * warning banner *and* the canvas overlay. One attribute, one palette.
 */
import CameraView from "./components/CameraView";
import Controls from "./components/Controls";
import MetricsPanel from "./components/MetricsPanel";
import StatusIndicator from "./components/StatusIndicator";
import { resolveStatePresentation } from "./config/constants";
import { useAttentionMonitor } from "./hooks/useAttentionMonitor";

/**
 * PRD §28 — the pipeline, stated plainly in the product itself.
 * Note the wording: this project *uses* a pretrained model, it does not train one.
 */
const PIPELINE_STEPS = [
  {
    title: "Webcam frame",
    detail: "Captured from a <video> element in this tab. Never serialised, never sent.",
  },
  {
    title: "Pretrained landmark model",
    detail:
      "A MediaPipe Face Landmarker running under WebAssembly on your CPU or GPU. Not trained here — downloaded once as a static asset.",
  },
  {
    title: "478 facial landmarks",
    detail: "Normalised points around the eyes, nose, mouth and face outline, including 10 iris points.",
  },
  {
    title: "Geometric analysis",
    detail:
      "Head yaw and pitch from landmark geometry, plus iris position. All measured against your own calibrated neutral pose.",
  },
  {
    title: "Attention state",
    detail:
      "One state, smoothed and timed over several seconds so a single noisy frame or a blink cannot raise a warning.",
  },
];

export default function App() {
  const {
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
  } = useAttentionMonitor();

  const presentation = resolveStatePresentation(snapshot);

  return (
    <div className="app" data-tone={presentation.tone}>
      <a className="skip-link" href="#dashboard">
        Skip to dashboard
      </a>

      <header className="masthead">
        <div className="masthead__inner">
          <div className="masthead__brand">
            <span className="masthead__mark" aria-hidden="true" />
            <div>
              <h1 className="masthead__title">AI Camera Attention Monitor</h1>
              <p className="masthead__subtitle">
                Real-time webcam attention estimation, computed entirely in your browser.
              </p>
            </div>
          </div>
          <p className="badge">No API key · No backend · No upload</p>
        </div>
      </header>

      <main id="dashboard" className="dashboard">
        {/* ---------- Feedback regions ---------- */}

        {error && (
          <div className="alert alert--error" role="alert">
            <div className="alert__body">
              <p className="alert__title">{error.message}</p>
              {error.hint && <p className="alert__hint">{error.hint}</p>}
            </div>
            <button type="button" className="button button--primary" onClick={start}>
              Try again
            </button>
          </div>
        )}

        {notice && (
          <div className="alert alert--notice" role="status">
            <p className="alert__title">{notice}</p>
          </div>
        )}

        {/*
          The prominent visual warning (PRD §11). role="alert" is assertive, which is
          correct here: it is the one message the user must not miss.
        */}
        {snapshot.isWarning && (
          <div className="warning-banner" role="alert">
            <span className="warning-banner__glyph" aria-hidden="true">
              ⚠️
            </span>
            <p className="warning-banner__text">Please look at the camera</p>
            {voiceEnabled && <span className="warning-banner__tag">speaking</span>}
          </div>
        )}

        {/* ---------- Dashboard ---------- */}

        <div className="dashboard__grid">
          <div className="dashboard__main">
            <CameraView
              videoRef={videoRef}
              canvasRef={canvasRef}
              isRunning={isRunning}
              isStarting={isStarting}
            />
          </div>

          <div className="dashboard__side">
            <StatusIndicator snapshot={snapshot} />
            <Controls
              isRunning={isRunning}
              isStarting={isStarting}
              onStart={start}
              onStop={stop}
              onRecalibrate={recalibrate}
              onResetSession={resetSession}
              voiceEnabled={voiceEnabled}
              speechSupported={speechSupported}
              onVoiceChange={changeVoiceEnabled}
              sensitivity={sensitivity}
              onSensitivityChange={changeSensitivity}
              lookAwayThresholdMs={lookAwayThresholdMs}
              onLookAwayThresholdChange={setLookAwayThresholdMs}
            />
            <MetricsPanel snapshot={snapshot} />
          </div>
        </div>

        {/* ---------- Explanations ---------- */}

        <section className="card explainer" aria-labelledby="pipeline-title">
          <header className="card__header">
            <h2 className="card__title" id="pipeline-title">
              How it works
            </h2>
          </header>
          <ol className="pipeline">
            {PIPELINE_STEPS.map((step, index) => (
              <li className="pipeline__step" key={step.title}>
                <span className="pipeline__index" aria-hidden="true">
                  {index + 1}
                </span>
                <div>
                  <p className="pipeline__title">{step.title}</p>
                  <p className="pipeline__detail">{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="explainer__caveat">
            <strong>This is an approximation, not eye tracking.</strong> Head orientation
            and rough eye position are estimates from 2D landmarks. They cannot tell the
            difference between reading notes off to one side and being distracted, and
            they say nothing about anyone&apos;s intentions.
          </p>
        </section>

        <section className="card privacy" aria-labelledby="privacy-title">
          <header className="card__header">
            <h2 className="card__title" id="privacy-title">
              Privacy
            </h2>
          </header>
          <p className="privacy__lead">
            Your camera is processed locally in your browser. No video is uploaded or
            stored.
          </p>
          <ul className="privacy__list">
            <li>Frames are read from the page and passed to a WASM model in this tab.</li>
            <li>There is no backend, no database, no account and no API key.</li>
            <li>Session metrics exist in memory only and disappear when the tab closes.</li>
            <li>No identity recognition of any kind is performed.</li>
          </ul>
        </section>
      </main>

      <footer className="colophon">
        <p>
          Local-first by design: the only network request the app can make is for its own
          static assets. See the README for the model source, licence and verification
          steps.
        </p>
      </footer>
    </div>
  );
}
