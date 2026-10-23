import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  createProviderMediaCheckpointStore,
  providerMediaCheckpointContext,
  resolveCheckpointMediaScope,
  validateProviderMediaCheckpoint,
  type ProviderMediaCheckpoint,
  type ProviderMediaCheckpointIo,
} from "../../packages/integrations/src/provider-media-checkpoint";
import { buildProviderSessionBaseEnvironment } from "../../scripts/provider-session-config";
import { buildRemoteSessionBaseEnvironment } from "../../scripts/provider-session-remote-config";

const runId = "11111111-1111-4111-8111-111111111111";
const visitId = "22222222-2222-4222-8222-222222222222";
const mediaSessionId = "33333333-3333-4333-8333-333333333333";
const otherId = "44444444-4444-4444-8444-444444444444";
const repositoryRoot = "/fictional/CaptionDoor";
const initial: ProviderMediaCheckpoint = {
  runId,
  visitId,
  householdId: "h1",
  phase: "BEFORE_MEDIA_ALLOCATION",
};
const bound: ProviderMediaCheckpoint = {
  ...initial,
  phase: "MEDIA_BOUND",
  mediaSessionId,
};
const scope = { householdId: "h1" as const, visitId, mediaAttempted: true };
function env() {
  return {
    ...buildProviderSessionBaseEnvironment({
      inheritedEnv: {},
      cleanupApproved: true,
    }),
    CAPTIONDOOR_PROVIDER_SESSION_ID: runId,
    CAPTIONDOOR_PROVIDER_CHECKPOINT_PROTOCOL: "v1",
    CAPTIONDOOR_PROVIDER_EVIDENCE_ROOT: repositoryRoot,
  };
}
function fixture() {
  const values = new Map<string, unknown>();
  const events: string[] = [];
  const io: ProviderMediaCheckpointIo = {
    canonicalRoot: async (path) => path,
    async readJson(path) {
      events.push(`read:${path}`);
      return values.get(path);
    },
    async createJson(path, value) {
      events.push(`create:${path}`);
      if (values.has(path))
        throw Object.assign(new Error("fictional"), { code: "EEXIST" });
      values.set(path, structuredClone(value));
    },
    async replaceJson(path, value) {
      events.push(`replace:${path}`);
      values.set(path, structuredClone(value));
    },
  };
  const scopePath = resolve(
    repositoryRoot,
    "output/provider-smoke",
    runId,
    "scope.json",
  );
  const checkpointPath = resolve(
    repositoryRoot,
    "output/provider-smoke",
    runId,
    "media-attempt.json",
  );
  values.set(scopePath, scope);
  return {
    values,
    events,
    io,
    scopePath,
    checkpointPath,
    store: createProviderMediaCheckpointStore(io),
  };
}

