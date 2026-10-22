import { assertReplayIdle } from "../../scripts/judge-replay";
import {
  expect,
  type Browser,
  type BrowserContext,
  type APIRequestContext,
} from "@playwright/test";
import type {
  Bootstrap,
  GuestView,
  Visit,
  VisitView,
} from "@captiondoor/domain";
export const origin = process.env.E2E_BASE_URL || "http://127.0.0.1:3410";
// Playwright transport errors include request cookies. Preserve the failure category,
// but never let a local session bearer enter stdout, reports or error contexts.
function protectRequestErrors(context: BrowserContext) {
  const request = context.request as unknown as Record<
    string,
    (...args: any[]) => Promise<any>
  >;
  for (const method of [
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "head",
    "fetch",
  ]) {
    const original = request[method].bind(context.request);
    request[method] = async (...args: any[]) => {
      try {
        return await original(...args);
      } catch (error) {
        const text = error instanceof Error ? error.message : "";
        const category =
          text.match(
            /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH)\b/,
          )?.[1] || (/timeout/i.test(text) ? "TIMEOUT" : "TRANSPORT_ERROR");
        throw new Error(
          `CaptionDoor ${method.toUpperCase()} failed: ${category}. Request credentials redacted.`,
        );
      }
    };
  }
}

export type Resident = {
  context: BrowserContext;
  csrf: string;
  userId: string;
};
export async function resident(
  browser: Browser,
  identity: "alex" | "sam" | "jordan",
): Promise<Resident> {
  const context = await browser.newContext({ baseURL: origin });
  protectRequestErrors(context);
  const response = await context.request.post("/api/auth/demo", {
    data: { identity },
    headers: { Origin: origin },
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();
  const me = await context.request.get("/api/me");
  expect(me.ok()).toBeTruthy();
  const data = (await me.json()) as Bootstrap;
  return { context, csrf: body.csrf || data.csrf, userId: data.user.id };
}
export function mutationHeaders(csrf: string, key = crypto.randomUUID()) {
  return { Origin: origin, "X-CSRF-Token": csrf, "Idempotency-Key": key };
}
export async function mutate(
  request: APIRequestContext,
  path: string,
  body: unknown,
  csrf: string,
  key?: string,
) {
  return request.post(path, {
    data: body,
    headers: mutationHeaders(csrf, key),
  });
}
export async function bootstrap(who: Resident) {
  const response = await who.context.request.get("/api/me");
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<Bootstrap>;
}
export async function view(who: Resident, id: string) {
  const response = await who.context.request.get(`/api/visits/${id}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<VisitView>;
}
export async function command(
  who: Resident,
  id: string,
  body: unknown,
  key?: string,
) {
  return mutate(
    who.context.request,
    `/api/visits/${id}/commands`,
    body,
    who.csrf,
    key,
  );
}
export async function consent(who: Resident) {
  const d = await bootstrap(who);
  const result = await mutate(
    who.context.request,
    "/api/settings",
    {
      ...d.settings,
      consent: { ring: true, transcription: true, sharing: true },
    },
    who.csrf,
  );
  expect(result.ok(), await result.text()).toBeTruthy();
}
export async function freshVisit(who: Resident): Promise<Visit> {
  const d = await bootstrap(who);
  const active = d.visits.filter((v) => v.status !== "CLOSED");
  if (process.env.CAPTIONDOOR_JUDGE_REPLAY === "1") assertReplayIdle(d.visits);
  for (const v of active) {
    let current = (await view(who, v.id)).visit;
    if (current.status === "UNCLAIMED") {
      const c = await command(who, v.id, {
        type: "claim",
        expectedVersion: current.version,
      });
      expect(c.ok(), await c.text()).toBeTruthy();
      current = (await c.json()).visit;
    } else if (current.handlerId !== who.userId) {
      const c = await command(who, v.id, {
        type: "takeover",
        expectedVersion: current.version,
      });
      expect(c.ok(), await c.text()).toBeTruthy();
      current = (await c.json()).visit;
    }
    const close = await command(who, v.id, {
      type: "close",
      expectedVersion: current.version,
      outcome: "NO_RESPONSE_RECORDED",
    });
    expect(close.ok(), await close.text()).toBeTruthy();
  }
  const p = await mutate(
    who.context.request,
    "/api/demo/press",
    { scenario: "doorbell" },
    who.csrf,
  );
  expect(p.ok(), await p.text()).toBeTruthy();
  return (await p.json()).visit;
}
export async function guest(browser: Browser) {
  const context = await browser.newContext({ baseURL: origin });
  protectRequestErrors(context);
  const response = await context.request.post("/api/guest/sessions", {
    data: { publicDoorId: "front-demo" },
    headers: { Origin: origin },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const data = (await response.json()) as GuestView;
  return { context, csrf: data.csrf, threadId: data.thread.id };
}
