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
      <div className="page-heading">
        <div>
          <p className="eyebrow">A LITTLE PEACE OF MIND</p>
          <h1>
            Your door,
            <br />
            <em>in the loop.</em>
          </h1>
        </div>
        <p className="heading-aside">
          A clear view of what needs you.
          <br />
          You decide what happens next.
        </p>
      </div>
      <ErrorNotice message={actionError || error} />
      <div className="home-grid">
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
                ✓
              </span>
              <span>
                {data.mode.ring === "demo"
                  ? "Local simulation ready"
                  : "Integration configured separately"}
              </span>
            </div>
          </div>
          <Link href="/settings" className="text-link">
            Check readiness <Arrow />
          </Link>
        </section>
        <section
          className={`current-card ${active.length ? "has-visit" : ""}`}
          aria-labelledby="current-title"
        >
          <div className="section-top">
            <p className="eyebrow">AT YOUR DOOR</p>
            <Pill tone={active.length ? "amber" : "green"}>
              {active.length ? "Needs attention" : "All quiet"}
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
                    ? "Take responsibility when you’re ready. Claiming a visit sends no reply."
                    : "The visit stays open until a household member explicitly closes it."}
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
              <h2 id="current-title">
                Nothing needs you
                <br />
                <em>right now.</em>
              </h2>
              <p>
                Doorbell alerts and visitor messages will appear here while
                you’re connected.
              </p>
              <Link className="text-link" href="/demo">
                Try a local visit <Arrow />
              </Link>
            </div>
          )}
        </section>
      </div>
      <section className="recent-section" aria-labelledby="recent-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">THE SHORT HISTORY</p>
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
            <p>
              Your recent visits will live here, within your retention setting.
            </p>
          </Empty>
        )}
      </section>
      <div className="privacy-note">
        <span aria-hidden="true">◇</span>
        <p>
          No continuous monitoring. No automatic replies. Every conversation
          stays in your household.
        </p>
        <Link href="/settings">
          Your privacy choices <Arrow />
        </Link>
      </div>
    </Shell>
  );
}