describe("credential-free provider media checkpoints", () => {
  it.each([initial, bound])(
    "validates only exact own-run evidence %j",
    (value) => {
      expect(validateProviderMediaCheckpoint(value, runId, visitId)).toEqual(
        value,
      );
    },
  );
  it.each([
    null,
    [],
    {},
    { ...initial, runId: otherId },
    { ...initial, visitId: otherId },
    { ...initial, householdId: "h2" },
    { ...initial, phase: "PROVIDER_CREATED" },
    { ...initial, accessToken: "fictional-secret-never-save" },
    { ...initial, mediaSessionId },
    { ...bound, mediaSessionId: "bad" },
    { ...bound, caption: "fictional text" },
  ])("rejects malformed, foreign and content-bearing evidence %j", (value) => {
    expect(() =>
      validateProviderMediaCheckpoint(value, runId, visitId),
    ).toThrow("checkpoint");
  });
  it("rejects path traversal before file resolution", async () => {
    const f = fixture();
    await expect(
      f.store.read("../other", visitId, repositoryRoot),
    ).rejects.toThrow("checkpoint");
    expect(f.events).toHaveLength(0);
  });
  it("leaves ordinary media unchanged but refuses partial coordinator markers", async () => {
    expect(providerMediaCheckpointContext(visitId, {})).toBeUndefined();
    const f = fixture();
    expect(await f.store.begin(visitId, {})).toBeUndefined();
    expect(f.events).toHaveLength(0);
    for (const override of [
      { CAPTIONDOOR_PROVIDER_CHECKPOINT_PROTOCOL: undefined },
      { CAPTIONDOOR_PROVIDER_SESSION_ID: undefined },
      { CAPTIONDOOR_PROVIDER_SESSION_ID: "bad" },
      { CAPTIONDOOR_PROVIDER_CHECKPOINT_PROTOCOL: "v2" },
      { CAPTIONDOOR_PROVIDER_EVIDENCE_ROOT: undefined },
      { CAPTIONDOOR_PROVIDER_EVIDENCE_ROOT: "relative" },
      { CAPTIONDOOR_PROVIDER_EVIDENCE_ROOT: "/fictional/../foreign" },
      { CAPTIONDOOR_ENV: "remote-demo" },
    ])
      expect(() =>
        providerMediaCheckpointContext(visitId, { ...env(), ...override }),
      ).toThrow("checkpoint");
  });
  it("accepts only exact Local/root or remote provider scope and canonical evidence roots", async () => {
    expect(providerMediaCheckpointContext(visitId, env())).toEqual({
      runId,
      repositoryRoot,
    });
    const remote = {
      ...buildRemoteSessionBaseEnvironment(
        { NODE_ENV: "development" },
        "fictional-nonroot",
        {
          previousSeconds: 30,
          previousMicrousd: 12000,
          baselineSha256: "a".repeat(64),
        },
      ),
      CAPTIONDOOR_PROVIDER_SESSION_ID: runId,
      CAPTIONDOOR_PROVIDER_CHECKPOINT_PROTOCOL: "v1",
      CAPTIONDOOR_PROVIDER_EVIDENCE_ROOT: repositoryRoot,
    };
    expect(providerMediaCheckpointContext(visitId, remote)).toEqual({
      runId,
      repositoryRoot,
    });
    const f = fixture();
    f.io.canonicalRoot = async () => "/foreign/symlink-target";
    await expect(f.store.begin(visitId, env())).rejects.toThrow("checkpoint");
    expect(f.events).toHaveLength(0);
  });
  it("records initial evidence once, binds before provider activity and preserves the bound id", async () => {
    const f = fixture();
    const checkpoint = await f.store.begin(visitId, env());
    expect(checkpoint).toEqual(initial);
    expect(f.values.get(f.checkpointPath)).toEqual(initial);
    await expect(f.store.begin(visitId, env())).rejects.toMatchObject({
      category: "PROVIDER_MEDIA_CHECKPOINT_ALREADY_EXISTS",
    });
    expect(await f.store.bind(checkpoint!, mediaSessionId, env())).toEqual(
      bound,
    );
    expect(await f.store.read(runId, visitId, repositoryRoot)).toEqual(bound);
    await expect(
      f.store.bind(initial, mediaSessionId, env()),
    ).rejects.toMatchObject({
      category: "PROVIDER_MEDIA_CHECKPOINT_ALREADY_EXISTS",
    });
  });
  it.each([
    undefined,
    { ...scope, householdId: "h2" },
    { ...scope, visitId: otherId },
    { ...scope, mediaAttempted: false },
    { ...scope, mediaSessionId },
  ])(
    "refuses a missing or mismatched harness scope before creating evidence %j",
    async (value) => {
      const f = fixture();
      f.values.set(f.scopePath, value);
      await expect(f.store.begin(visitId, env())).rejects.toThrow("checkpoint");
      expect(f.values.has(f.checkpointPath)).toBe(false);
    },
  );
  it("returns undefined only for absent evidence and fails closed on malformed/read/write errors", async () => {
    const f = fixture();
    expect(await f.store.read(runId, visitId, repositoryRoot)).toBeUndefined();
    f.values.set(f.checkpointPath, { ...initial, visitId: otherId });
    await expect(f.store.read(runId, visitId, repositoryRoot)).rejects.toThrow(
      "checkpoint",
    );
    f.io.readJson = async () => {
      throw new Error("fictional read failed");
    };
    await expect(
      f.store.read(runId, visitId, repositoryRoot),
    ).rejects.toThrow();
    const g = fixture();
    g.io.createJson = async () => {
      throw new Error("fictional write failed");
    };
    await expect(g.store.begin(visitId, env())).rejects.toMatchObject({
      category: "PROVIDER_MEDIA_CHECKPOINT_WRITE_FAILED",
    });
    expect(g.values.has(g.checkpointPath)).toBe(false);
  });
  it.each([undefined, initial])(
    "infers no provider creation only after owned intake stopped %j",
    (checkpoint) => {
      expect(resolveCheckpointMediaScope(scope, checkpoint, false)).toEqual({
        providerMediaCreationNotReached: false,
      });
      expect(resolveCheckpointMediaScope(scope, checkpoint, true)).toEqual({
        providerMediaCreationNotReached: true,
      });
    },
  );
  it("always preserves known/bound ids and rejects inconsistent evidence", () => {
    expect(resolveCheckpointMediaScope(scope, bound, false)).toEqual({
      mediaSessionId,
      providerMediaCreationNotReached: false,
    });
    expect(resolveCheckpointMediaScope(scope, bound, true)).toEqual({
      mediaSessionId,
      providerMediaCreationNotReached: false,
    });
    expect(
      resolveCheckpointMediaScope(
        { ...scope, mediaSessionId },
        undefined,
        true,
      ),
    ).toEqual({ mediaSessionId, providerMediaCreationNotReached: false });
    expect(() =>
      resolveCheckpointMediaScope(
        { ...scope, mediaSessionId: otherId },
        bound,
        true,
      ),
    ).toThrow("checkpoint");
    expect(() =>
      resolveCheckpointMediaScope({ ...scope, visitId: otherId }, bound, true),
    ).toThrow("checkpoint");
    expect(
      resolveCheckpointMediaScope(
        { householdId: "h1", mediaAttempted: false },
        undefined,
        true,
      ).providerMediaCreationNotReached,
    ).toBe(false);
  });
});
