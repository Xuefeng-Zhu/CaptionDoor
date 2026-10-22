import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  RingClient,
  createRingOAuthAttempt,
  normalizeRingEvent,
  normalizeRingWebhook,
  parseRingWebhook,
  parseRingDevices,
  validateReceiveOnlyOffer,
  validateRingOAuthState,
  validateRingSessionLocation,
  verifyRingSignature,
} from "../../packages/integrations/src/ring";
import {
  CredentialCipher,
  credentialCipherFromEnv,
} from "../../packages/integrations/src/crypto";

const secret = "local-unit-signing-key-not-a-real-credential";
const payload = {
  meta: {
    version: "1.1",
    account_id: "account-unit",
    request_id: "delivery-1",
  },
  data: {
    id: "opaque-event-1",
    type: "button_press",
    attributes: {
      source: "device-unit",
      source_type: "devices",
      timestamp: 1_792_627_200_000,
    },
  },
};
const raw = JSON.stringify(payload);
const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
const offer =
  "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n";
const location =
  "https://api.amazonvision.com/v1/devices/device-unit/media/streaming/whep/sessions/session-unit";
describe("Ring webhook contract", () => {
  it("authenticates the exact raw bytes before parsing", () => {
    expect(verifyRingSignature(raw, signature, secret)).toBe(true);
    expect(verifyRingSignature(`${raw} `, signature, secret)).toBe(false);
    expect(
      verifyRingSignature(
        raw.replace("device-unit", "another-device"),
        signature,
        secret,
      ),
    ).toBe(false);
    expect(verifyRingSignature(raw, "sha256=00", secret)).toBe(false);
    expect(verifyRingSignature(raw, null, secret)).toBe(false);
    expect(() => parseRingWebhook("not-json", signature, secret)).toThrow(
      "signature",
    );
  });
  it("uses account and opaque delivery/event IDs independently", () => {
    expect(normalizeRingEvent(payload)).toEqual({
      accountId: "account-unit",
      deviceId: "device-unit",
      eventId: "opaque-event-1",
      deliveryId: "delivery-1",
      occurredAt: payload.data.attributes.timestamp,
    });
    expect(() =>
      parseRingWebhook(raw, signature, secret, new Set(["other-account"])),
    ).toThrow("not linked");
    expect(() =>
      normalizeRingEvent({
        ...payload,
        meta: { ...payload.meta, version: "1.0" },
      }),
    ).toThrow("version");
  });
  it("ignores valid unsupported event types without creating a press", () => {
    const unknown = {
      ...payload,
      data: { ...payload.data, type: "future_event" },
    };
    expect(normalizeRingEvent(unknown)).toBeNull();
    expect(normalizeRingWebhook(unknown).type).toBe("ignored");
    expect(
      normalizeRingWebhook({
        ...payload,
        data: { ...payload.data, type: "app_integration_removed" },
      }).type,
    ).toBe("app_integration_removed");
    const subscription = {
      meta: { ...payload.meta, time: "2026-10-22T00:00:00Z" },
      data: {
        id: "subscription-event",
        type: "subscription_deactivated",
        attributes: { source: "subscriptions", source_id: "subscription-unit" },
      },
    };
    expect(normalizeRingWebhook(subscription)).toMatchObject({
      type: "subscription_deactivated",
      occurredAt: Date.parse(subscription.meta.time),
    });
    expect(normalizeRingWebhook(subscription).deviceId).toBeUndefined();
    expect(
      normalizeRingWebhook({
        ...payload,
        data: {
          ...payload.data,
          type: "app_integration_removed",
          attributes: {
            source: "account-unit",
            source_type: "users",
            timestamp: payload.data.attributes.timestamp,
          },
        },
      }).deviceId,
    ).toBeUndefined();
  });
});
describe("Ring media boundary", () => {
  it("joins included status by both relationship type and id without guessing availability", () => {
    const devices = parseRingDevices({
      data: [
        {
          type: "devices",
          id: "first-device",
          attributes: { name: "Front" },
          relationships: {
            status: { data: { type: "device-status", id: "status-first" } },
          },
        },
        {
          type: "devices",
          id: "second-device",
          attributes: { name: "Other" },
          relationships: {
            status: { data: { type: "device-status", id: "status-second" } },
          },
        },
        { type: "devices", id: "third-device", attributes: {} },
      ],
      included: [
        {
          type: "device-status",
          id: "status-second",
          attributes: { online: false },
        },
        {
          type: "device-status",
          id: "status-first",
          attributes: { online: true },
        },
        {
          type: "device-capabilities",
          id: "status-first",
          attributes: { online: false },
        },
      ],
    });
    expect(devices.map((device) => device.online)).toEqual([
      true,
      false,
      undefined,
    ]);
    expect(devices[0].attributes).not.toHaveProperty("status");
  });
  it("allows only trusted session paths for the selected device", () => {
    expect(validateRingSessionLocation(location, "device-unit")).toBe(location);
    for (const bad of [
      "http://127.0.0.1:8410/",
      location.replace(
        "api.amazonvision.com",
        "api.amazonvision.com.evil.example",
      ),
      location.replace("device-unit", "other-device"),
      `${location}?redirect=1`,
      `${location}/extra`,
      location.replace("https://", "https://user@"),
      location.replace("session-unit", "%2Fsecrets"),
    ])
      expect(() => validateRingSessionLocation(bad, "device-unit")).toThrow();
  });
  it("requires a video track and exclusively receive-only directions", () => {
    expect(() => validateReceiveOnlyOffer(offer)).not.toThrow();
    expect(() =>
      validateReceiveOnlyOffer(offer.replace("a=recvonly", "a=sendrecv")),
    ).toThrow();
    expect(() => validateReceiveOnlyOffer(`${offer}a=sendonly\r\n`)).toThrow();
    expect(() =>
      validateReceiveOnlyOffer(
        "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n",
      ),
    ).toThrow();
  });
  it("uses backend bearer, checks encryption and creates an opaque app ID", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: { attributes: { e2e_encryption: { enabled: false } } },
        }),
      )
      .mockResolvedValueOnce(
        new Response("v=0\r\ns=answer\r\n", {
          status: 201,
          headers: { Location: location },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RingClient({
      mode: "playground",
      accessToken: "unit-token",
      fetch: transport,
    });
    const session = await client.createWhepSession("device-unit", offer);
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.id).not.toContain("session-unit");
    expect(session.source).toBe("PLAYGROUND");
    expect(session.expiresAt - Date.now()).toBeGreaterThan(29_000);
    const [url, init] = transport.mock.calls[1];
    expect(url).toBe(location.replace("/session-unit", ""));
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer unit-token",
    );
    expect(init?.body).toBe(offer);
    await client.closeWhepSession(session);
    expect(transport.mock.calls[2][1]?.method).toBe("DELETE");
  });
  it("reports encryption and missing credentials without fallback", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({
          data: { attributes: { e2e_encryption: { enabled: true } } },
        }),
      );
    await expect(
      new RingClient({
        mode: "playground",
        accessToken: "unit",
        fetch: transport,
      }).createWhepSession("device-unit", offer),
    ).rejects.toThrow("Encrypted");
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(
      new RingClient({ mode: "playground", fetch: transport }).listDevices(),
    ).rejects.toThrow("credentials");
    await expect(
      new RingClient({ mode: "demo", fetch: transport }).listDevices(),
    ).rejects.toThrow("simulation");
  });
});
describe("Ring OAuth boundaries", () => {
  it("uses PKCE S256, fixed origin, HTTPS callback and session state expiry", () => {
    const { attempt, authorizationUrl } = createRingOAuthAttempt(
      "client-unit",
      "https://localhost:3443/api/ring/callback",
      1000,
    );
    const url = new URL(authorizationUrl);
    expect(url.origin).toBe("https://account.ring.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("ava.v1:read");
    expect(authorizationUrl).not.toContain(attempt.verifier);
    expect(() =>
      validateRingOAuthState(attempt, attempt.state, 2000),
    ).not.toThrow();
    expect(() => validateRingOAuthState(attempt, "wrong", 2000)).toThrow();
    expect(() =>
      validateRingOAuthState(attempt, attempt.state, attempt.expiresAt),
    ).toThrow();
    expect(() =>
      createRingOAuthAttempt("client-unit", "http://localhost/callback"),
    ).toThrow("HTTPS");
  });
  it("keeps Playground tokens out of linking, refreshing and unlink calls", async () => {
    const transport = vi.fn<typeof fetch>();
    const client = new RingClient({
      mode: "playground",
      accessToken: "unit-token",
      fetch: transport,
    });
    await expect(client.refresh("refresh-unit")).rejects.toThrow("Playground");
    await expect(client.completeLink("a***x@example.invalid")).rejects.toThrow(
      "Playground",
    );
    await expect(client.unlink()).rejects.toThrow("Playground");
    expect(transport).not.toHaveBeenCalled();
  });
  it("sends exact token and explicit completion requests without exposing credentials", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "access-unit",
          refresh_token: "refresh-unit",
          expires_in: 14400,
          token_type: "Bearer",
          scope: "ava.v1:read",
        }),
      )
      .mockResolvedValueOnce(Response.json({ status: "completed" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RingClient({
      mode: "live",
      accessToken: "access-unit",
      clientId: "id-unit",
      clientSecret: "secret-unit",
      fetch: transport,
    });
    const tokens = await client.exchangeAuthorizationCode(
      "code-unit",
      "v".repeat(43),
    );
    expect(tokens.refreshToken).toBe("refresh-unit");
    expect(transport.mock.calls[0][0]).toBe(
      "https://oauth.ring.com/oauth/token",
    );
    expect(
      (transport.mock.calls[0][1]?.body as URLSearchParams).get(
        "code_verifier",
      ),
    ).toBe("v".repeat(43));
    await client.completeLink("a***x@example.invalid");
    expect(JSON.parse(String(transport.mock.calls[1][1]?.body))).toEqual({
      status: "completed",
      account_identifier: "a***x@example.invalid",
    });
    await client.unlink();
    expect(transport.mock.calls[2][1]?.method).toBe("DELETE");
  });
  it("uses the official users resource id for account/webhook correlation", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({
          data: {
            type: "users",
            id: "ava1.ring.account.unit",
            attributes: { first_name: "Unit" },
          },
        }),
      );
    const client = new RingClient({
      mode: "playground",
      accessToken: "unit-token",
      fetch: transport,
    });
    expect(await client.getAccountId()).toBe("ava1.ring.account.unit");
  });
});
describe("Ring credential encryption", () => {
  const options = {
    mode: "development" as const,
    keyBase64: Buffer.alloc(32, 7).toString("base64"),
    nodeEnv: "test",
  };
  const context = { householdId: "home-unit", integrationId: "ring-unit" };
  it("encrypts at rest and cryptographically binds ciphertext to its household", async () => {
    const cipher = new CredentialCipher(options);
    const envelope = await cipher.encrypt(
      { accessToken: "private-access-unit" },
      context,
    );
    expect(JSON.stringify(envelope)).not.toContain("private-access-unit");
    expect(await cipher.decrypt(envelope, context)).toEqual({
      accessToken: "private-access-unit",
    });
    await expect(
      cipher.decrypt(envelope, { ...context, householdId: "other-home" }),
    ).rejects.toThrow("decrypted");
    await expect(
      cipher.decrypt(
        { ...envelope, ciphertext: Buffer.alloc(16).toString("base64") },
        context,
      ),
    ).rejects.toThrow("decrypted");
  });
  it("rejects implicit or production development keys", () => {
    expect(() => credentialCipherFromEnv({})).toThrow("Select KMS");
    expect(
      () => new CredentialCipher({ ...options, nodeEnv: "production" }),
    ).toThrow("KMS");
    expect(() => new CredentialCipher({ ...options, keyBase64: "" })).toThrow(
      "32-byte",
    );
  });
});
