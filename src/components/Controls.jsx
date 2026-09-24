/**
 * Controls.jsx — session and configuration controls (PRD §14, §25).
 *
 * Every control is controlled: the value lives in the hook and comes back down as a
 * prop. The component therefore contains no state of its own and cannot drift out of
 * sync with the engine's actual configuration.
 */
import { LOOK_AWAY_THRESHOLD_CHOICES, SENSITIVITY_PRESETS } from "../config/constants";

export default function Controls({
  isRunning,
  isStarting,
  onStart,
  onStop,
  onRecalibrate,
  onResetSession,
  voiceEnabled,
  speechSupported,
  onVoiceChange,
  sensitivity,
  onSensitivityChange,
  lookAwayThresholdMs,
  onLookAwayThresholdChange,
}) {
  // While starting, the button reports progress rather than being re-enabled.
  const startLabel = isStarting ? "Starting…" : "Start camera";

  return (
    <section className="card controls" aria-labelledby="controls-title">
      <header className="card__header">
        <h2 className="card__title" id="controls-title">
          Controls
        </h2>
      </header>

      <div className="controls__buttons">
        <button
          type="button"
          className="button button--primary"
          onClick={onStart}
          disabled={isRunning || isStarting}
        >
          {startLabel}
        </button>
        <button
          type="button"
          className="button"
          onClick={onStop}
          disabled={!isRunning}
        >
          Stop camera
        </button>
        <button
          type="button"
          className="button"
          onClick={onRecalibrate}
          // Meaningless without a live feed to measure a neutral pose from.
          disabled={!isRunning}
        >
          Set neutral pose
        </button>
        <button type="button" className="button button--ghost" onClick={onResetSession}>
          Reset session
        </button>
      </div>

      {/*
        A real button with role="switch": it is keyboard operable for free, and
        assistive technology announces it as a toggle rather than as a button whose
        label happens to change.
      */}
      <div className="controls__row">
        <span className="controls__row-label" id="voice-label">
          Voice alerts
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={voiceEnabled}
          aria-labelledby="voice-label"
          className="switch"
          data-on={voiceEnabled}
          disabled={!speechSupported}
          onClick={() => onVoiceChange(!voiceEnabled)}
        >
          <span className="switch__thumb" aria-hidden="true" />
          <span className="switch__text">
            {speechSupported ? (voiceEnabled ? "ON" : "OFF") : "Unavailable"}
          </span>
        </button>
      </div>

      {!speechSupported && (
        <p className="controls__note">
          This browser reports no SpeechSynthesis support, so the visual warning works
          but the spoken alert cannot play. Chrome, Edge, Firefox and Safari all support
          it.
        </p>
      )}

      <div className="controls__row">
        <label className="controls__row-label" htmlFor="sensitivity">
          Sensitivity
        </label>
        <select
          id="sensitivity"
          className="select"
          value={sensitivity}
          onChange={(event) => onSensitivityChange(event.target.value)}
        >
          {Object.entries(SENSITIVITY_PRESETS).map(([key, preset]) => (
            <option key={key} value={key}>
              {preset.label}
            </option>
          ))}
        </select>
      </div>

      <div className="controls__row">
        <label className="controls__row-label" htmlFor="look-away-threshold">
          Look-away threshold
        </label>
        <select
          id="look-away-threshold"
          className="select"
          value={lookAwayThresholdMs}
          onChange={(event) => onLookAwayThresholdChange(Number(event.target.value))}
        >
          {LOOK_AWAY_THRESHOLD_CHOICES.map((milliseconds) => (
            <option key={milliseconds} value={milliseconds}>
              {milliseconds / 1000} seconds
            </option>
          ))}
        </select>
      </div>

      <p className="controls__note">
        Sensitivity moves the thresholds that decide “looking at the camera”. Relaxed
        tolerates more head movement; Strict fires sooner. The live yaw/pitch readout in
        the status card is the fastest way to see which setting suits your camera.
      </p>
    </section>
  );
}
