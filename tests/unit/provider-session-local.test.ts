import { describe, expect, it, vi } from "vitest";
import {
  assertSessionLocalScope,
  parseProviderSessionLocalArgs,
  setupProviderSessionLocal,
  verifyProviderSessionCleanup,
  type ProviderSessionCleanupDependencies,
  type ProviderSessionCleanupScope,
} from "../../scripts/provider-session-local";
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  CAPTIONDOOR_ENV: "local",
  CAPTIONDOOR_DB_MODE: "local",
  AUTH_MODE: "demo",
  RING_MODE: "playground",
  CAPTIONDOOR_PROVIDER_SMOKE: "1",
  APP_ORIGIN: "http://127.0.0.1:3410",
  DYNAMODB_ENDPOINT: "http://127.0.0.1:8410",
  CAPTIONDOOR_CONFIG_TABLE: "CaptionDoorProviderSmoke20261022Config",
  CAPTIONDOOR_VISITS_TABLE: "CaptionDoorProviderSmoke20261022Visits",
  CAPTIONDOOR_RUNTIME_TABLE: "CaptionDoorProviderSmoke20261022Runtime",
  CAPTIONDOOR_ROOT_SMOKE: "1",
  CAPTIONDOOR_ROOT_SMOKE_APPROVAL: "captiondoor-root-verification-20261022",
  CAPTIONDOOR_SMOKE_APPROVAL: "captions",
  TRANSCRIBE_MODE: "aws",
  TRANSCRIBE_AWS_ACCOUNT_ID: "256604024085",
  TRANSCRIBE_AWS_REGION: "us-east-1",
};
const scope: ProviderSessionCleanupScope = {
  householdId: "h1",
  visitId: "12345678-1234-4234-8234-123456789012",
  mediaSessionId: "abcdefab-1234-4234-8234-123456789012",
  mediaAttempted: true,
};
const PK = `HOUSEHOLD#h1#VISIT#${scope.visitId}`;
const mediaPK = `MEDIA#h1#${scope.mediaSessionId}`;
const row = () => ({
  PK: mediaPK,
  SK: "SESSION",
  householdId: "h1",
  visitId: scope.visitId,
  mediaSessionId: scope.mediaSessionId,
  cleanupSource: "PLAYGROUND",
  cleanupCredentials: { fictional: "not printed" },
});
function deps(): ProviderSessionCleanupDependencies {
  return {
    queryKeys: vi.fn(async () => ({ keys: [] })),
    readMedia: vi.fn(async () => undefined),
    readVisitState: vi.fn(async () => undefined),
    closeMedia: vi.fn(async () => ({ providerCloseConfirmed: true })),
  };
}

describe("provider-session Local-only setup boundary", () => {
  it.each([
    ["NODE_ENV", "production"],
    ["CAPTIONDOOR_DB_MODE", "aws"],
    ["CAPTIONDOOR_ENV", "remote-demo"],
    ["DYNAMODB_ENDPOINT", "https://example.invalid"],
    ["CAPTIONDOOR_RUNTIME_TABLE", "CaptionDoorRuntime"],
    ["CAPTIONDOOR_ROOT_SMOKE_APPROVAL", "unapproved-new-scope"],
  ])("rejects %s before invoking setup or reads", async (key, value) => {
    const setup = { ensureTables: vi.fn(), seedLocal: vi.fn() };
    await expect(
      setupProviderSessionLocal({ ...env, [key]: value }, setup),
    ).rejects.toThrow("FIXED_LOCAL_SESSION_SCOPE_REQUIRED");
    expect(setup.ensureTables).not.toHaveBeenCalled();
    const d = deps();
    await expect(
      verifyProviderSessionCleanup({ ...env, [key]: value }, scope, d),
    ).rejects.toThrow("FIXED_LOCAL_SESSION_SCOPE_REQUIRED");
    expect(d.queryKeys).not.toHaveBeenCalled();
  });
  it("only ensures tables and conditionally seeds; no reset or ledger API exists", async () => {
    const calls: string[] = [];
    const result = await setupProviderSessionLocal(env, {
      async ensureTables() {
        calls.push("ensure");
      },
      async seedLocal() {
        calls.push("seed-missing");
      },
    });
    expect(calls).toEqual(["ensure", "seed-missing"]);
    expect(result).toEqual({ result: "PASS", category: "LOCAL_TABLES_READY" });
    expect(() => assertSessionLocalScope(env)).not.toThrow();
  });
  it("sanitizes setup errors containing fake secrets", async () => {
    const secret = "fictional-do-not-print-me";
    await expect(
      setupProviderSessionLocal(env, {
        async ensureTables() {
          throw new Error(secret);
        },
        seedLocal: vi.fn(),
      }),
    ).rejects.toThrow("LOCAL_TABLE_PREPARATION_FAILED");
  });
});

