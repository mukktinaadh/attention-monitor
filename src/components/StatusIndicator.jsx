/**
 * StatusIndicator.jsx — the current monitoring state, front and centre (PRD §11, §25).
 *
 * All of the copy and colour for a state comes from `resolveStatePresentation()`, so
 * this component never contains a string like "LOOKING AWAY" or a hex colour. That is
 * what allows the state names, their labels and their tones to be reviewed in one
 * place in `config/constants.js`.
 */
import { resolveStatePresentation } from "../config/constants";

/** Milliseconds as a short, readable duration: 900 → "0.9s", 2400 → "2.4s". */
const formatSeconds = (milliseconds) => `${(milliseconds / 1000).toFixed(1)}s`;

/**
 * A labelled progress bar. `value` and `max` are milliseconds; the bar is purely
 * decorative, so the numbers are exposed as text instead.
 */
function ProgressMeter({ label, detail, value, max }) {
  const safeMax = max > 0 ? max : 1;
  const percent = Math.min(100, Math.max(0, (value / safeMax) * 100));

  return (
    <div className="meter">
      <div className="meter__labels">
        <span>{label}</span>
        <span className="meter__detail">{detail}</span>
      </div>
      <div className="meter__track">
        <div className="meter__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export default function StatusIndicator({ snapshot }) {
  const presentation = resolveStatePresentation(snapshot);
  const { pose, metrics } = snapshot;

  const showCalibration = snapshot.calibrating;
  const showCountdown =
    snapshot.isLookingAway && !snapshot.calibrating && !snapshot.isWarning;

  return (
    <section
      className="card status"
      data-tone={presentation.tone}
      aria-labelledby="status-title"
    >
      <header className="card__header">
        <h2 className="card__title" id="status-title">
          Status
        </h2>
        <span className="pill pill--faces">
          {snapshot.facesDetected === 0
            ? "No faces"
            : `${snapshot.facesDetected} face${snapshot.facesDetected === 1 ? "" : "s"}`}
        </span>
      </header>

      <div className="status__headline" aria-live="polite">
        <span className="status__glyph" aria-hidden="true">
          {presentation.glyph}
        </span>
        <p className="status__label">{presentation.short}</p>
      </div>

      <p className="status__description">{presentation.description}</p>

      {showCalibration && (
        <ProgressMeter
          label="Learning neutral pose"
          detail={`${Math.round(snapshot.calibrationProgress * 100)}%`}
          value={snapshot.calibrationProgress}
          max={1}
        />
      )}

      {showCountdown && (
        <ProgressMeter
          label="Warning in"
          detail={`${formatSeconds(
            Math.max(0, snapshot.lookAwayThresholdMs - snapshot.awayElapsedMs),
          )} · threshold ${formatSeconds(snapshot.lookAwayThresholdMs)}`}
          value={snapshot.awayElapsedMs}
          max={snapshot.lookAwayThresholdMs}
        />
      )}

      {snapshot.isWarning && (
        <ProgressMeter
          label="Looking away for"
          detail={`${formatSeconds(snapshot.awayElapsedMs)} · ${metrics.warnings} warning${
            metrics.warnings === 1 ? "" : "s"
          } this session`}
          value={Math.min(snapshot.awayElapsedMs, snapshot.lookAwayThresholdMs)}
          max={snapshot.lookAwayThresholdMs}
        />
      )}

      {/* Why the estimator reached its verdict — the part that makes the
          approximation inspectable instead of a black box (PRD §8). */}
      {pose.avertedReasons.length > 0 && (
        <ul className="status__reasons">
          {pose.avertedReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      <dl className="status__telemetry">
        <div className="status__telemetry-item">
          <dt>Head yaw</dt>
          <dd>{pose.yawDeg.toFixed(0)}°</dd>
        </div>
        <div className="status__telemetry-item">
          <dt>Head pitch</dt>
          <dd>{pose.pitchDeg.toFixed(0)}°</dd>
        </div>
        <div className="status__telemetry-item">
          <dt>Eye position</dt>
          <dd>{pose.irisAvailable ? "tracked" : "n/a"}</dd>
        </div>
        <div className="status__telemetry-item">
          <dt>Direction</dt>
          <dd>{pose.direction ?? "—"}</dd>
        </div>
      </dl>
    </section>
  );
}
