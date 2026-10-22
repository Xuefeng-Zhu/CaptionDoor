import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { z } from "zod";
import { service, getItem, tables, visitPK, type Job } from "@captiondoor/db";
import {
  AppError,
  validateModes,
  type Actor,
  type ConversationItem,
  type Visit,
} from "@captiondoor/domain";
import {
  AwsPcmStream,
  type StreamingCaption,
} from "../../../packages/integrations/src/audio/transcribe";
import {
  decodePcmFrame,
  PcmSequence,
} from "../../../packages/integrations/src/audio/protocol";
import { deliverPushJob } from "../../../packages/integrations/src/push";
import { closePersistedMedia } from "../../../packages/integrations/src/media-cleanup";
import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

for (const file of [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
])
  if (existsSync(file)) {
    process.loadEnvFile(file);
    break;
  }
validateModes(process.env);
const port = Number(process.env.WORKER_PORT || 3411);
const host = process.env.WORKER_HOST || "127.0.0.1";
const appOrigin = process.env.APP_ORIGIN || "http://127.0.0.1:3410";
const allowedOrigins = new Set([appOrigin]);
if (["localhost", "127.0.0.1"].includes(new URL(appOrigin).hostname))
  for (const origin of [
    "http://127.0.0.1:3410",
    "http://localhost:3410",
    "https://127.0.0.1:3443",
    "https://localhost:3443",
  ])
    allowedOrigins.add(origin);
