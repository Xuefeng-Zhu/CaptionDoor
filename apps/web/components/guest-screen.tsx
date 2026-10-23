"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationItem, GuestView } from "@captiondoor/domain";
import { api, errorText, HttpError, timeLabel, mergeItems } from "./api";
import { useLive } from "./hooks";
import { Arrow, DoorMark, Empty, ErrorNotice, Loading, Pill } from "./ui";
function GuestReply({
  message,
  csrf,
  onChange,
  onError,
}: {
  message: ConversationItem;
  csrf: string;
  onChange: () => void;
  onError: (error: string) => void;
}) {
  const ref = useRef<HTMLElement>(null),
    attempted = useRef(false),
    visible = useRef(false);
  const [busy, setBusy] = useState(false),
    [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    if (message.deliveryStatus !== "ACCEPTED") return;
    async function display() {
      if (
        !visible.current ||
        document.visibilityState !== "visible" ||
        attempted.current
      )
        return;
      attempted.current = true;
      try {
        await api(`/guest/messages/${message.id}/display`, { body: {}, csrf });
        onChange();
      } catch {
        attempted.current = false;
      }
    }
    const observer = new IntersectionObserver(
      (entries) => {
        visible.current = entries.some(
          (e) => e.isIntersecting && e.intersectionRatio >= 0.5,
        );
        void display();
      },
      { threshold: [0, 0.5, 1] },
    );
    if (ref.current) observer.observe(ref.current);
    document.addEventListener("visibilitychange", display);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", display);
    };
  }, [message.id, message.deliveryStatus, csrf, onChange]);
  async function confirm() {
    setBusy(true);
    try {
      if (message.deliveryStatus === "ACCEPTED")
        await api(`/guest/messages/${message.id}/display`, { body: {}, csrf });
      await api(`/guest/messages/${message.id}/confirm`, { body: {}, csrf });
      setConfirmed(true);
      onChange();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article ref={ref} className="guest-reply">
      <header>
        <strong>Reply</strong>
        <time>{timeLabel(message.createdAt)}</time>
      </header>
      <p>{message.text}</p>
      {message.deliveryStatus === "CONFIRMED" || confirmed ? (
        <span className="confirmed-label">✓ You confirmed this reply</span>
      ) : (
        <button
          className="button primary"
          disabled={busy}
          onClick={() => void confirm()}
        >
          Got it <span aria-hidden="true">✓</span>
        </button>
      )}
    </article>
  );
}
export function GuestScreen({ publicDoorId }: { publicDoorId: string }) {
  const [view, setView] = useState<GuestView | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [category, setCategory] = useState<"Delivery" | "Appointment" | "Other">(
      "Delivery",
    ),
    [sending, setSending] = useState(false),
    [notice, setNotice] = useState(""),
    [olderCursor, setOlderCursor] = useState<string | undefined>();
  const expanded = useRef(false);
  const loadRequest = useRef(0);
  const pendingSend = useRef<{ payload: string; key: string } | null>(null);
  const initial = useRef<Promise<GuestView> | null>(null);
  const load = useCallback(
    async (cursor?: string) => {
      const request = ++loadRequest.current;
      try {
        const d = await api<GuestView>(
          `/guest?publicDoorId=${encodeURIComponent(publicDoorId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        if (request !== loadRequest.current) return;
        if (cursor) expanded.current = true;
        if (cursor || !expanded.current) setOlderCursor(d.nextCursor);
        setView((previous) => ({
          ...d,
          messages: mergeItems(
            (previous?.messages || []).filter(
              (m) => m.expiresAt > Math.floor(Date.now() / 1000),
            ),
            d.messages,
          ),
        }));
        setError("");
      } catch (e) {
        if (request !== loadRequest.current) return;
        if (e instanceof HttpError && [401, 403].includes(e.status)) {
          setView(null);
          setOlderCursor(undefined);
          setNotice("");
        }
        setError(errorText(e));
      }
    },
    [publicDoorId],
  );
  useEffect(() => {
    let active = true;
    if (!initial.current)
      initial.current = api<GuestView>(
        `/guest?publicDoorId=${encodeURIComponent(publicDoorId)}`,
      ).catch((e) => {
        if (e instanceof HttpError && [401, 403, 404].includes(e.status))
          return api<GuestView>("/guest/sessions", { body: { publicDoorId } });
        throw e;
      });
    initial.current
      .then((d) => {
        if (active) {
          setView(d);
          setOlderCursor(d.nextCursor);
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [publicDoorId]);
  const connection = useLive({
    url: view?.wsUrl,
    guest: true,
    onChange: () => {
      void load();
    },
  });
  const refresh = useCallback(() => {
    void load();
  }, [load]);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!view || !message.trim()) return;
    setSending(true);
    setError("");
    setNotice("");
    try {
      const input = { text: message.trim(), category };
      const payload = JSON.stringify(input);
      if (pendingSend.current?.payload !== payload)
        pendingSend.current = { payload, key: crypto.randomUUID() };
      await api("/guest/messages", {
        body: input,
        csrf: view.csrf,
        key: pendingSend.current.key,
      });
      pendingSend.current = null;
      setMessage("");
      setNotice("Your message was accepted. Keep this page open for replies.");
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="guest-frame">
      <header className="guest-header">
        <div className="brand">
          <DoorMark />
          <span>
            CaptionDoor<span className="brand-dot">.</span>
          </span>
        </div>
        <Pill>Private visitor page</Pill>
      </header>
      <main id="main" className="guest-main">
        <div className="guest-intro">
          <p className="eyebrow">LET’S COMMUNICATE BY TEXT</p>
          <h1>
            A few words.
            <br />
            <em>A clearer connection.</em>
          </h1>
          <p>Message this household. No account or app needed.</p>
        </div>
        <div
          className={`guest-connection ${connection === "offline" ? "offline" : ""}`}
          role="status"
        >
          <span className="connection-dot" aria-hidden="true" />
          <div>
            <strong>
              {connection === "live"
                ? "Keep this page open."
                : connection === "offline"
                  ? "You’re offline."
                  : "Checking your connection…"}
            </strong>
            <p>
              {connection === "offline"
                ? "No live messages or replies are available. Reconnect to continue."
                : "Replies appear here. Your message does not confirm that someone is available."}
            </p>
          </div>
        </div>
        <ErrorNotice message={error} />
        {notice ? (
          <div className="notice success" role="status">
            {notice}
          </div>
        ) : null}
        {view ? (
          <>
            <form className="guest-compose" onSubmit={(e) => void send(e)}>
              <fieldset>
                <legend>What brings you here?</legend>
                <div className="category-options">
                  {(["Delivery", "Appointment", "Other"] as const).map(
                    (value) => (
                      <label
                        key={value}
                        className={category === value ? "selected" : ""}
                      >
                        <input
                          type="radio"
                          name="category"
                          value={value}
                          checked={category === value}
                          onChange={() => setCategory(value)}
                        />
                        <span>
                          {value === "Delivery"
                            ? "□"
                            : value === "Appointment"
                              ? "◷"
                              : "⌁"}
                        </span>
                        {value}
                      </label>
                    ),
                  )}
                </div>
              </fieldset>
              <label className="field">
                <span>Your message</span>
                <textarea
                  rows={4}
                  maxLength={1000}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="For example: I have a delivery for you."
                  required
                />
              </label>
              <div className="field-meta">
                <span>
                  Plain text only. Please don’t send sensitive details.
                </span>
                <span>{message.length}/1000</span>
              </div>
              <button
                className="button primary full"
                type="submit"
                disabled={
                  sending || !message.trim() || connection === "offline"
                }
              >
                {sending ? "Sending…" : "Send message"} <Arrow />
              </button>
            </form>
            <section
              className="guest-conversation"
              aria-labelledby="conversation-title"
            >
              <div className="section-heading">
                <h2 id="conversation-title">This conversation</h2>
                <span className="eyebrow">JUST YOUR THREAD</span>
              </div>
              {olderCursor ? (
                <button
                  className="button secondary history-button"
                  onClick={() => void load(olderCursor)}
                >
                  Load earlier messages
                </button>
              ) : null}
              {view.messages.length ? (
                <div className="guest-message-list">
                  {view.messages.map((item) =>
                    item.direction === "resident" ? (
                      <GuestReply
                        key={item.id}
                        message={item}
                        csrf={view.csrf}
                        onChange={refresh}
                        onError={setError}
                      />
                    ) : (
                      <article className="guest-own-message" key={item.id}>
                        <header>
                          <strong>You</strong>
                          <time>{timeLabel(item.createdAt)}</time>
                        </header>
                        <p>{item.text}</p>
                        <span className="small muted">Accepted</span>
                      </article>
                    ),
                  )}
                </div>
              ) : (
                <Empty title="Your conversation starts here.">
                  <p>
                    Send your message above. Any household reply will appear in
                    this private thread.
                  </p>
                </Empty>
              )}
            </section>
          </>
        ) : !error ? (
          <Loading label="Opening a private conversation…" />
        ) : null}
        <aside className="guest-privacy">
          <span aria-hidden="true">◇</span>
          <p>
            Only this browser’s conversation is shown. Scanning a code does not
            prove anyone’s identity or presence. This page does not show
            household members, occupancy, video, or captions.
          </p>
        </aside>
      </main>
      <footer className="guest-footer">
        A little understanding, right at the door.
      </footer>
    </div>
  );
}
