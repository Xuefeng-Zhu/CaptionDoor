"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Visit, VisitView } from "@captiondoor/domain";
import type { CommandInput } from "./visit-types";
import { api, errorText, HttpError, timeLabel } from "./api";
import {
  appendAuthorizedCaption,
  expireVisitView,
  reconcileVisitView,
} from "./visit-privacy";
import { useLive, useResident } from "./hooks";
import { AccessGate, ErrorNotice, Loading, Pill, Shell } from "./ui";
import { CaptionPanel } from "./caption-panel";
import { ConversationPanel, SessionEvents } from "./conversation-panel";
import { ResponsibilityPanel } from "./responsibility-panel";
import { VisitActionPanels } from "./visit-action-panels";
import { IncomingCaptionControls, VisitMediaPanel } from "./visit-media-panel";
import { useVisitMedia } from "./use-visit-media";
export function VisitScreen({ id }: { id: string }) {
  const resident = useResident(),
    { data } = resident,
    router = useRouter();
  const [view, setView] = useState<VisitView | null>(null),
    [error, setError] = useState(""),
    [actionError, setActionError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState("");
  const loadRequest = useRef(0);
  const load = useCallback(
    async (cursor?: string) => {
      const request = ++loadRequest.current;
      try {
        const d = await api<VisitView>(
          `/visits/${id}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        if (request !== loadRequest.current) return;
        if (d.visit.expiresAt <= Math.floor(Date.now() / 1000))
          throw new HttpError(
            "This visit has expired. Retained content is no longer available.",
            403,
            "EXPIRED",
          );
        setView((previous) => reconcileVisitView(previous, d, !!cursor));
        setError("");
      } catch (e) {
        if (request !== loadRequest.current) return;
        if (e instanceof HttpError && [401, 403, 404].includes(e.status))
          setView(null);
        setError(errorText(e));
      }
    },
    [id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const connection = useLive({
    url: data?.wsUrl,
    visitId: id,
    onChange: () => {
      void load();
      void resident.reload();
    },
    onCaption: (caption) =>
      setView((previous) => appendAuthorizedCaption(previous, caption)),
  });

  useEffect(() => {
    if (!view) return;
    const expiry = Math.min(
      view.visit.expiresAt,
      ...view.items.map((item) => item.expiresAt),
      ...view.threads.map((thread) => thread.expiresAt),
    );
    const timer = setTimeout(
      () => {
        const now = Math.floor(Date.now() / 1000);
        if (view.visit.expiresAt <= now)
          setError(
            "This visit has expired. Retained content is no longer available.",
          );
        setView((previous) => expireVisitView(previous, now));
      },
      Math.min(2147483647, Math.max(0, expiry * 1000 - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [view]);

  const media = useVisitMedia({
    id,
    visit: view?.visit,
    currentUserId: data?.user.id,
    cameraAllowed: view?.access.camera === true,
    captionsAllowed: view?.access.captions === true,
    csrf: data?.csrf,
    wsUrl: data?.wsUrl,
    perform,
    load,
    setBusy,
  });
  if (resident.loading)
    return (
      <Shell>
        <Loading label="Opening this visit…" />
      </Shell>
    );
  if (!data) return <AccessGate error={resident.error} />;
  if (!view)
    return (
      <Shell data={data} connection={connection}>
        {error ? (
          <ErrorNotice message={error} />
        ) : (
          <Loading label="Opening this visit…" />
        )}
        <Link className="text-link" href="/home">
          Return to your door
        </Link>
      </Shell>
    );
  const visit = view.visit,
    isHandler = visit.handlerId === data.user.id,
    isClosed = visit.status === "CLOSED";
  const associated = view.access.visitorText
    ? [...view.threads, ...data.threads.filter((t) => t.visitId === id)].filter(
        (t, i, a) =>
          a.findIndex((x) => x.id === t.id) === i && t.visitId === id,
      )
    : [];
  const candidates = view.access.visitorText
    ? data.threads.filter((t) => t.doorId === visit.doorId && !t.visitId)
    : [];
  const messages = view.items.filter((i) => i.kind === "message"),
    events = view.items.filter((i) => i.kind === "event");
  async function perform(command: CommandInput) {
    setBusy(command.type);
    setActionError("");
    setNotice("");
    try {
      const result = await api<{ visit: Visit }>(`/visits/${id}/commands`, {
        body: { ...command, expectedVersion: view!.visit.version },
        csrf: data!.csrf,
      });
      if (result.visit) setView((v) => (v ? { ...v, visit: result.visit } : v));
      await Promise.all([load(), resident.reload()]);
      return result;
    } catch (e) {
      setActionError(errorText(e));
      await load();
      return null;
    } finally {
      setBusy("");
    }
  }
  async function demoCaptions() {
    setBusy("fixture");
    setActionError("");
    try {
      await api("/demo/captions", {
        body: { visitId: id, consent: true },
        csrf: data!.csrf,
      });
      setNotice("");
      await load();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <Shell data={data} connection={connection}>
      <Link href="/home" className="back-link">
        ← Your door
      </Link>
      <div className="visit-heading">
        <div>
          <p className="eyebrow">
            {visit.doorName.toUpperCase()} · {timeLabel(visit.createdAt)}
          </p>
          <h1>
            {isClosed
              ? "This visit is closed."
              : visit.status === "UNCLAIMED"
                ? "A ring at your door."
                : isHandler
                  ? "You’re handling this."
                  : `${visit.handlerName || "A member"} is handling this.`}
          </h1>
        </div>
        <Pill
          tone={
            isClosed
              ? "neutral"
              : visit.status === "UNCLAIMED"
                ? "amber"
                : "green"
          }
        >
          {isClosed
            ? "Closed"
            : visit.status === "UNCLAIMED"
              ? "Unclaimed"
              : "Claimed"}
        </Pill>
      </div>
      <div className="visit-provenance">
        <span>
          Event:{" "}
          {visit.eventSource === "LOCAL"
            ? "Local simulation"
            : visit.eventSource === "PLAYGROUND"
              ? "Ring Playground"
              : "Ring live"}
        </span>
        <span>
          Media:{" "}
          {visit.mediaSource === "NONE"
            ? "Not open"
            : visit.mediaSource === "LOCAL_FIXTURE"
              ? "Local fixture"
              : "Ring"}
        </span>
        <span>
          Captions:{" "}
          {visit.transcriptSource === "FIXTURE"
            ? "Demo transcript"
            : visit.transcriptSource === "AWS"
              ? "AWS Transcribe"
              : "Not started"}
        </span>
      </div>
      <ErrorNotice message={actionError || error} />
      {notice ? (
        <div className="notice success" role="status">
          {notice}
        </div>
      ) : null}
      {isClosed ? (
        <div className="notice">
          <strong>
            {visit.outcome === "COMPLETED"
              ? "Completed"
              : visit.outcome === "DISMISSED"
                ? "Dismissed"
                : "No response recorded"}
          </strong>
          <span>
            This closes the session. It does not establish anyone’s identity or
            departure.
          </span>
        </div>
      ) : null}

      <ResponsibilityPanel
        visit={visit}
        currentUserId={data.user.id}
        busy={!!busy}
        perform={perform}
        mobile
      />
      <div className="visit-layout">
        <div className="visit-primary">
          <CaptionPanel
            visit={visit}
            captions={view.items.filter((i) => i.kind === "caption")}
            hasCaptionAccess={view.access.captions}
            initialSize={data.settings.captionSize}
            allowFixture={
              data.mode.ring === "demo" &&
              data.mode.transcribe === "fixture" &&
              isHandler &&
              !isClosed
            }
            busy={!!busy}
            demoCaptions={demoCaptions}
            isHandler={isHandler}
            controls={
              <IncomingCaptionControls
                data={data}
                visit={visit}
                access={view.access}
                busy={!!busy}
                media={media}
              />
            }
          />
          {view.nextCursor ? (
            <button
              className="button secondary history-button"
              disabled={!!busy}
              onClick={() => void load(view.nextCursor)}
            >
              Load earlier visit history
            </button>
          ) : null}
          <VisitMediaPanel
            data={data}
            visit={visit}
            access={view.access}
            busy={!!busy}
            media={media}
          />
          <SessionEvents events={events} />
        </div>
        <VisitActionPanels
          data={data}
          visit={visit}
          associated={associated}
          candidates={candidates}
          busy={!!busy}
          perform={perform}
          onReplyAccepted={() =>
            setNotice(
              "Reply accepted. Delivery and acknowledgement status appears with the message below.",
            )
          }
          onDeleted={() => router.push("/home")}
          conversation={
            <ConversationPanel
              messages={messages}
              hasVisitorTextAccess={view.access.visitorText}
              associatedCount={associated.length}
              busy={!!busy}
              loadEarlier={load}
            />
          }
        />
      </div>
    </Shell>
  );
}