const workerId = `worker-${randomUUID()}`;
const command = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    visitId: z.string().max(100).optional(),
  }),
  z.object({ type: z.literal("guest") }),
  z.object({
    type: z.literal("capture"),
    visitId: z.string().max(100),
    leaseId: z.string().max(100),
    mediaSessionId: z.string().max(100),
  }),
  z.object({
    type: z.literal("capture-stop"),
    visitId: z.string().max(100),
    leaseId: z.string().max(100),
  }),
  z.object({ type: z.literal("ping") }),
]);
type Capture = {
  visitId: string;
  leaseId: string;
  mediaSessionId: string;
  actor: Actor;
  sequence: PcmSequence;
  stream: AwsPcmStream;
};
type Connection = {
  ws: WebSocket;
  tokens: { resident?: string; guest?: string };
  kind?: "resident" | "guest";
  visitId?: string;
  capture?: Capture;
  alive: boolean;
  pending: number;
  chain: Promise<void>;
};
const connections = new Set<Connection>();
let stopping = false;
let polling = false;
function cookieTokens(request: IncomingMessage) {
  const cookies: Record<string, string> = {};
  for (const part of (request.headers.cookie || "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    try {
      cookies[part.slice(0, at).trim()] = decodeURIComponent(
        part.slice(at + 1).trim(),
      );
    } catch {}
  }
  return { resident: cookies.cd_session, guest: cookies.cd_guest };
}
async function actorFor(connection: Connection, kind = connection.kind) {
  const token = kind ? connection.tokens[kind] : undefined;
  if (!token)
    throw new AppError("UNAUTHENTICATED", 401, "Sign in again to reconnect.");
  const actor = await service.authenticate(token);
  if (actor.kind !== kind)
    throw new AppError(
      "FORBIDDEN",
      403,
      "Session scope does not match this connection.",
    );
  return actor;
}
function send(connection: Connection, data: unknown) {
  if (connection.ws.readyState !== WebSocket.OPEN) return;
  if (connection.ws.bufferedAmount > 64 * 1024) {
    void stopCapture(connection, "BACKPRESSURE");
    connection.ws.close(
      1013,
      "Connection overloaded. Reconnect to restore current state.",
    );
    return;
  }
  connection.ws.send(JSON.stringify(data));
}
function safeFailure(connection: Connection, error: unknown) {
  const code = error instanceof AppError ? error.code : "CONNECTION_ERROR";
  const message =
    error instanceof AppError
      ? error.message
      : "Connection interrupted. Reconnect to restore current state.";
  send(connection, { type: "error", code, message });
}
async function stopCapture(connection: Connection, reason: string) {
  const capture = connection.capture;
  if (!capture) return;
  connection.capture = undefined;
  capture.stream.stop();
  try {
    await service.releaseCapture(
      capture.actor,
      capture.visitId,
      capture.leaseId,
      reason,
    );
  } catch {
    /* revoked/expired access still stops local capture immediately */
  }
  send(connection, {
    type: "capture-stopped",
    visitId: capture.visitId,
    reason,
  });
}
async function authorizedSubscription(connection: Connection) {
  const actor = await actorFor(connection);
  if (actor.kind === "guest") {
    await service.guestView(actor);
  } else if (connection.visitId) {
    await service.getVisit(actor, connection.visitId);
  } else {
    await service.bootstrap(actor);
  }
  return actor;
}
async function emitCaption(
  householdId: string,
  visitId: string,
  caption: StreamingCaption,
  expiresAt: number,
) {
  const item: ConversationItem = {
    id: `${caption.mediaSessionId}:${caption.resultId}`,
    kind: "caption",
    createdAt: Date.now(),
    expiresAt,
    text: caption.text,
    mediaSessionId: caption.mediaSessionId,
    resultId: caption.resultId,
    isPartial: caption.isPartial,
    startTime: caption.startTime,
    endTime: caption.endTime,
    source: caption.source,
  };
  await Promise.all(
    [...connections].map(async (connection) => {
      if (connection.kind !== "resident" || connection.visitId !== visitId)
        return;
      try {
        const actor = await authorizedSubscription(connection);
        if (actor.householdId === householdId && actor.grants.captions) {
          const current = await getItem(
            tables.visits,
            visitPK(householdId, visitId),
            "STATE",
          );
          const profile = await getItem(
            tables.config,
            `HOUSEHOLD#${householdId}`,
            "PROFILE",
          );
          if (
            current?.mediaSessionId === caption.mediaSessionId &&
            current.mediaStatus === "LIVE" &&
            !current.deleted &&
            current.expiresAt > Date.now() / 1000 &&
            (profile?.settings?.consent?.sharing ||
              current.handlerId === actor.userId)
          )
            send(connection, { type: "caption", caption: item });
        }
      } catch {
        await stopCapture(connection, "ACCESS_REVOKED");
        connection.ws.close(1008, "Access expired or revoked.");
      }
    }),
  );
}
async function handleMessage(
  connection: Connection,
  data: RawData,
  isBinary: boolean,
) {
  if (isBinary) {
    const capture = connection.capture;
    if (!capture)
      throw new AppError("NO_CAPTURE", 403, "Audio capture is not authorized.");
    const actor = await actorFor(connection, "resident");
    const visit = await service.authorizeCapture(actor, capture.visitId, {
      leaseId: capture.leaseId,
      mediaSessionId: capture.mediaSessionId,
    });
    if (
      visit.transcriptSource === "FIXTURE" ||
      (process.env.TRANSCRIBE_MODE || "fixture") !== "aws"
    )
      throw new AppError(
        "AUDIO_MODE",
        409,
        "Real audio requires AWS transcription mode. Demo transcript uses no captured audio.",
      );
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data;
    const frame = decodePcmFrame(bytes);
    capture.sequence.accept(frame);
    if (!capture.stream.push(frame.pcm))
      throw new AppError(
        "AUDIO_OVERLOAD",
        409,
        "Audio buffer overloaded. Buffered audio was discarded.",
      );
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(data.toString());
  } catch {
    throw new AppError("INVALID_MESSAGE", 400, "A JSON command is required.");
  }
  const parsed = command.safeParse(input);
  if (!parsed.success)
    throw new AppError("INVALID_MESSAGE", 400, "Unsupported socket command.");
  const message = parsed.data;
  if (message.type === "ping") {
    await authorizedSubscription(connection);
    send(connection, { type: "pong", at: Date.now() });
    return;
  }
  if (message.type === "guest") {
    const actor = await actorFor(connection, "guest");
    await service.guestView(actor);
    await stopCapture(connection, "SCOPE_CHANGED");
    connection.kind = "guest";
    connection.visitId = undefined;
    send(connection, { type: "subscribed", scope: "guest" });
    return;
  }
  if (message.type === "subscribe") {
    const actor = await actorFor(connection, "resident");
    if (message.visitId) await service.getVisit(actor, message.visitId);
    else await service.bootstrap(actor);
    if (connection.capture && connection.capture.visitId !== message.visitId)
      await stopCapture(connection, "SUBSCRIPTION_CHANGED");
    connection.kind = "resident";
    connection.visitId = message.visitId;
    send(connection, {
      type: "subscribed",
      scope: "resident",
      visitId: message.visitId,
    });
    return;
  }
  if (message.type === "capture-stop") {
    const actor = await actorFor(connection, "resident");
    if (
      connection.capture?.visitId !== message.visitId ||
      connection.capture.leaseId !== message.leaseId ||
      connection.capture.actor.userId !== actor.userId
    )
      throw new AppError(
        "CAPTURE_MISMATCH",
        403,
        "Capture lease does not match.",
      );
    await stopCapture(connection, "RESIDENT_STOPPED");
    return;
  }
  if (message.type === "capture") {
    if ((process.env.TRANSCRIBE_MODE || "fixture") !== "aws")
      throw new AppError(
        "AUDIO_MODE",
        409,
        "Real audio requires AWS mode. Demo transcripts do not capture audio.",
      );
    const actor = await actorFor(connection, "resident");
    if (
      [...connections].some(
        (other) => other.capture?.visitId === message.visitId,
      )
    )
      throw new AppError(
        "CAPTURE_ACTIVE",
        409,
        "Incoming audio already has an active caption connection.",
      );
    const visit = await service.authorizeCapture(actor, message.visitId, {
      leaseId: message.leaseId,
      mediaSessionId: message.mediaSessionId,
    });
    await stopCapture(connection, "REPLACED");
    if (connection.ws.readyState !== WebSocket.OPEN)
      throw new AppError("CONNECTION_ENDED", 409, "Caption connection ended.");
    if (
      [...connections].some(
        (other) => other.capture?.visitId === message.visitId,
      )
    )
      throw new AppError(
        "CAPTURE_ACTIVE",
        409,
        "Incoming audio already has an active caption connection.",
      );
    connection.kind = "resident";
    connection.visitId = message.visitId;
    const stream = new AwsPcmStream(
      message.mediaSessionId,
      async (caption) => {
        const fresh = await actorFor(connection, "resident");
        await service.authorizeCapture(fresh, message.visitId, {
          leaseId: message.leaseId,
          mediaSessionId: message.mediaSessionId,
        });
        const saved = await service.persistCaption(
          fresh,
          message.visitId,
          caption,
          message.leaseId,
        );
        if (caption.isPartial || saved)
          await emitCaption(
            fresh.householdId,
            message.visitId,
            caption,
            visit.expiresAt,
          );
      },
      (category) => {
        send(connection, {
          type: "media-status",
          status: "INTERRUPTED",
          message: "AWS transcription interrupted. Text remains available.",
          category,
        });
        void stopCapture(connection, category);
      },
    );
    connection.capture = {
      ...message,
      actor,
      sequence: new PcmSequence(),
      stream,
    };
    send(connection, {
      type: "capture-ready",
      visitId: message.visitId,
      mediaSessionId: message.mediaSessionId,
    });
    void stream.run();
  }
}
const server = createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/health") {
    try {
      await getItem(tables.config, "HEALTH", "HEALTH");
      response.end(
        JSON.stringify({
          status: "ok",
          worker: "single",
          transport: process.env.SQS_QUEUE_URL
            ? "sqs+due-recovery"
            : "local-due-poller",
          transcribe: process.env.TRANSCRIBE_MODE || "fixture",
        }),
      );
    } catch {
      response.statusCode = 503;
      response.end(
        JSON.stringify({ status: "unavailable", dependency: "dynamodb" }),
      );
    }
  } else {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "Not found" }));
  }
});
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 16 * 1024,
  perMessageDeflate: false,
});
server.on("upgrade", async (request, socket, head) => {
  socket.on("error", () => {});
  try {
    const url = new URL(request.url || "/", appOrigin);
    if (
      url.pathname !== "/ws" ||
      !allowedOrigins.has(request.headers.origin || "")
    )
      throw new AppError("ORIGIN", 403, "Origin denied.");
    const tokens = cookieTokens(request);
    let authenticated = false;
    for (const token of [tokens.resident, tokens.guest]) {
      if (!token) continue;
      try {
        await service.authenticate(token);
        authenticated = true;
        break;
      } catch {}
    }
    if (!authenticated)
      throw new AppError("UNAUTHENTICATED", 401, "Authentication required.");
    if (connections.size >= 200)
      throw new AppError("CAPACITY", 503, "Connection capacity reached.");
    wss.handleUpgrade(request, socket, head, (ws) => {
      const connection: Connection = {
        ws,
        tokens,
        alive: true,
        pending: 0,
        chain: Promise.resolve(),
      };
      connections.add(connection);
      ws.on("pong", () => {
        connection.alive = true;
      });
      ws.on("message", (data, isBinary) => {
        if (++connection.pending > 6) {
          void stopCapture(connection, "INPUT_OVERLOAD");
          ws.close(1013, "Input overloaded.");
          return;
        }
        connection.chain = connection.chain
          .then(() => handleMessage(connection, data, isBinary))
          .catch(async (error) => {
            safeFailure(connection, error);
            await stopCapture(
              connection,
              error instanceof AppError ? error.code : "INVALID_AUDIO",
            );
            if (error instanceof AppError && [401, 403].includes(error.status))
              ws.close(1008, "Access denied.");
          })
          .finally(() => {
            connection.pending--;
          });
      });
      ws.on("error", () => {
        void stopCapture(connection, "SOCKET_ERROR");
      });
      ws.on("close", () => {
        connections.delete(connection);
        void stopCapture(connection, "SOCKET_CLOSED");
      });
      send(connection, { type: "ready", requiresSubscription: true });
    });
  } catch (error) {
    const status = error instanceof AppError ? error.status : 503;
    socket.write(
      `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
  }
});
const heartbeat = setInterval(() => {
  for (const connection of connections) {
    if (!connection.alive) {
      void stopCapture(connection, "HEARTBEAT_LOST");
      connection.ws.terminate();
      continue;
    }
    connection.alive = false;
    connection.ws.ping();
    if (connection.kind)
      void authorizedSubscription(connection)
        .then(async () => {
          if (connection.capture) {
            const actor = await actorFor(connection, "resident");
            await service.authorizeCapture(actor, connection.capture.visitId, {
              leaseId: connection.capture.leaseId,
              mediaSessionId: connection.capture.mediaSessionId,
            });
          }
        })
        .catch(async () => {
          await stopCapture(connection, "ACCESS_REVOKED");
          connection.ws.close(1008, "Access expired or revoked.");
        });
  }
}, 3000);
async function broadcastChanged(job: Job) {
  await Promise.all(
    [...connections].map(async (connection) => {
      if (!connection.kind) return;
      try {
        const actor = await authorizedSubscription(connection);
        if (actor.householdId !== job.householdId) return;
        if (actor.kind === "guest") {
          const view = await service.guestView(actor);
          if (job.threadId === view.thread.id)
            send(connection, { type: "changed", eventId: job.id });
        } else if (!connection.visitId || connection.visitId === job.visitId) {
          send(connection, {
            type: "changed",
            eventId: job.id,
            visitId: job.visitId,
            version: job.version,
          });
        }
      } catch {
        await stopCapture(connection, "ACCESS_REVOKED");
        connection.ws.close(1008, "Access expired or revoked.");
      }
    }),
  );
}
async function runFixture(job: Job) {
  if (
    (process.env.TRANSCRIBE_MODE || "fixture") !== "fixture" ||
    (process.env.RING_MODE || "demo") !== "demo"
  )
    throw new AppError(
      "FIXTURE_DISABLED",
      403,
      "Fixture transcript is disabled in this mode.",
    );
  if (!job.visitId || !job.sessionId || !job.leaseId || !job.mediaSessionId)
    throw new AppError(
      "INVALID_JOB",
      400,
      "Fixture job is missing scoped identifiers.",
    );
  const actor = await service.sessionFromId(String(job.sessionId));
  const visitId = job.visitId;
  const leaseId = String(job.leaseId);
  const mediaSessionId = String(job.mediaSessionId);
  const resultId = `demo-${job.id}`;
  for (const [index, text] of ["Do", "Do not", "Do not leave it."].entries()) {
    const fresh = await service.sessionFromId(actor.sessionId);
    const visit = await service.authorizeCapture(fresh, visitId, {
      leaseId,
      mediaSessionId,
    });
    const caption: StreamingCaption = {
      mediaSessionId,
      resultId,
      text,
      isPartial: index < 2,
      startTime: 0,
      endTime: (index + 1) * 0.4,
      source: "FIXTURE",
    };
    const saved = await service.persistCaption(
      fresh,
      visitId,
      caption,
      leaseId,
    );
    if (caption.isPartial || saved)
      await emitCaption(job.householdId, visitId, caption, visit.expiresAt);
    if (index < 2) await new Promise((resolve) => setTimeout(resolve, 350));
  }
}
async function runJob(job: Job) {
  switch (job.type) {
    case "NOTIFY":
      await broadcastChanged(job);
      if (
        process.env.VAPID_PUBLIC_KEY &&
        process.env.VAPID_PRIVATE_KEY &&
        process.env.VAPID_SUBJECT
      )
        await deliverPushJob(job);
      return;
    case "DELETE_VISIT":
    case "DELETE_THREAD":
      await service.executeDeleteJob(job);
      await broadcastChanged(job);
      return;
    case "PUSH_TEST":
      await deliverPushJob(job);
      return;
    case "DEMO_CAPTIONS":
      await runFixture(job);
      return;
    case "RING_MEDIA_CLOSE":
      if (!job.mediaSessionId)
        throw new AppError(
          "INVALID_JOB",
          400,
          "Media cleanup is missing its opaque identifier.",
        );
      try {
        await closePersistedMedia(job.householdId, job.mediaSessionId);
      } finally {
        if (job.visitId)
          await service.expireMedia(
            job.householdId,
            job.visitId,
            job.mediaSessionId,
          );
      }
      return;
    default:
      throw new AppError("UNKNOWN_JOB", 400, "Unsupported durable job type.");
  }
}
async function processJob(key: { PK: string; SK: string }) {
  const job = await service.claimJob(key, workerId, 15000);
  if (!job) return;
  try {
    await runJob(job);
    await service.completeJob(job, workerId);
  } catch (error) {
    const category =
      error instanceof AppError
        ? error.code
        : error instanceof Error
          ? error.name
          : "JobFailure";
    await service.failJob(job, workerId, category);
    console.warn(
      JSON.stringify({ event: "job-failed", jobId: job.id, category }),
    );
  }
}
async function pollDue() {
  if (polling || stopping) return;
  polling = true;
  try {
    for (const job of await service.dueJobs(20)) {
      if (stopping) break;
      await processJob({ PK: job.PK, SK: job.SK });
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "due-poll-failed",
        category: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  } finally {
    polling = false;
  }
}
const poll = setInterval(() => {
  void pollDue();
}, 500);
void pollDue();
const sqs = process.env.SQS_QUEUE_URL
  ? new SQSClient({ region: process.env.AWS_REGION || "us-east-1" })
  : undefined;
async function pollQueue() {
  if (!sqs || !process.env.SQS_QUEUE_URL) return;
  while (!stopping) {
    try {
      const result = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: process.env.SQS_QUEUE_URL,
          WaitTimeSeconds: 10,
          MaxNumberOfMessages: 5,
          VisibilityTimeout: 30,
        }),
      );
      for (const message of result.Messages || []) {
        try {
          const key = z
            .object({ PK: z.string().regex(/^JOB#/), SK: z.literal("JOB") })
            .parse(JSON.parse(message.Body || ""));
          await processJob(key);
          if (message.ReceiptHandle)
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: process.env.SQS_QUEUE_URL,
                ReceiptHandle: message.ReceiptHandle,
              }),
            );
        } catch (error) {
          console.warn(
            JSON.stringify({
              event: "queue-message-failed",
              category: error instanceof Error ? error.name : "UnknownError",
            }),
          );
        }
      }
    } catch (error) {
      if (!stopping) {
        console.warn(
          JSON.stringify({
            event: "queue-receive-failed",
            category: error instanceof Error ? error.name : "UnknownError",
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
}
void pollQueue();
server.listen(port, host, () => {
  console.log(
    JSON.stringify({
      event: "worker-listening",
      host,
      port,
      transport: sqs ? "sqs+due-recovery" : "local-due-poller",
      warning: "Single worker only; replicas require shared fan-out.",
    }),
  );
});
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(poll);
  clearInterval(heartbeat);
  for (const connection of connections) {
    await stopCapture(connection, "WORKER_SHUTDOWN");
    connection.ws.close(1012, "Worker restarting; reconnect.");
  }
  wss.close();
  server.close();
  sqs?.destroy();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
