import { describe, expect, it } from "vitest";
import {
  classifyProviderMediaWaitFailure,
  sanitizeMediaHttpEvidence,
} from "../../scripts/provider-media-diagnostics";

describe("credential-free provider media HTTP evidence", () => {
  it("retains only a status and an allowlisted application code", () => {
    const secret = "PRIVATE_TOKEN_SDP_OR_PROVIDER_MESSAGE";
    const evidence = sanitizeMediaHttpEvidence(403, {
      error: { code: "RING_ACCESS_DENIED", message: secret, current: secret },
      answer: secret,
      token: secret,
    });
    expect(evidence).toEqual({
      httpStatus: 403,
      appCode: "RING_ACCESS_DENIED",
    });
    expect(JSON.stringify(evidence)).not.toContain(secret);
  });

  it.each([
    {
      error: { code: "PRIVATE_TOKEN_WITHIN_CODE", message: "PRIVATE_MESSAGE" },
    },
    { error: { code: { token: "PRIVATE_TOKEN" } } },
    { error: "PRIVATE_ERROR" },
    { answer: "PRIVATE_SDP" },
    "PRIVATE_BODY",
    null,
  ])("drops unknown code text and every other response field %j", (body) => {
    expect(sanitizeMediaHttpEvidence(502, body)).toEqual({
      httpStatus: 502,
      appCode: "APP_CODE_UNOBSERVED_OR_NOT_ALLOWLISTED",
    });
  });

  it("never inspects a successful media response that can contain SDP", () => {
    const body = {
      get error(): never {
        throw new Error("A success response must not be inspected");
      },
    };
    expect(sanitizeMediaHttpEvidence(200, body)).toEqual({
      httpStatus: 200,
      appCode: null,
    });
  });

  it.each([0, 99, 600, Infinity, NaN, 200.5])(
    "does not record invalid status %s",
    (status) => {
      expect(sanitizeMediaHttpEvidence(status)).toEqual({
        httpStatus: null,
        appCode: "HTTP_STATUS_UNVERIFIED",
      });
    },
  );
});

describe("media failure classification without real provider requests", () => {
  it.each([400, 401, 403, 409, 502, 503])(
    "reports HTTP %i start failure as FAIL",
    (status) => {
      expect(
        classifyProviderMediaWaitFailure(
          { start: sanitizeMediaHttpEvidence(status), ready: null },
          false,
        ),
      ).toEqual({ result: "FAIL", category: "INCOMING_MEDIA_API_FAILED" });
    },
  );

  it("does not turn a readiness authorization failure into absent audio", () => {
    expect(
      classifyProviderMediaWaitFailure(
        {
          start: sanitizeMediaHttpEvidence(200),
          ready: sanitizeMediaHttpEvidence(403, {
            error: { code: "FORBIDDEN" },
          }),
        },
        false,
      ),
    ).toEqual({ result: "FAIL", category: "INCOMING_MEDIA_READY_API_FAILED" });
  });

  it("requires an observed successful start response before any track-absence skip", () => {
    for (const start of [null, sanitizeMediaHttpEvidence(0)])
      expect(
        classifyProviderMediaWaitFailure({ start, ready: null }, true),
      ).toEqual({
        result: "FAIL",
        category: "INCOMING_MEDIA_API_RESPONSE_NOT_OBSERVED",
      });
    expect(
      classifyProviderMediaWaitFailure(
        { start: sanitizeMediaHttpEvidence(200), ready: null },
        false,
      ),
    ).toEqual({
      result: "SKIP",
      category: "INCOMING_AUDIO_NOT_OBSERVED_WITHIN_BOUND",
    });
    expect(
      classifyProviderMediaWaitFailure(
        {
          start: sanitizeMediaHttpEvidence(200),
          ready: sanitizeMediaHttpEvidence(200),
        },
        true,
      ),
    ).toEqual({
      result: "SKIP",
      category: "PLAYGROUND_HAS_NO_INCOMING_AUDIO_TRACK",
    });
  });
});
