/**
 * CameraView.jsx — the webcam stage and its landmark overlay.
 *
 * This component owns no logic. The hook hands it two refs and the camera state; the
 * hook drives the animation loop that reads from the video and paints the canvas.
 * Keeping it dumb means it can be rendered, screenshotted and reasoned about without
 * a camera attached.
 *
 * LAYOUT NOTE — why the stage is a separate flipped element
 * ```
 * .camera-view__frame            position: relative, NOT flipped
 *   ├── .camera-view__stage      scaleX(-1)  ← video + canvas, flipped together
 *   │     ├── <video>            the raw camera feed
 *   │     └── <canvas>           landmarks, drawn in the video's own coordinates
 *   └── .camera-view__placeholder NOT flipped, so its text reads normally
 * ```
 * The canvas is drawn in exactly the same coordinate space as the video and the flip
 * is applied once, by CSS, to the element containing both. Any alternative (flipping
 * one layer only, or negating x while drawing) is how overlay misalignment bugs are
 * born.
 *
 * Both the video and the canvas are stretched to the same box, so they cannot drift
 * apart: the video's default `object-fit: fill` and the canvas's natural stretch
 * apply the identical transform.
 */
export default function CameraView({ videoRef, canvasRef, isRunning, isStarting }) {
  const showPlaceholder = !isRunning;

  return (
    <section className="card camera-view" aria-labelledby="camera-view-title">
      <header className="card__header">
        <h2 className="card__title" id="camera-view-title">
          Camera preview
        </h2>
        <span className="pill" data-live={isRunning}>
          <span className="pill__dot" aria-hidden="true" />
          {isRunning ? "Local inference" : "Idle"}
        </span>
      </header>

      <div className="camera-view__frame">
        <div className="camera-view__stage" data-live={isRunning}>
          {/*
            autoPlay + muted + playsInline: required for the stream to start without a
            user gesture on mobile Safari. We never request audio, so muted is honest.
          */}
          <video
            ref={videoRef}
            className="camera-view__video"
            autoPlay
            playsInline
            muted
            aria-label="Live camera preview"
          />
          {/* Decorative: the same information is available as text in the status card. */}
          <canvas ref={canvasRef} className="camera-view__overlay" aria-hidden="true" />
        </div>

        {showPlaceholder && (
          <div className="camera-view__placeholder">
            <span className="camera-view__placeholder-glyph" aria-hidden="true">
              ◍
            </span>
            <p className="camera-view__placeholder-title">
              {isStarting ? "Starting camera…" : "Camera is off"}
            </p>
            <p className="camera-view__placeholder-hint">
              {isStarting
                ? "Waiting for camera permission and booting the local face model."
                : "Press “Start camera” to begin. The video is analysed inside this tab — it is never recorded or uploaded."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
