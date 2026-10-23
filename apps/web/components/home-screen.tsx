"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Visit } from "@captiondoor/domain";
import { api, dateLabel, errorText, timeLabel } from "./api";
import { useLive, useResident } from "./hooks";
import {
  AccessGate,
  Arrow,
  DoorMark,
  Empty,
  ErrorNotice,
  Loading,
  Pill,
  Shell,
} from "./ui";
export function HomeScreen() {
  const { data, error, loading, reload } = useResident();
  const [actionError, setActionError] = useState(""),
    [busy, setBusy] = useState(false);
  const router = useRouter();
  const connection = useLive({
    url: data?.wsUrl,
    onChange: () => {
      void reload();
    },
  });
  if (loading)
    return (
      <Shell>
        <Loading />
      </Shell>
    );
  if (!data) return <AccessGate error={error} />;
  const active = data.visits.filter((v) => v.status !== "CLOSED" && !v.deleted),
    recent = data.visits.filter((v) => v.status === "CLOSED").slice(0, 6);
  const door = data.doors[0];
  async function claim(visit: Visit) {
    setBusy(true);
    setActionError("");
    try {
      await api(`/visits/${visit.id}/commands`, {
        body: { type: "claim", expectedVersion: visit.version },
        csrf: data!.csrf,
      });
      router.push(`/visits/${visit.id}`);
    } catch (e) {
      setActionError(errorText(e));
      void reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell data={data} connection={connection}>
      <div className="page-heading compact home-heading">
        <h1>At your door.</h1>
        <p className="heading-aside">
          Read incoming speech. Handle it in person.
        </p>
      </div>
      <ErrorNotice message={actionError || error} />
      <div className="home-grid">
        <section
          className={`current-card ${active.length ? "has-visit" : ""}`}
          aria-labelledby="current-title"
        >
          <div className="section-top">
            <p className="eyebrow">CURRENT VISIT</p>
            <Pill tone={active.length ? "amber" : "neutral"}>
              {active.length ? "Needs attention" : "No open visit"}
            </Pill>
          </div>
          {active.length ? (
            active.map((visit) => (
              <div key={visit.id} className="active-visit">
                <p className="timestamp">
                  {timeLabel(visit.createdAt)} ·{" "}
                  {visit.eventSource === "LOCAL"
                    ? "Local simulated event"
                    : "Doorbell event"}
                </p>
                <h2 id="current-title">
                  {visit.status === "UNCLAIMED"
                    ? "Someone rang the doorbell."
                    : `${visit.handlerName || "A household member"} is handling this.`}
                </h2>
                <p>
                  {visit.status === "UNCLAIMED"
                    ? "Claim this visit, then start incoming captions. Claiming sends no reply."
                    : "Open incoming captions, then handle the visit in person."}
                </p>
                <div className="button-row">
                  {visit.status === "UNCLAIMED" ? (
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() => void claim(visit)}
                    >
                      I’ll handle this. <Arrow />
                    </button>
                  ) : null}
                  <Link
                    className={`button ${visit.status === "UNCLAIMED" ? "secondary" : "primary"}`}
                    href={`/visits/${visit.id}`}
                  >
                    Open visit <Arrow />
                  </Link>
                </div>
              </div>
            ))
          ) : (
            <div className="quiet-state">
              <span className="quiet-lines" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <h2 id="current-title">No open visit.</h2>
              <p>
                {connection === "live"
                  ? "A doorbell ring will appear here."
                  : connection === "offline"
                    ? "You’re offline. Live doorbell alerts are unavailable."
                    : "Connecting for live doorbell alerts…"}
              </p>
              <Link className="text-link" href="/demo">
                Try a local visit <Arrow />
              </Link>
            </div>
          )}
        </section>
        <section className="door-overview" aria-labelledby="door-name">
          <div className="door-illustration" aria-hidden="true">
            <div className="arch-outline" />
            <DoorMark large />
            <span className="door-step" />
          </div>
          <div>
            <p className="eyebrow">YOUR SELECTED DOOR</p>
            <h2 id="door-name">{door?.name || "Choose a door"}</h2>
            <p>{data.household.name}</p>
            <div className="readiness-line">
              <span className="status-check" aria-hidden="true">
                {data.mode.ring === "demo" ? "✓" : "○"}
              </span>
              <span>
                {data.mode.ring === "demo"
                  ? "Local simulation ready"
                  : "Check Ring access in Settings"}
              </span>
            </div>
          </div>
          <Link href="/settings" className="text-link">
            Check readiness <Arrow />
          </Link>
        </section>
      </div>
      <section className="recent-section" aria-labelledby="recent-title">
        <div className="section-heading">
          <div>
            <h2 id="recent-title">Recent visits</h2>
          </div>
          <span className="muted small">
            Content access: {data.settings.retentionHours} hours
          </span>
        </div>
        {recent.length ? (
          <div className="recent-list">
            {recent.map((visit) => (
              <Link
                className="recent-row"
                key={visit.id}
                href={`/visits/${visit.id}`}
              >
                <span className="visit-icon" aria-hidden="true">
                  ↗
                </span>
                <div>
                  <strong>{visit.doorName}</strong>
                  <span>
                    {dateLabel(visit.createdAt)} · {timeLabel(visit.createdAt)}
                  </span>
                </div>
                <Pill>
                  {visit.outcome === "COMPLETED"
                    ? "Completed"
                    : visit.outcome === "DISMISSED"
                      ? "Dismissed"
                      : "No response recorded"}
                </Pill>
                <span className="row-arrow" aria-hidden="true">
                  ↗
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <Empty title="A fresh start.">
            <p>Closed visits appear here within your retention setting.</p>
          </Empty>
        )}
      </section>
      <div className="privacy-note">
        <span aria-hidden="true">◇</span>
        <p>No continuous monitoring. No automatic replies.</p>
        <Link href="/settings">
          Your privacy choices <Arrow />
        </Link>
      </div>
    </Shell>
  );
}
