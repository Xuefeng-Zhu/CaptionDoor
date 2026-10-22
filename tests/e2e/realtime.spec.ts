import { test, expect, type BrowserContext } from "@playwright/test";
import { WebSocket } from "ws";
import { createHash } from "node:crypto";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { db, tables } from "../../packages/db/src/repository";
import {
  resident,
  guest,
  origin,
  consent,
  freshVisit,
  command,
  mutate,
  view,
} from "./helpers";
const wsUrl = process.env.E2E_WS_URL || "ws://127.0.0.1:3411/ws";
async function cookieHeader(context: BrowserContext) {
  return (await context.cookies(origin))
    .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
    .join("; ");
}
async function connect(context: BrowserContext) {
  const socket = new WebSocket(wsUrl, {
    headers: { Origin: origin, Cookie: await cookieHeader(context) },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}
function waitMessage(
  socket: WebSocket,
  predicate: (value: Record<string, any>) => boolean,
) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Expected scoped socket response did not arrive."));
    }, 10_000);
    const onMessage = (raw: Buffer) => {
      const value = JSON.parse(raw.toString());
      if (predicate(value)) {
        cleanup();
        resolve(value);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Socket closed before expected response."));
    };
    function cleanup() {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    }
    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}
test.describe.configure({ mode: "serial" });
test("socket upgrade Origin and tenant subscription are enforced; guests cannot subscribe to captions", async ({
  browser,
}) => {
  const alex = await resident(browser, "alex"),
    jordan = await resident(browser, "jordan"),
    visitor = await guest(browser);
  let cross: WebSocket | undefined, guestSocket: WebSocket | undefined;
  try {
    await consent(alex);
    const visit = await freshVisit(alex);
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, {
        headers: { Origin: "https://unrelated.invalid", Cookie: "" },
      });
      socket.on("unexpected-response", (_request, response) => {
        resolve(response.statusCode || 0);
        response.resume();
        socket.terminate();
      });
      socket.on("open", () => {
        socket.close();
        reject(new Error("Unrelated Origin was accepted"));
      });
      socket.on("error", () => {});
    });
    expect(status).toBe(403);
    cross = await connect(jordan.context);
    const denied = waitMessage(cross, (v) => v.type === "error");
    cross.send(JSON.stringify({ type: "subscribe", visitId: visit.id }));
    const crossError = await denied;
    expect(["FORBIDDEN", "NOT_FOUND"]).toContain(crossError.code);
    guestSocket = await connect(visitor.context);
    const noResident = waitMessage(guestSocket, (v) => v.type === "error");
    guestSocket.send(JSON.stringify({ type: "subscribe", visitId: visit.id }));
    const guestError = await noResident;
    expect(["UNAUTHENTICATED", "FORBIDDEN"]).toContain(guestError.code);
  } finally {
    cross?.terminate();
    guestSocket?.terminate();
    await Promise.all([
      alex.context.close(),
      jordan.context.close(),
      visitor.context.close(),
    ]);
  }
});
test("expiry revokes an already-open authenticated socket before TTL removes its item", async ({
  browser,
}) => {
  const alex = await resident(browser, "alex");
  let socket: WebSocket | undefined;
  try {
    socket = await connect(alex.context);
    const subscribed = waitMessage(socket, (v) => v.type === "subscribed");
    socket.send(JSON.stringify({ type: "subscribe" }));
    expect((await subscribed).scope).toBe("resident");
    const cookie = (await alex.context.cookies(origin)).find(
      (c) => c.name === "cd_session",
    );
    expect(cookie).toBeTruthy();
    const hash = createHash("sha256").update(cookie!.value).digest("hex");
    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Expired session socket stayed open.")),
        10_000,
      );
      socket!.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    await db.send(
      new UpdateCommand({
        TableName: tables.runtime,
        Key: { PK: `SESSION#${hash}`, SK: "SESSION" },
        UpdateExpression: "SET expiresAt = :expired",
        ExpressionAttributeValues: {
          ":expired": Math.floor(Date.now() / 1000) - 1,
        },
      }),
    );
    socket.send(JSON.stringify({ type: "ping" }));
    expect(await closed).toBe(1008);
    const response = await alex.context.request.get("/api/me");
    expect([401, 403]).toContain(response.status());
  } finally {
    socket?.terminate();
    await alex.context.close();
  }
});

test("binary audio is refused without an authorized capture lease", async ({
  browser,
}) => {
  const alex = await resident(browser, "alex");
  let socket: WebSocket | undefined;
  try {
    const visit = await freshVisit(alex);
    socket = await connect(alex.context);
    const subscribed = waitMessage(socket, (v) => v.type === "subscribed");
    socket.send(JSON.stringify({ type: "subscribe", visitId: visit.id }));
    await subscribed;
    const denied = waitMessage(socket, (v) => v.type === "error");
    socket.send(Buffer.alloc(3200));
    expect((await denied).code).toBe("NO_CAPTURE");
    expect((await view(alex, visit.id)).visit.status).toBe("UNCLAIMED");
  } finally {
    socket?.terminate();
    await alex.context.close();
  }
});
test("durable fixture job sends partial revisions for one result and persists one explicit final", async ({
  browser,
}) => {
  const alex = await resident(browser, "alex");
  let socket: WebSocket | undefined;
  try {
    await consent(alex);
    const visit = await freshVisit(alex);
    const claimed = await command(alex, visit.id, {
      type: "claim",
      expectedVersion: visit.version,
    });
    expect(claimed.ok(), await claimed.text()).toBeTruthy();
    socket = await connect(alex.context);
    const subscribed = waitMessage(socket, (v) => v.type === "subscribed");
    socket.send(JSON.stringify({ type: "subscribe", visitId: visit.id }));
    await subscribed;
    const received: Array<Record<string, any>> = [];
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "caption") received.push(msg.caption);
    });
    const final = waitMessage(
      socket,
      (v) => v.type === "caption" && v.caption?.isPartial === false,
    );
    const started = await mutate(
      alex.context.request,
      "/api/demo/captions",
      { visitId: visit.id, consent: true },
      alex.csrf,
    );
    expect(started.ok(), await started.text()).toBeTruthy();
    const complete = (await final).caption;
    expect(complete.text).toBe("Do not leave it.");
    expect(complete.source).toBe("FIXTURE");
    expect(received.map((c) => c.text)).toEqual([
      "Do",
      "Do not",
      "Do not leave it.",
    ]);
    expect(
      new Set(received.map((c) => `${c.mediaSessionId}:${c.resultId}`)).size,
    ).toBe(1);
    const finals = (await view(alex, visit.id)).items.filter(
      (i) => i.kind === "caption",
    );
    expect(finals).toHaveLength(1);
    expect(finals[0].isPartial).toBe(false);
    expect(finals[0].source).toBe("FIXTURE");
  } finally {
    socket?.terminate();
    await alex.context.close();
  }
});
