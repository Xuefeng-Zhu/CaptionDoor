"use client";
import type { Visit } from "@captiondoor/domain";
import type { PerformVisitCommand } from "./visit-types";
import { Arrow } from "./ui";
export type ResponsibilityPanelProps = {
  visit: Visit;
  currentUserId: string;
  busy: boolean;
  perform: PerformVisitCommand;
  mobile?: boolean;
};
export function ResponsibilityPanel({
  visit,
  currentUserId,
  busy,
  perform,
  mobile = false,
}: ResponsibilityPanelProps) {
  const isHandler = visit.handlerId === currentUserId,
    isClosed = visit.status === "CLOSED";
  if (mobile)
    return isClosed ? null : (
      <section
        className="mobile-responsibility"
        aria-label="Current responsibility"
      >
        <p className="eyebrow">WHO’S HANDLING THIS</p>
        {visit.status === "UNCLAIMED" ? (
          <>
            <p>
              Take responsibility when you’re ready. Claiming sends no reply.
            </p>
            <button
              className="button primary full"
              disabled={!!busy}
              onClick={() => void perform({ type: "claim" })}
            >
              I’ll handle this. <Arrow />
            </button>
          </>
        ) : (
          <p role="status">
            <strong>
              {isHandler
                ? "You’re responsible for this visit."
                : `${visit.handlerName || "A household member"} is responsible for this visit.`}
            </strong>{" "}
            Responsibility continues when a connection drops.
          </p>
        )}
        {visit.pendingHandoff ? (
          <div className="mobile-handoff">
            <p>
              Handoff requested to {visit.pendingHandoff.targetName}.{" "}
              {visit.handlerName} remains responsible until acceptance.
            </p>
            {visit.pendingHandoff.targetUserId === currentUserId ? (
              <button
                className="button primary full"
                disabled={!!busy}
                onClick={() => void perform({ type: "accept" })}
              >
                Accept handoff
              </button>
            ) : null}
            {isHandler ? (
              <button
                className="text-button"
                disabled={!!busy}
                onClick={() => void perform({ type: "cancel" })}
              >
                Cancel handoff
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  return (
    <section className="responsibility-card">
      <p className="eyebrow">WHO’S HANDLING THIS</p>
      {visit.status === "UNCLAIMED" ? (
        <>
          <h2>Take the lead.</h2>
          <p>Claim responsibility before replying. This sends no message.</p>
          <button
            className="button primary full"
            disabled={!!busy}
            onClick={() => void perform({ type: "claim" })}
          >
            I’ll handle this. <Arrow />
          </button>
        </>
      ) : (
        <>
          <div className="handler-line">
            <span className="avatar" aria-hidden="true">
              {visit.handlerName?.slice(0, 1) || "?"}
            </span>
            <div>
              <h2>{visit.handlerName || "Household member"}</h2>
              <span>
                {isHandler
                  ? "That’s you"
                  : isClosed
                    ? "Handled this visit"
                    : "Current handler"}
              </span>
            </div>
          </div>
          {!isClosed ? (
            <p>The handler stays responsible even if their connection drops.</p>
          ) : null}
        </>
      )}
      {visit.pendingHandoff && !isClosed ? (
        <div className="handoff-pending">
          <strong>
            Handoff requested to {visit.pendingHandoff.targetName}
          </strong>
          <p>
            {visit.handlerName} remains responsible until acceptance or
            authorized takeover.
          </p>
          {visit.pendingHandoff.targetUserId === currentUserId ? (
            <button
              className="button primary full"
              disabled={!!busy}
              onClick={() => void perform({ type: "accept" })}
            >
              Accept handoff
            </button>
          ) : null}
          {isHandler ? (
            <button
              className="text-button"
              disabled={!!busy}
              onClick={() => void perform({ type: "cancel" })}
            >
              Cancel handoff
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
