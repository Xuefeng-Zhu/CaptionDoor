"use client";
import { useEffect, useRef, useState } from "react";
import type { ConversationItem, Visit } from "@captiondoor/domain";
export type CaptionPanelProps = {
  visit: Visit;
  captions: ConversationItem[];
  initialSize: number;
  allowFixture: boolean;
  busy: boolean;
  demoCaptions: () => Promise<void>;
};
export function CaptionPanel({
  visit,
  captions,
  initialSize,
  allowFixture,
  busy,
  demoCaptions,
}: CaptionPanelProps) {
  const [captionSize, setCaptionSize] = useState(initialSize),
    [away, setAway] = useState(false);
  const captionPanel = useRef<HTMLDivElement>(null),
    followLive = useRef(true);
  useEffect(() => setCaptionSize(initialSize), [initialSize]);
  const captionKey = captions
    .map((i) => `${i.id}:${i.text}:${i.isPartial}`)
    .join("|");
  useEffect(() => {
    if (followLive.current && captionPanel.current)
      captionPanel.current.scrollTop = captionPanel.current.scrollHeight;
  }, [captionKey]);
  return (
    <section className="caption-card" aria-labelledby="captions-title">
      <div className="section-top">
        <div>
          <p className="eyebrow">INCOMING WORDS</p>
          <h2 id="captions-title">Captions</h2>
        </div>
        <label className="caption-size-control">
          <span className="sr-only">Caption text size</span>
          <span aria-hidden="true">Aa</span>
          <select
            aria-label="Caption text size"
            value={captionSize}
            onChange={(e) => setCaptionSize(Number(e.target.value))}
          >
            <option value={28}>28px</option>
            <option value={32}>32px</option>
            <option value={36}>36px</option>
          </select>
        </label>
      </div>
      {visit.transcriptSource === "FIXTURE" ? (
        <div className="fixture-label">
          <span aria-hidden="true">◇</span> Demo transcript · synthetic fixture
        </div>
      ) : null}
      <div
        className="caption-scroll"
        ref={captionPanel}
        tabIndex={0}
        aria-label="Incoming captions, scrollable"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          followLive.current = atBottom;
          setAway(!atBottom);
        }}
      >
        {captions.length ? (
          captions.map((c) => (
            <div
              className={`caption-line ${c.isPartial ? "partial" : ""}`}
              key={`${c.mediaSessionId}:${c.resultId}`}
            >
              <p style={{ fontSize: captionSize }}>{c.text}</p>
              <span className="caption-meta">
                {c.isPartial ? "Updating…" : "Finalized"}
                {c.source === "FIXTURE" ? " · Demo transcript" : ""}
              </span>
            </div>
          ))
        ) : (
          <div className="caption-empty">
            <span className="caption-lines" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <h3>
              {visit.mediaStatus === "UNAVAILABLE"
                ? "Incoming audio unavailable."
                : "Words will appear here."}
            </h3>
            <p>
              {visit.mediaStatus === "INTERRUPTED"
                ? "The media connection was interrupted."
                : "Captions require available incoming audio and your explicit action."}{" "}
              Text messages work separately.
            </p>
          </div>
        )}
      </div>
      {away ? (
        <button
          className="return-live"
          onClick={() => {
            followLive.current = true;
            setAway(false);
            if (captionPanel.current)
              captionPanel.current.scrollTop =
                captionPanel.current.scrollHeight;
          }}
        >
          ↓ Return to live
        </button>
      ) : null}
      <div className="caption-footer">
        <span>Finalized means complete, not verified.</span>
        <span>No fabricated speakers or sounds.</span>
      </div>
      {allowFixture ? (
        <div className="fixture-action">
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() => void demoCaptions()}
          >
            Start Demo transcript
          </button>
          <p className="small muted">
            Synthetic words for this local scenario. Requires your media and
            transcription consent in Settings.
          </p>
        </div>
      ) : null}
    </section>
  );
}
