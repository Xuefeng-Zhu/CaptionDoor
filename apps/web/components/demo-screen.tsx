"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Visit } from "@captiondoor/domain";
import { api, errorText } from "./api";
import { useResident, useLive } from "./hooks";
import { AccessGate, Arrow, ErrorNotice, Loading, Pill, Shell } from "./ui";
const scenarios = [
  {
    id: "doorbell",
    number: "01",
    title: "A visitor rings.",
    description:
      "Create a signed local button-press event. Claim the visit, associate a private visitor thread, and send a reply.",
  },
  {
    id: "missing-audio",
    number: "02",
    title: "No audio? Keep the words.",
    description:
      "A visit with unavailable media. Visitor text and explicit replies still work.",
  },
  {
    id: "duplicate-webhook",
    number: "03",
    title: "One ring. One visit.",
    description:
      "Deliver the same semantic doorbell event twice. The persisted deduplication keeps one active visit.",
  },
];
export function DemoScreen() {
  const { data, error, loading, reload } = useResident();
  const [busy, setBusy] = useState(""),
    [actionError, setActionError] = useState("");
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
  async function launch(scenario: string) {
    setBusy(scenario);
    setActionError("");
    try {
      const result = await api<{ visit: Visit }>("/demo/press", {
        body: { scenario },
        csrf: data!.csrf,
      });
      router.push(`/visits/${result.visit.id}`);
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <Shell data={data} connection={connection}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">A SAFE PLACE TO PRACTICE</p>
          <h1>
            Try your door.
            <br />
            <em>Find your rhythm.</em>
          </h1>
        </div>
        <Pill tone="amber">LOCAL SIMULATION</Pill>
      </div>
      <div className="notice demo-disclosure">
        <strong>Real local APIs. Clearly simulated events.</strong>
        <p>
          This demo uses DynamoDB Local, authenticated sockets, and the same
          responsibility rules. Doorbell events, media states, and demo
          transcripts are local fixtures. This is not the official Ring
          Playground or device evidence.
        </p>
      </div>
      <ErrorNotice message={actionError || error} />
      <div className="scenario-grid">
        {scenarios.map((s) => (
          <section className="scenario-card" key={s.id}>
            <span className="scenario-number" aria-hidden="true">
              {s.number}
            </span>
            <h2>{s.title}</h2>
            <p>{s.description}</p>
            <button
              disabled={!!busy || data.mode.ring !== "demo"}
              className="button primary"
              onClick={() => void launch(s.id)}
            >
              {busy === s.id ? "Creating visit…" : "Start scenario"} <Arrow />
            </button>
          </section>
        ))}
      </div>
      <section className="practice-panel">
        <div>
          <p className="eyebrow">THE COMPLETE JOURNEY</p>
          <h2>
            Two residents.
            <br />
            One visitor page.
          </h2>
          <p>
            Open separate browser profiles for Alex and Sam. Open the visitor
            page in a third private browser. Each visitor browser gets an
            isolated thread.
          </p>
        </div>
        <ol className="journey-list">
          <li>Ring the local doorbell and claim “I’ll handle this.”</li>
          <li>Open the visitor page and send a request.</li>
          <li>Explicitly associate that thread with the visit.</li>
          <li>Edit a reply and choose “Send to visitor page.”</li>
          <li>On the visitor page, choose “Got it.” Then close the visit.</li>
        </ol>
        <div className="button-row">
          <a
            className="button secondary"
            target="_blank"
            rel="noreferrer"
            href={`/door/${data.doors[0]?.publicDoorId || "front-demo"}`}
          >
            Open visitor page <Arrow />
          </a>
          <Link className="text-link" href="/onboarding">
            Switch demo resident <Arrow />
          </Link>
        </div>
      </section>
      <div className="privacy-note">
        <span aria-hidden="true">◇</span>
        <p>
          A QR code is an entrance to text, not proof of identity or presence.
          Timing never associates a visitor automatically.
        </p>
      </div>
    </Shell>
  );
}
