import { describe, it, expect } from "vitest";
import type { ConversationItem, VisitView } from "@captiondoor/domain";
import {
  appendAuthorizedCaption,
  expireVisitView,
  reconcileVisitView,
} from "../../apps/web/components/visit-privacy";
const item = (
  kind: ConversationItem["kind"],
  id: string,
  patch: Partial<ConversationItem> = {},
): ConversationItem => ({
  kind,
  id,
  text: id,
  createdAt: 1,
  expiresAt: 5000,
  ...patch,
});
const snapshot = (patch: Partial<VisitView> = {}): VisitView => ({
  access: { captions: true, visitorText: true, camera: true },
  visit: {
    id: "visit",
    householdId: "household",
    doorId: "door",
    doorName: "Front door",
    status: "CLAIMED",
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 5000,
    mediaStatus: "LIVE",
    mediaSessionId: "media",
    eventSource: "LOCAL",
    mediaSource: "LOCAL_FIXTURE",
    transcriptSource: "FIXTURE",
  },
  items: [],
  threads: [],
  ...patch,
});
describe("fresh visit content authorization", () => {
  it("purges retained captions and visitor messages on a successful sharing-withdrawal snapshot while keeping events", () => {
    const previous = snapshot({
      items: [
        item("caption", "old-final"),
        item("caption", "old-partial", {
          isPartial: true,
          mediaSessionId: "media",
          resultId: "result",
        }),
        item("message", "visitor-private"),
        item("event", "claimed"),
      ],
    });
    const next = snapshot({
      access: { captions: false, visitorText: false, camera: false },
      items: [item("event", "claimed")],
    });
    const result = reconcileVisitView(previous, next, true, 1000)!;
    expect(result.items.map((row) => row.id)).toEqual(["claimed"]);
    expect(result.access).toEqual(next.access);
  });
  it("applies independent grants to existing and newly returned content on pagination", () => {
    const previous = snapshot({
      items: [
        item("caption", "allowed-caption"),
        item("message", "denied-message"),
      ],
    });
    const next = snapshot({
      access: { captions: true, visitorText: false, camera: true },
      items: [item("message", "also-denied"), item("event", "system")],
    });
    expect(
      reconcileVisitView(previous, next, true, 1000)!
        .items.map((row) => row.id)
        .sort(),
    ).toEqual(["allowed-caption", "system"]);
  });
  it("keeps newly returned acknowledgement status authoritative over retained pagination history", () => {
    const previous = snapshot({
      items: [item("message", "reply", { deliveryStatus: "ACCEPTED" })],
    });
    const next = snapshot({
      items: [item("message", "reply", { deliveryStatus: "CONFIRMED" })],
    });
    expect(
      reconcileVisitView(previous, next, true, 1000)!.items[0].deliveryStatus,
    ).toBe("CONFIRMED");
  });
  it("does not reintroduce a delayed partial caption after the current snapshot denied caption access", () => {
    const previous = snapshot({
      access: { captions: false, visitorText: true, camera: true },
    });
    expect(
      appendAuthorizedCaption(
        previous,
        item("caption", "late", {
          mediaSessionId: "media",
          resultId: "late",
          isPartial: true,
        }),
        1000,
      ),
    ).toBe(previous);
  });
  it("retains handler-authorized captions and text when its fresh snapshot allows them", () => {
    const next = snapshot({
      items: [item("caption", "final"), item("message", "visitor")],
    });
    expect(reconcileVisitView(null, next, false, 1000)!.items).toHaveLength(2);
  });
  it("clears an expired mounted visit and filters content that expires earlier", () => {
    const previous = snapshot({
      items: [
        item("caption", "expired", { expiresAt: 999 }),
        item("event", "current"),
      ],
    });
    expect(expireVisitView(previous, 1000)!.items.map((row) => row.id)).toEqual(
      ["current"],
    );
    expect(expireVisitView(previous, 5000)).toBeNull();
    expect(
      appendAuthorizedCaption(
        previous,
        item("caption", "late", { mediaSessionId: "media" }),
        5000,
      ),
    ).toBeNull();
  });
});
