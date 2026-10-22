"use client";
import type { ConversationItem } from "@captiondoor/domain";
import { timeLabel } from "./api";
import { Empty } from "./ui";
export type ConversationPanelProps = {
  messages: ConversationItem[];
  hasVisitorTextAccess: boolean;
  associatedCount: number;
  nextCursor?: string;
  busy: boolean;
  loadEarlier: (cursor: string) => Promise<void>;
};
export function ConversationPanel({
  messages,
  hasVisitorTextAccess,
  associatedCount,
  nextCursor,
  busy,
  loadEarlier,
}: ConversationPanelProps) {
  return (
    <section className="messages-card" aria-labelledby="messages-title">
      <div className="section-top">
        <div>
          <p className="eyebrow">A SEPARATE CONVERSATION</p>
          <h2 id="messages-title">Visitor text & replies</h2>
        </div>
        <span className="small muted">
          {associatedCount} associated thread
          {associatedCount === 1 ? "" : "s"}
        </span>
      </div>
      {!hasVisitorTextAccess ? (
        <div role="status">
          <Empty title="Visitor text access is unavailable">
            <p>
              Current permissions or household sharing do not allow you to view
              visitor messages or resident replies for this visit.
            </p>
          </Empty>
        </div>
      ) : messages.length ? (
        <div className="message-list">
          {messages.map((m) => (
            <article
              className={`message-item ${m.direction === "resident" ? "resident-message" : "visitor-message"}`}
              key={m.id}
            >
              <header>
                <strong>
                  {m.direction === "resident"
                    ? "Household reply"
                    : "Visitor message"}
                </strong>
                <time>{timeLabel(m.createdAt)}</time>
              </header>
              <p>{m.text}</p>
              <footer>
                <span className="message-thread">
                  Thread {m.threadId?.slice(-6)}
                </span>
                {m.direction === "resident" ? (
                  <span
                    className={`delivery-status ${m.deliveryStatus?.toLowerCase()}`}
                  >
                    {m.deliveryStatus === "CONFIRMED"
                      ? "Confirmed · visitor chose “Got it”"
                      : m.deliveryStatus === "DISPLAYED"
                        ? "Displayed on visitor page"
                        : "Accepted · awaiting display"}
                  </span>
                ) : (
                  <span>Accepted</span>
                )}
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <Empty title="No visitor text yet.">
          <p>
            A visitor can scan the sign to send a private message. You associate
            their thread explicitly.
          </p>
        </Empty>
      )}
      <p className="message-disclaimer">
        Accepted means stored. Displayed means rendered on the visitor page.
        Confirmed means the visitor explicitly chose “Got it”.
      </p>
      {nextCursor ? (
        <button
          className="button secondary"
          disabled={!!busy}
          onClick={() => void loadEarlier(nextCursor)}
        >
          Load earlier conversation
        </button>
      ) : null}
    </section>
  );
}
export function SessionEvents({ events }: { events: ConversationItem[] }) {
  return (
    <details className="events-panel">
      <summary>
        Session events <span>{events.length}</span>
      </summary>
      <ol>
        {events.map((event) => (
          <li key={event.id}>
            <time>{timeLabel(event.createdAt)}</time>
            <span>{event.text}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
