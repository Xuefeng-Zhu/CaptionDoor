import { describe, it, expect } from "vitest";
import {
  assertFresh,
  validateModes,
  type ConversationItem,
} from "@captiondoor/domain";
import { mergeItems } from "../../apps/web/components/api";
describe("expiry and production provenance gates", () => {
  it("rejects expired access independently of DynamoDB TTL cleanup", () => {
    expect(() => assertFresh(Math.floor(Date.now() / 1000) - 1)).toThrow(
      "Access has expired",
    );
    expect(() => assertFresh(Math.floor(Date.now() / 1000) + 60)).not.toThrow();
  });
  it("rejects each explicitly enabled demo source in production", () => {
    for (const overrides of [
      { AUTH_MODE: "demo" },
      { RING_MODE: "demo" },
      { TRANSCRIBE_MODE: "fixture" },
    ])
      expect(() =>
        validateModes({
          NODE_ENV: "production",
          AUTH_MODE: "oidc",
          RING_MODE: "live",
          TRANSCRIBE_MODE: "aws",
          ...overrides,
        }),
      ).toThrow(/Production rejects/);
  });
  it("fails closed when production adapter settings are omitted", () => {
    expect(() => validateModes({ NODE_ENV: "production" })).toThrow();
  });
  it("does not reject the configured real production combination", () => {
    expect(() =>
      validateModes({
        NODE_ENV: "production",
        AUTH_MODE: "oidc",
        RING_MODE: "live",
        TRANSCRIBE_MODE: "aws",
      }),
    ).not.toThrow();
  });
  it("rejects unknown adapter modes", () => {
    expect(() => validateModes({ RING_MODE: "unverified" })).toThrow(
      "Invalid RING_MODE",
    );
  });
});
describe("caption revision reconstruction after reconnect", () => {
  const caption = (override: Partial<ConversationItem>): ConversationItem => ({
    id: "caption-a",
    kind: "caption",
    createdAt: 1,
    expiresAt: 9999999999,
    text: "Do",
    mediaSessionId: "media-a",
    resultId: "r1",
    isPartial: true,
    source: "FIXTURE",
    ...override,
  });
  it("replaces partial revisions and retains a final against a delayed partial", () => {
    let items = mergeItems([], [caption({})]);
    items = mergeItems(items, [caption({ text: "Do not" })]);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("Do not");
    items = mergeItems(items, [
      caption({ text: "Do not leave it.", isPartial: false }),
    ]);
    items = mergeItems(items, [
      caption({ text: "Do not leave", isPartial: true }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("Do not leave it.");
    expect(items[0].isPartial).toBe(false);
  });
  it("keeps same result IDs isolated by media session and separates visitor text", () => {
    const items = mergeItems(
      [caption({})],
      [
        caption({
          id: "other",
          mediaSessionId: "media-b",
          text: "Other stream",
        }),
        {
          id: "message-1",
          kind: "message",
          createdAt: 2,
          expiresAt: 9999999999,
          text: "Please wait",
          direction: "resident",
          deliveryStatus: "ACCEPTED",
        },
      ],
    );
    expect(items).toHaveLength(3);
  });
});
