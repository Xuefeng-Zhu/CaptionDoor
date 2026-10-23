"use client";
import { useState, type ReactNode } from "react";
import type { Bootstrap, Thread, Visit } from "@captiondoor/domain";
import type { PerformVisitCommand } from "./visit-types";
import { ResponsibilityPanel } from "./responsibility-panel";
import { Arrow } from "./ui";
export type VisitActionPanelsProps = {
  data: Bootstrap;
  visit: Visit;
  associated: Thread[];
  candidates: Thread[];
  busy: boolean;
  perform: PerformVisitCommand;
  onReplyAccepted: () => void;
  onDeleted: () => void;
  conversation: ReactNode;
};
export function VisitActionPanels({
  data,
  visit,
  associated,
  candidates,
  busy,
  perform,
  onReplyAccepted,
  onDeleted,
  conversation,
}: VisitActionPanelsProps) {
  const [reply, setReply] = useState(""),
    [selectedThread, setSelectedThread] = useState(""),
    [handoffTarget, setHandoffTarget] = useState(""),
    [outcome, setOutcome] = useState<
      "COMPLETED" | "DISMISSED" | "NO_RESPONSE_RECORDED"
    >("COMPLETED");
  const isHandler = visit.handlerId === data.user.id,
    isClosed = visit.status === "CLOSED";
  return (
    <aside className="visit-actions" aria-label="Visit actions">
      <ResponsibilityPanel
        visit={visit}
        currentUserId={data.user.id}
        busy={busy}
        perform={perform}
      />
      {isHandler && !isClosed ? (
        <>
          <details className="action-details closure">
            <summary>Close this visit</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void perform({ type: "close", outcome });
              }}
            >
              <p className="small muted">
                After handling the visit in person, record the outcome. A
                timeout does not prove departure.
              </p>
              <label className="field">
                <span>Outcome</span>
                <select
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value as typeof outcome)}
                >
                  <option value="COMPLETED">Completed</option>
                  <option value="DISMISSED">Dismissed</option>
                  <option value="NO_RESPONSE_RECORDED">
                    No response recorded
                  </option>
                </select>
              </label>
              <button
                className="button secondary full"
                disabled={!!busy}
                type="submit"
              >
                Close visit
              </button>
            </form>
          </details>
          <details className="action-details">
            <summary>Hand over responsibility</summary>
            <div>
              <p className="small muted">
                You remain responsible until the other member accepts.
              </p>
              <label className="field">
                <span>Household member</span>
                <select
                  value={handoffTarget}
                  onChange={(e) => setHandoffTarget(e.target.value)}
                >
                  <option value="">Choose a member</option>
                  {data.members
                    .filter((m) => m.userId !== data.user.id && !m.revoked)
                    .map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </label>
              <button
                className="button secondary full"
                disabled={!!busy || !handoffTarget || !!visit.pendingHandoff}
                onClick={() =>
                  void perform({
                    type: "handoff",
                    targetUserId: handoffTarget,
                  })
                }
              >
                Request handoff
              </button>
            </div>
          </details>
        </>
      ) : null}
      <details className="optional-visitor-text">
        <summary>Visitor text (optional)</summary>
        <div className="optional-visitor-body">
          <p className="small muted">
            Messages reach a visitor’s web page, never the Ring speaker. A
            visitor without a phone can provide incoming speech but cannot
            receive a web reply.
          </p>
          {conversation}
          {isHandler && !isClosed ? (
            <>
              <section className="reply-card">
                <h2>Reply by text</h2>
                {associated.length ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void (async () => {
                        const result = await perform({
                          type: "reply",
                          threadId: selectedThread || associated[0].id,
                          text: reply.trim(),
                        });
                        if (result) {
                          setReply("");
                          onReplyAccepted();
                        }
                      })();
                    }}
                  >
                    <label className="field">
                      <span>Visitor thread</span>
                      <select
                        value={selectedThread || associated[0].id}
                        onChange={(e) => setSelectedThread(e.target.value)}
                      >
                        {associated.map((thread) => (
                          <option value={thread.id} key={thread.id}>
                            {thread.category || "Visitor"} ·{" "}
                            {thread.id.slice(-6)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div
                      className="quick-replies"
                      aria-label="Quick reply starting points"
                    >
                      {data.settings.presets.map((preset, index) => (
                        <button
                          type="button"
                          className="preset"
                          key={index}
                          onClick={() => setReply(preset)}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                    <label className="field">
                      <span>Your reply</span>
                      <textarea
                        maxLength={1000}
                        rows={4}
                        placeholder="Write or edit your reply…"
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                      />
                    </label>
                    <div className="field-meta">
                      <span>Goes to this visitor’s web page</span>
                      <span>{reply.length}/1000</span>
                    </div>
                    <button
                      className="button primary full"
                      disabled={!!busy || !reply.trim()}
                      type="submit"
                    >
                      Send to visitor page <Arrow />
                    </button>
                  </form>
                ) : (
                  <div className="no-recipient">
                    <p>No visitor page is associated yet.</p>
                    <p className="small muted">
                      Replies cannot speak through Ring. A visitor without a
                      phone can provide incoming speech for captions, but cannot
                      receive a web reply.
                    </p>
                  </div>
                )}
              </section>
              <section className="association-card">
                <h3>Associate a visitor thread</h3>
                <p className="small muted">
                  Only you choose which thread belongs to this visit. Timing and
                  a QR scan do not prove identity or presence.
                </p>
                {candidates.length ? (
                  candidates.map((thread) => (
                    <div className="candidate-thread" key={thread.id}>
                      <strong>
                        {thread.category || "Visitor"} · {thread.id.slice(-6)}
                      </strong>
                      <p>
                        {thread.lastMessage || "No message preview available."}
                      </p>
                      <button
                        className="button secondary full"
                        disabled={!!busy}
                        onClick={() =>
                          void perform({
                            type: "associate",
                            threadId: thread.id,
                          })
                        }
                      >
                        Associate thread
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="small muted">
                    No unassociated threads at this door.
                  </p>
                )}
                <a
                  className="text-link small"
                  target="_blank"
                  rel="noreferrer"
                  href={`/door/${data.doors.find((d) => d.id === visit.doorId)?.publicDoorId || "front-demo"}`}
                >
                  Open visitor page <Arrow />
                </a>
              </section>
            </>
          ) : null}
        </div>
      </details>
      {visit.status === "CLAIMED" && !isHandler && !isClosed ? (
        <details className="action-details">
          <summary>Take over this visit</summary>
          <div>
            <p className="small muted">
              Authorized takeover replaces the current handler and stops their
              audio lease. It does not send a message.
            </p>
            <button
              className="button secondary full"
              disabled={!!busy}
              onClick={() => void perform({ type: "takeover" })}
            >
              Take responsibility
            </button>
          </div>
        </details>
      ) : null}
      {isClosed ? (
        <details className="action-details">
          <summary>Delete retained conversation</summary>
          <div>
            <p className="small muted">
              Access will be revoked and a durable deletion job will remove this
              visit’s stored content. Provider and backup limits still apply.
            </p>
            <button
              className="button secondary full danger"
              disabled={!!busy}
              onClick={() =>
                void (async () => {
                  const result = await perform({ type: "delete" });
                  if (result) onDeleted();
                })()
              }
            >
              Request content deletion
            </button>
          </div>
        </details>
      ) : null}
    </aside>
  );
}
