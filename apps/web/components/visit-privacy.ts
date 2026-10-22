import type { ConversationItem, VisitView } from "@captiondoor/domain";
import { mergeItems } from "./api";
const deniedAccess: VisitView["access"] = {
  captions: false,
  visitorText: false,
  camera: false,
};
function permitted(
  item: ConversationItem,
  access: VisitView["access"],
  now: number,
) {
  return (
    item.expiresAt > now &&
    (item.kind === "event" ||
      (item.kind === "caption" && access.captions) ||
      (item.kind === "message" && access.visitorText))
  );
}
/** A fresh authorization snapshot always governs retained history and live partials. */
export function reconcileVisitView(
  previous: VisitView | null,
  next: VisitView,
  appendHistory: boolean,
  now = Math.floor(Date.now() / 1000),
): VisitView | null {
  if (next.visit.expiresAt <= now) return null;
  const access = next.access ?? deniedAccess;
  const incoming = next.items.filter((item) => permitted(item, access, now));
  const retained = (previous?.items ?? []).filter((item) =>
    permitted(item, access, now),
  );
  const history = appendHistory
    ? retained
    : retained.filter(
        (item) =>
          item.kind === "caption" &&
          item.isPartial &&
          item.mediaSessionId === next.visit.mediaSessionId &&
          ["LIVE", "CONNECTING"].includes(next.visit.mediaStatus),
      );
  return {
    ...next,
    access,
    items: appendHistory
      ? mergeItems(retained, incoming)
      : mergeItems(incoming, history),
    threads: access.visitorText
      ? next.threads.filter((thread) => thread.expiresAt > now)
      : [],
  };
}
export function appendAuthorizedCaption(
  previous: VisitView | null,
  caption: ConversationItem,
  now = Math.floor(Date.now() / 1000),
): VisitView | null {
  if (!previous) return null;
  if (previous.visit.expiresAt <= now) return null;
  if (
    !previous.access?.captions ||
    caption.kind !== "caption" ||
    !permitted(caption, previous.access, now) ||
    caption.mediaSessionId !== previous.visit.mediaSessionId
  )
    return previous;
  return { ...previous, items: mergeItems(previous.items, [caption]) };
}
export function expireVisitView(
  previous: VisitView | null,
  now = Math.floor(Date.now() / 1000),
): VisitView | null {
  if (!previous || previous.visit.expiresAt <= now) return null;
  const access = previous.access ?? deniedAccess;
  return {
    ...previous,
    access,
    items: previous.items.filter((item) => permitted(item, access, now)),
    threads: access.visitorText
      ? previous.threads.filter((thread) => thread.expiresAt > now)
      : [],
  };
}
