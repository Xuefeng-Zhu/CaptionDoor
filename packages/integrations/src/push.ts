import webpush from "web-push";
import { createHash, randomUUID } from "node:crypto";
import { PutCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { db, tables, getItem } from "@captiondoor/db";
import { AppError, type Actor } from "@captiondoor/domain";
export function pushPublicKey() {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT)
    throw new AppError(
      "PUSH_UNCONFIGURED",
      503,
      "Web Push is not configured. In-app visual alerts remain available while connected.",
    );
  return key;
}
export async function subscribePush(actor: Actor, input: unknown) {
  pushPublicKey();
  if (!input || typeof input !== "object")
    throw new AppError("VALIDATION", 400, "A push subscription is required.");
  const sub = input as webpush.PushSubscription;
  let url: URL;
  try {
    url = new URL(sub.endpoint);
  } catch {
    throw new AppError("VALIDATION", 400, "Invalid push endpoint.");
  }
  const hosts = [
    "push.apple.com",
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "notify.windows.com",
  ];
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !hosts.some((h) => url.hostname === h || url.hostname.endsWith("." + h))
  )
    throw new AppError(
      "VALIDATION",
      400,
      "This push provider is not supported.",
    );
  if (!sub.keys?.auth || !sub.keys?.p256dh || JSON.stringify(sub).length > 4096)
    throw new AppError("VALIDATION", 400, "Invalid push keys.");
  const id = createHash("sha256").update(sub.endpoint).digest("hex");
  await db.send(
    new PutCommand({
      TableName: tables.runtime,
      Item: {
        PK: `USER#${actor.householdId}#${actor.userId}`,
        SK: `PUSH#${id}`,
        subscription: sub,
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    }),
  );
  return { subscribed: true };
}
export async function enqueuePushTest(actor: Actor) {
  pushPublicKey();
  const id = randomUUID(),
    now = Date.now();
  await db.send(
    new PutCommand({
      TableName: tables.runtime,
      Item: {
        PK: `JOB#${id}`,
        SK: "JOB",
        id,
        type: "PUSH_TEST",
        householdId: actor.householdId,
        userId: actor.userId,
        status: "READY",
        attempts: 0,
        nextAttemptAt: now,
        duePk: "WORK#0",
        dueSk: `${String(now).padStart(16, "0")}#${id}`,
        createdAt: now,
        expiresAt: Math.floor(now / 1000) + 86400,
      },
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  return { status: "QUEUED", jobId: id };
}
export async function deliverPushJob(job: {
  householdId: string;
  userId?: string;
  visitId?: string;
  type: string;
}) {
  pushPublicKey();
  const directMember = job.userId
    ? await getItem(
        tables.config,
        `HOUSEHOLD#${job.householdId}`,
        `MEMBER#${job.userId}`,
      )
    : undefined;
  const members = job.userId
    ? directMember
      ? [directMember]
      : []
    : (
        await db.send(
          new QueryCommand({
            TableName: tables.config,
            KeyConditionExpression: "PK=:pk AND begins_with(SK,:sk)",
            ExpressionAttributeValues: {
              ":pk": `HOUSEHOLD#${job.householdId}`,
              ":sk": "MEMBER#",
            },
            ConsistentRead: true,
          }),
        )
      ).Items || [];
  let accepted = 0;
  for (const member of members) {
    if (
      member.revoked ||
      (member.expiresAt && member.expiresAt <= Date.now() / 1000)
    )
      continue;
    const pk = `USER#${job.householdId}#${member.userId}`;
    const subs =
      (
        await db.send(
          new QueryCommand({
            TableName: tables.runtime,
            KeyConditionExpression: "PK=:pk AND begins_with(SK,:sk)",
            ExpressionAttributeValues: { ":pk": pk, ":sk": "PUSH#" },
            ConsistentRead: true,
          }),
        )
      ).Items || [];
    for (const item of subs) {
      if (item.expiresAt <= Date.now() / 1000) continue;
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT!,
        process.env.VAPID_PUBLIC_KEY!,
        process.env.VAPID_PRIVATE_KEY!,
      );
      try {
        await webpush.sendNotification(
          item.subscription,
          JSON.stringify({
            title: "CaptionDoor",
            body:
              job.type === "PUSH_TEST"
                ? "Your visual notification test."
                : "A doorstep session needs your attention.",
            tag: job.visitId ? `visit-${job.visitId}` : "captiondoor-test",
            url: job.visitId
              ? `/visits/${encodeURIComponent(job.visitId)}`
              : "/home",
          }),
          { TTL: 60, urgency: "high" },
        );
        accepted++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.send(
            new DeleteCommand({
              TableName: tables.runtime,
              Key: { PK: pk, SK: item.SK },
            }),
          );
        } else
          throw new AppError(
            "PUSH_PROVIDER",
            503,
            "The notification provider did not accept this notification.",
          );
      }
    }
  }
  return { providerAccepted: accepted };
}
