import { describe, it, expect } from "vitest";
import {
  assertReplayTarget,
  assertReplayModes,
  assertReplayIdle,
} from "../../scripts/judge-replay";
describe("judge replay cannot silently target a provider or production", () => {
  it("refuses existing active demo work before any helper cleanup or claim", () => {
    expect(() => assertReplayIdle([])).not.toThrow();
    expect(() => assertReplayIdle([{ status: "CLOSED" }])).not.toThrow();
    for (const status of ["UNCLAIMED", "CLAIMED"])
      expect(() => assertReplayIdle([{ status }])).toThrow(
        /No existing visit was changed/,
      );
  });
  it("allows only the dedicated loopback HTTP demo and refuses remote, credentials, redirects and production", () => {
    expect(assertReplayTarget("http://127.0.0.1:3410")).toBe(
      "http://127.0.0.1:3410",
    );
    expect(assertReplayTarget("http://localhost:3410/")).toBe(
      "http://localhost:3410",
    );
    for (const value of [
      "https://example.com",
      "http://127.0.0.1:3000",
      "http://user:password@127.0.0.1:3410",
      "http://127.0.0.1:3410/other",
      "http://127.0.0.1:3410/?token=fake",
    ])
      expect(() => assertReplayTarget(value)).toThrow();
    expect(() =>
      assertReplayTarget("http://127.0.0.1:3410", "production"),
    ).toThrow();
  });
  it("requires actual healthy DynamoDB/local transport and demo fixtures before launching a browser", () => {
    const web = {
      status: "ok",
      database: "DynamoDB",
      authMode: "demo",
      ringMode: "demo",
      transcribeMode: "fixture",
    };
    const worker = {
      status: "ok",
      worker: "single",
      transport: "local-due-poller",
      transcribe: "fixture",
    };
    expect(() => assertReplayModes(web, worker)).not.toThrow();
    for (const change of [
      { ringMode: "playground" },
      { ringMode: "live" },
      { authMode: "oidc" },
      { transcribeMode: "aws" },
      { database: "memory" },
    ])
      expect(() => assertReplayModes({ ...web, ...change }, worker)).toThrow();
    expect(() =>
      assertReplayModes(web, { ...worker, transport: "sqs" }),
    ).toThrow();
    expect(() => assertReplayModes(null, null)).toThrow();
  });
});
