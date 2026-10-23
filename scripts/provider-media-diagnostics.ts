const safeAppCodes = new Set([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "CSRF",
  "ORIGIN_DENIED",
  "NOT_FOUND",
  "VALIDATION",
  "INVALID_JSON",
  "TOO_LARGE",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "HANDLER_REQUIRED",
  "MEDIA_STALE",
  "MEDIA_EXPIRED",
  "INVALID_SDP",
  "RING_DEVICE_REQUIRED",
  "RING_ACCESS_EXPIRED",
  "RING_ACCESS_DENIED",
  "RING_REQUEST_FAILED",
  "RING_UNAVAILABLE",
  "RING_CREDENTIALS_REQUIRED",
  "RING_MEDIA_ENCRYPTED",
  "RING_INVALID_RESPONSE",
  "RING_SESSION_URL_INVALID",
  "RING_CLEANUP_SCOPE_INVALID",
  "RING_CLEANUP_EXPIRED",
  "RING_ACCESS_CHANGED",
  "RING_MEDIA_CLEANUP_UNCONFIRMED",
  "PROVIDER_MEDIA_CHECKPOINT_SCOPE_INVALID",
  "PROVIDER_MEDIA_CHECKPOINT_INVALID",
  "PROVIDER_MEDIA_CHECKPOINT_READ_FAILED",
  "PROVIDER_MEDIA_CHECKPOINT_WRITE_FAILED",
  "PROVIDER_MEDIA_CHECKPOINT_ALREADY_EXISTS",
]);

export type MediaHttpEvidence = {
  httpStatus: number | null;
  appCode: string | null;
};
export type ProviderMediaHttpDiagnostics = {
  start: MediaHttpEvidence | null;
  ready: MediaHttpEvidence | null;
};

/** Return only status and a fixed code. Never retain messages, bodies, SDP, URLs or unknown code text. */
export function sanitizeMediaHttpEvidence(
  status: number,
  errorResponse?: unknown,
): MediaHttpEvidence {
  if (!Number.isInteger(status) || status < 100 || status > 599)
    return { httpStatus: null, appCode: "HTTP_STATUS_UNVERIFIED" };
  if (status >= 200 && status < 300)
    return { httpStatus: status, appCode: null };
  const value = errorResponse as { error?: { code?: unknown } } | undefined;
  const code = value?.error?.code;
  return {
    httpStatus: status,
    appCode:
      typeof code === "string" && safeAppCodes.has(code)
        ? code
        : "APP_CODE_UNOBSERVED_OR_NOT_ALLOWLISTED",
  };
}

const failed = (value: MediaHttpEvidence | null) =>
  value?.httpStatus !== null &&
  value?.httpStatus !== undefined &&
  (value.httpStatus < 200 || value.httpStatus >= 300);

/** Track absence is a skip only after an observed successful application media response. */
export function classifyProviderMediaWaitFailure(
  diagnostics: ProviderMediaHttpDiagnostics,
  noAudioLabel: boolean,
): { result: "FAIL" | "SKIP"; category: string } {
  if (failed(diagnostics.start))
    return { result: "FAIL", category: "INCOMING_MEDIA_API_FAILED" };
  if (failed(diagnostics.ready))
    return { result: "FAIL", category: "INCOMING_MEDIA_READY_API_FAILED" };
  const status = diagnostics.start?.httpStatus;
  if (status === null || status === undefined || status < 200 || status >= 300)
    return {
      result: "FAIL",
      category: "INCOMING_MEDIA_API_RESPONSE_NOT_OBSERVED",
    };
  return {
    result: "SKIP",
    category: noAudioLabel
      ? "PLAYGROUND_HAS_NO_INCOMING_AUDIO_TRACK"
      : "INCOMING_AUDIO_NOT_OBSERVED_WITHIN_BOUND",
  };
}
