"use client";
import type { Bootstrap, Visit, VisitView } from "@captiondoor/domain";
import type { VisitMediaController } from "./use-visit-media";
type Props = {
  data: Bootstrap;
  visit: Visit;
  access: VisitView["access"];
  busy: boolean;
  media: VisitMediaController;
};
export function IncomingCaptionControls({
  data,
  visit,
  access,
  busy,
  media,
}: Props) {
  if (
    data.mode.ring === "demo" ||
    visit.status === "CLOSED" ||
    visit.handlerId !== data.user.id
  )
    return null;
  return (
    <div className="incoming-caption-controls">
      <label className="check-line">
        <input
          type="checkbox"
          checked={media.includeAudio}
          disabled={busy || media.hasMedia}
          onChange={(e) => media.setIncludeAudio(e.target.checked)}
        />
        Select incoming remote audio for captions
      </label>
      <div className="button-row">
        <button
          className="button primary"
          disabled={
            busy ||
            media.hasMedia ||
            !data.settings.consent.ring ||
            !access.camera
          }
          onClick={() => void media.startMedia()}
        >
          Open incoming media
        </button>
        <button
          className="button primary"
          disabled={
            busy ||
            data.mode.transcribe !== "aws" ||
            !data.settings.consent.transcription ||
            !access.captions ||
            !media.mediaReady ||
            !media.hasRemoteAudio
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
      <p className="small muted">
        Incoming audio only. Starting captions sends it to AWS Transcribe. No
        resident microphone or app audio/video recording.
      </p>
      {media.mediaReady && media.includeAudio && media.hasRemoteAudio ? (
        <p role="status">Incoming audio available.</p>
      ) : null}
      {media.mediaReady && media.includeAudio && !media.hasRemoteAudio ? (
        <p role="status">
          Incoming media has no available audio track. Handle the visit in
          person or use optional visitor text.
        </p>
      ) : null}
      {media.mediaNote ? (
        <p className="small" role="status">
          {media.mediaNote}
        </p>
      ) : null}
      {media.captureNote ? (
        <p className="small" role="status">
          {media.captureNote}
        </p>
      ) : null}
    </div>
  );
}
export function VisitMediaPanel({ data, visit, media }: Props) {
  return (
    <details className="media-panel">
      <summary>
        Optional incoming video{" "}
        <span>
          {visit.mediaSource === "LOCAL_FIXTURE" ? "Simulated " : ""}
          {visit.mediaStatus.toLowerCase()}
        </span>
      </summary>
      <div className="media-panel-body">
        <p>
          Ring requires an incoming video track for its optional audio stream.
          You can keep this view collapsed. Replies cannot reach the Ring
          speaker.
        </p>
        {data.mode.ring === "demo" ? (
          <p className="small muted">
            Local simulation: no actual Ring audio or video track.
          </p>
        ) : null}
        <video
          ref={media.videoRef}
          autoPlay
          playsInline
          muted
          controls
          aria-label="Optional incoming door video"
        />
      </div>
    </details>
  );
}
