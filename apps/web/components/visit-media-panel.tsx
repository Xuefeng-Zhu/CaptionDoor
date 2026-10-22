"use client";
import type { Bootstrap, Visit, VisitView } from "@captiondoor/domain";
import type { VisitMediaController } from "./use-visit-media";
export function VisitMediaPanel({
  data,
  visit,
  access,
  busy,
  media,
}: {
  data: Bootstrap;
  visit: Visit;
  access: VisitView["access"];
  busy: boolean;
  media: VisitMediaController;
}) {
  const isHandler = visit.handlerId === data.user.id,
    isClosed = visit.status === "CLOSED";
  return (
    <details className="media-panel">
      <summary>
        Optional incoming media{" "}
        <span>
          {visit.mediaSource === "LOCAL_FIXTURE" ? "Simulated " : ""}
          {visit.mediaStatus.toLowerCase()}
        </span>
      </summary>
      <div className="media-panel-body">
        <p>
          Receive-only. Replies never reach the Ring speaker. Audio and video
          can expire while text continues.
        </p>
        <video
          ref={media.videoRef}
          autoPlay
          playsInline
          muted
          controls
          aria-label="Optional incoming door video"
        />
        <label className="check-line">
          <input
            type="checkbox"
            checked={media.includeAudio}
            disabled={!!busy || !!media.hasMedia}
            onChange={(e) => media.setIncludeAudio(e.target.checked)}
          />
          Select incoming remote audio for optional captions
        </label>
        <div className="button-row">
          {data.mode.ring === "demo" ? (
            <p className="small muted">
              Local simulator: no incoming Ring track is present. Use Demo
              transcript above to test captions.
            </p>
          ) : (
            <button
              className="button secondary"
              disabled={
                !!busy ||
                !isHandler ||
                isClosed ||
                !data.settings.consent.ring ||
                !access.camera
              }
              onClick={() => void media.startMedia()}
            >
              Open incoming media
            </button>
          )}
          <button
            className="button secondary"
            disabled={
              !!busy ||
              !isHandler ||
              isClosed ||
              data.mode.transcribe !== "aws" ||
              !data.settings.consent.transcription ||
              !access.captions ||
              !media.mediaReady
            }
            onClick={() => void media.startCapture()}
          >
            Start incoming audio captions
          </button>
          {media.hasMedia ? (
            <button className="text-button" onClick={media.stopMedia}>
              End media
            </button>
          ) : null}
        </div>
        <p className="small" role="status">
          {media.mediaNote ||
            media.captureNote ||
            "No resident microphone is used. No app recording is stored."}
        </p>
        {media.captureNote && media.mediaNote ? (
          <p className="small" role="status">
            {media.captureNote}
          </p>
        ) : null}
      </div>
    </details>
  );
}