describe("own provider-session cleanup verification", () => {
  it("strong-read adapters receive only own fixed partition and media keys", async () => {
    const d = deps();
    const result = await verifyProviderSessionCleanup(env, scope, d);
    expect(d.queryKeys).toHaveBeenNthCalledWith(1, "visits", PK, undefined);
    expect(d.queryKeys).toHaveBeenNthCalledWith(2, "runtime", PK, undefined);
    expect(d.readMedia).toHaveBeenCalledWith(mediaPK);
    expect(d.closeMedia).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      result: "PASS",
      cleanupCredentialsAbsent: true,
      providerDeleteObserved: false,
    });
  });
  it("does not infer physical deletion from access denial or a still-present row", async () => {
    const d = deps();
    vi.mocked(d.queryKeys).mockResolvedValueOnce({
      keys: [{ PK, SK: "STATE" }],
    });
    const result = await verifyProviderSessionCleanup(env, scope, d);
    expect(result).toMatchObject({
      result: "PENDING",
      category: "OWN_CONTENT_DELETION_PENDING",
      visitRowsRemaining: 1,
    });
  });
  it("keeps an encrypted copy pending unless recovery is explicitly requested", async () => {
    const d = deps();
    vi.mocked(d.readMedia).mockResolvedValue(row());
    const result = await verifyProviderSessionCleanup(env, scope, d);
    expect(result).toMatchObject({
      result: "PENDING",
      category: "MEDIA_CLEANUP_COPY_REMAINS",
      cleanupCredentialsAbsent: false,
    });
    expect(d.closeMedia).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("not printed");
  });
  it("uses the existing scoped handler and then independently verifies absence", async () => {
    const d = deps();
    vi.mocked(d.readMedia)
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(undefined);
    const result = await verifyProviderSessionCleanup(env, scope, d, {
      recoverMedia: true,
    });
    expect(d.closeMedia).toHaveBeenCalledWith("h1", scope.mediaSessionId);
    expect(d.readMedia).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      result: "PASS",
      cleanupCredentialsAbsent: true,
      providerDeleteObserved: true,
    });
  });
  it("records expiry-based removal separately from an observed provider DELETE", async () => {
    const d = deps();
    vi.mocked(d.readMedia)
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(undefined);
    vi.mocked(d.closeMedia).mockResolvedValue({
      providerCloseConfirmed: false,
      providerExpiryElapsed: true,
    });
    expect(
      await verifyProviderSessionCleanup(env, scope, d, { recoverMedia: true }),
    ).toMatchObject({
      result: "PASS",
      providerDeleteObserved: false,
      providerExpiryElapsed: true,
    });
  });
  it("re-reads after an uncertain cleanup error instead of guessing or echoing it", async () => {
    const d = deps();
    vi.mocked(d.readMedia)
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row());
    vi.mocked(d.closeMedia).mockRejectedValue(
      new Error("https://token:fictional@example.invalid/private"),
    );
    const result = await verifyProviderSessionCleanup(env, scope, d, {
      recoverMedia: true,
    });
    expect(d.readMedia).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      result: "PENDING",
      cleanupActionUnconfirmed: true,
      cleanupCredentialsAbsent: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/fictional|example|https/);
  });
  it("can confirm copy absence after uncertain completion without claiming provider success", async () => {
    const d = deps();
    vi.mocked(d.readMedia)
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(undefined);
    vi.mocked(d.closeMedia).mockRejectedValue(
      new Error("private transport diagnostic"),
    );
    expect(
      await verifyProviderSessionCleanup(env, scope, d, { recoverMedia: true }),
    ).toMatchObject({
      result: "PASS",
      cleanupActionUnconfirmed: true,
      providerDeleteObserved: false,
    });
  });
  it.each([
    { householdId: "h2" },
    { visitId: "different-visit" },
    { mediaSessionId: "different-media" },
    { cleanupSource: "LIVE" },
  ])(
    "refuses an unrelated or differently sourced cleanup row %j",
    async (overrides) => {
      const d = deps();
      vi.mocked(d.readMedia).mockResolvedValue({ ...row(), ...overrides });
      await expect(
        verifyProviderSessionCleanup(env, scope, d, { recoverMedia: true }),
      ).rejects.toThrow("CLEANUP_MEDIA_BINDING_MISMATCH");
      expect(d.closeMedia).not.toHaveBeenCalled();
    },
  );
  it("keeps incomplete media scope pending without scanning for guessed IDs", async () => {
    const d = deps();
    const result = await verifyProviderSessionCleanup(
      env,
      { ...scope, mediaSessionId: undefined },
      d,
    );
    expect(result).toMatchObject({
      result: "PENDING",
      category: "MEDIA_SCOPE_UNVERIFIED",
      cleanupCredentialsAbsent: false,
    });
    expect(d.readVisitState).toHaveBeenCalledWith(PK);
    expect(d.readMedia).not.toHaveBeenCalled();
    expect(d.closeMedia).not.toHaveBeenCalled();
  });
  it("derives only the media UUID from its exact own strongly-read visit", async () => {
    const d = deps();
    vi.mocked(d.readVisitState).mockResolvedValue({
      PK,
      SK: "STATE",
      id: scope.visitId,
      householdId: "h1",
      mediaSessionId: scope.mediaSessionId,
    });
    const result = await verifyProviderSessionCleanup(
      env,
      { ...scope, mediaSessionId: undefined },
      d,
    );
    expect(result).toMatchObject({
      result: "PASS",
      cleanupCredentialsAbsent: true,
      resolvedMediaSessionId: scope.mediaSessionId,
    });
    expect(d.readMedia).toHaveBeenCalledWith(mediaPK);
  });
  it("refuses a mismatched fallback visit before recovering anything", async () => {
    const d = deps();
    vi.mocked(d.readVisitState).mockResolvedValue({
      PK,
      SK: "STATE",
      id: scope.visitId,
      householdId: "h2",
      mediaSessionId: scope.mediaSessionId,
    });
    await expect(
      verifyProviderSessionCleanup(
        env,
        { ...scope, mediaSessionId: undefined },
        d,
        { recoverMedia: true },
      ),
    ).rejects.toThrow("CLEANUP_VISIT_BINDING_MISMATCH");
    expect(d.readMedia).not.toHaveBeenCalled();
    expect(d.closeMedia).not.toHaveBeenCalled();
  });
  it("accepts no-created-visit evidence without inspecting unrelated rows", async () => {
    const d = deps();
    expect(
      await verifyProviderSessionCleanup(
        env,
        { householdId: "h1", mediaAttempted: false },
        d,
      ),
    ).toMatchObject({ result: "PASS", cleanupCredentialsAbsent: true });
    expect(d.queryKeys).not.toHaveBeenCalled();
  });
  it("bounds pagination and refuses cross-partition results", async () => {
    const d = deps();
    vi.mocked(d.queryKeys).mockResolvedValue({
      keys: [],
      cursor: { PK, SK: "SAME" },
    });
    await expect(verifyProviderSessionCleanup(env, scope, d)).rejects.toThrow(
      "CLEANUP_QUERY_BOUND_EXCEEDED",
    );
    vi.mocked(d.queryKeys).mockResolvedValue({
      keys: [{ PK: "OTHER", SK: "STATE" }],
    });
    await expect(verifyProviderSessionCleanup(env, scope, d)).rejects.toThrow(
      "CLEANUP_QUERY_SCOPE_MISMATCH",
    );
  });
  it("follows bounded own-partition cursors across pages", async () => {
    const d = deps();
    const cursor = { PK, SK: "A" };
    vi.mocked(d.queryKeys)
      .mockResolvedValueOnce({ keys: [{ PK, SK: "A" }], cursor })
      .mockResolvedValueOnce({ keys: [{ PK, SK: "B" }] });
    const result = await verifyProviderSessionCleanup(env, scope, d);
    expect(d.queryKeys).toHaveBeenNthCalledWith(2, "visits", PK, cursor);
    expect(result.visitRowsRemaining).toBe(2);
  });
  it("sanitizes raw local read failures", async () => {
    const d = deps();
    vi.mocked(d.queryKeys).mockRejectedValue(
      new Error("fictional secret supplied by transport"),
    );
    await expect(verifyProviderSessionCleanup(env, scope, d)).rejects.toThrow(
      "LOCAL_CLEANUP_READ_FAILED",
    );
  });
});

describe("provider-session helper CLI arguments", () => {
  it("accepts setup and exact cleanup fields", () => {
    expect(parseProviderSessionLocalArgs(["setup"])).toEqual({ mode: "setup" });
    expect(
      parseProviderSessionLocalArgs([
        "verify-cleanup",
        "--visit-id",
        scope.visitId!,
        "--media-session-id",
        scope.mediaSessionId!,
        "--media-attempted",
        "--recover-media",
      ]),
    ).toEqual({ mode: "verify-cleanup", scope, recoverMedia: true });
  });
  it.each([
    { args: ["setup", "--reset"] },
    { args: ["verify-cleanup", "--token", "fictional-token"] },
    { args: ["verify-cleanup", "--media-attempted"] },
    { args: ["verify-cleanup", "--visit-id", "bad"] },
    { args: ["verify-cleanup", "--recover-media", "--recover-media"] },
  ])("rejects unknown, unsafe or incomplete arguments $args", ({ args }) => {
    expect(() => parseProviderSessionLocalArgs(args)).toThrow();
  });
});
