/**
 * MetricsPanel.jsx — session statistics (PRD §18, §25).
 *
 * These numbers are accumulated by the engine as it processes frames and live only in
 * React state. Nothing here is persisted, and there is no analytics call anywhere in
 * the app: close the tab and the session is gone for good, which is the point.
 */

/** Milliseconds → "12s" or "3m 05s". */
function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/** Percentage of the session spent on one activity, with a divide-by-zero guard. */
function share(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** One headline figure. */
function Stat({ label, value, hint }) {
  return (
    <div className="stat">
      <dt className="stat__label">{label}</dt>
      <dd className="stat__value">
        {value}
        {hint && <span className="stat__hint">{hint}</span>}
      </dd>
    </div>
  );
}

export default function MetricsPanel({ snapshot }) {
  const { metrics } = snapshot;

  // Time that is neither attending nor distracted: no face in frame, or several.
  const unattributedMs = metrics.noFaceMs + metrics.multipleFaceMs;
  const { sessionDurationMs } = metrics;

  return (
    <section className="card metrics" aria-labelledby="metrics-title">
      <header className="card__header">
        <h2 className="card__title" id="metrics-title">
          Session metrics
        </h2>
        <span className="pill">local only</span>
      </header>

      <dl className="metrics__grid">
        <Stat label="Session time" value={formatDuration(sessionDurationMs)} />
        <Stat
          label="Attention time"
          value={formatDuration(metrics.lookingAtCameraMs)}
          hint={`${share(metrics.lookingAtCameraMs, sessionDurationMs)}%`}
        />
        <Stat
          label="Looking away"
          value={formatDuration(metrics.lookingAwayMs)}
          hint={`${share(metrics.lookingAwayMs, sessionDurationMs)}%`}
        />
        <Stat label="Warnings" value={metrics.warnings} />
        <Stat label="No-face events" value={metrics.noFaceEvents} />
        <Stat label="Multiple-face events" value={metrics.multipleFaceEvents} />
      </dl>

      {/*
        A single stacked bar makes the shape of the session obvious at a glance, which
        a list of six durations does not. Widths are percentages of session time; the
        four buckets always sum to the session, so the bar is never misleading.
      */}
      <div className="metrics__composition" aria-hidden="true">
        <div
          className="metrics__slice metrics__slice--attention"
          style={{ width: `${share(metrics.lookingAtCameraMs, sessionDurationMs)}%` }}
        />
        <div
          className="metrics__slice metrics__slice--away"
          style={{ width: `${share(metrics.lookingAwayMs, sessionDurationMs)}%` }}
        />
        <div
          className="metrics__slice metrics__slice--absent"
          style={{ width: `${share(unattributedMs, sessionDurationMs)}%` }}
        />
      </div>
      <p className="metrics__legend">
        Attention · Looking away · Absent from frame
      </p>
    </section>
  );
}
