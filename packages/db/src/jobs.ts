import { AppError } from "@captiondoor/domain";
import {
  type Job,
  type Key,
  type Row,
  tables,
  db,
  getItem,
  queryPK,
  queryIndex,
  putItem,
  deleteItem,
  put,
  transact,
  conditionConflict,
  seconds,
  now,
  pad,
  visitPK,
  threadPK,
  householdPK,
  UpdateCommand,
} from "./repository";
export async function dueJobs(limit = 20): Promise<Job[]> {
  const rows = await queryIndex(tables.runtime, "due-work", "duePk", "WORK#0", {
    limit: Math.min(Math.max(limit, 1), 100),
    forward: true,
    upper: `${pad(now())}#\uffff`,
  });
  const fresh = await Promise.all(
    rows.map((r) => getItem(tables.runtime, r.PK, r.SK)),
  );
  return fresh.filter(
    (r): r is Job =>
      !!r &&
      r.nextAttemptAt <= now() &&
      (r.status === "READY" ||
        (r.status === "LEASED" && r.leaseUntil <= now())),
  );
}
export async function claimJob(
  jobKey: Key,
  workerId: string,
  leaseMs = 15000,
): Promise<Job | null> {
  const before = await getItem(tables.runtime, jobKey.PK, jobKey.SK);
  if (
    before &&
    before.attempts >= 5 &&
    (before.status === "READY" ||
      (before.status === "LEASED" && before.leaseUntil <= now()))
  ) {
    try {
      await db.send(
        new UpdateCommand({
          TableName: tables.runtime,
          Key: { PK: jobKey.PK, SK: jobKey.SK },
          UpdateExpression:
            "SET #status = :dead, category = :category, failedAt = :now REMOVE duePk, dueSk, leaseOwner, leaseUntil",
          ConditionExpression:
            "attempts >= :max AND (#status = :ready OR (#status = :leased AND leaseUntil <= :now))",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":dead": "DEAD",
            ":category": "MAX_ATTEMPTS",
            ":now": now(),
            ":max": 5,
            ":ready": "READY",
            ":leased": "LEASED",
          },
        }),
      );
    } catch (error) {
      if (!conditionConflict(error)) throw error;
    }
    return null;
  }
  try {
    const result = await db.send(
      new UpdateCommand({
        TableName: tables.runtime,
        Key: { PK: jobKey.PK, SK: jobKey.SK },
        UpdateExpression:
          "SET #status = :leased, leaseOwner = :worker, leaseUntil = :until ADD attempts :one",
        ConditionExpression:
          "nextAttemptAt <= :now AND attempts < :max AND (#status = :ready OR (#status = :leased AND leaseUntil <= :now))",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":leased": "LEASED",
          ":ready": "READY",
          ":worker": workerId,
          ":until": now() + Math.min(leaseMs, 60000),
          ":one": 1,
          ":now": now(),
          ":max": 5,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return result.Attributes as Job;
  } catch (error) {
    if (conditionConflict(error)) return null;
    throw error;
  }
}
export async function completeJob(job: Job, workerId: string) {
  await db.send(
    new UpdateCommand({
      TableName: tables.runtime,
      Key: { PK: job.PK, SK: job.SK },
      UpdateExpression:
        "SET #status = :done, completedAt = :now REMOVE duePk, dueSk, leaseOwner, leaseUntil",
      ConditionExpression:
        "#status = :leased AND leaseOwner = :worker AND leaseUntil > :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":done": "DONE",
        ":leased": "LEASED",
        ":worker": workerId,
        ":now": now(),
      },
    }),
  );
}
export async function failJob(job: Job, workerId: string, category: string) {
  const current = await getItem(tables.runtime, job.PK, job.SK);
  if (
    !current ||
    current.status !== "LEASED" ||
    current.leaseOwner !== workerId
  )
    return;
  const dead = current.attempts >= 5;
  const next = now() + Math.min(60000, 1000 * 2 ** current.attempts);
  const safeCategory = /^[A-Z_]{1,60}$/.test(category) ? category : "JOB_ERROR";
  const update = dead
    ? "SET #status = :status, category = :category, failedAt = :now REMOVE duePk, dueSk, leaseOwner, leaseUntil"
    : "SET #status = :status, category = :category, nextAttemptAt = :next, dueSk = :due REMOVE leaseOwner, leaseUntil";
  await db.send(
    new UpdateCommand({
      TableName: tables.runtime,
      Key: { PK: job.PK, SK: job.SK },
      UpdateExpression: update,
      ConditionExpression: "leaseOwner = :worker AND #status = :leased",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": dead ? "DEAD" : "READY",
        ":category": safeCategory,
        ":worker": workerId,
        ":leased": "LEASED",
        ...(dead
          ? { ":now": now() }
          : { ":next": next, ":due": `${pad(next)}#${job.id}` }),
      },
    }),
  );
}
async function deletePartition(table: string, PK: string) {
  let cursor: Key | undefined;
  do {
    const page = await queryPK(table, PK, { limit: 50, cursor });
    for (const row of page.items)
      await deleteItem(table, { PK: row.PK, SK: row.SK });
    cursor = page.cursor;
  } while (cursor);
}
async function removeThread(
  householdId: string,
  threadId: string,
  sessionId?: string,
) {
  const pk = threadPK(householdId, threadId);
  const thread = await getItem(tables.visits, pk, "STATE");
  await deletePartition(tables.visits, pk);
  await deletePartition(tables.runtime, pk);
  const hashedSession = sessionId || thread?.sessionId;
  if (hashedSession)
    await deleteItem(tables.runtime, {
      PK: `SESSION#${hashedSession}`,
      SK: "SESSION",
    });
}
export async function executeDeleteJob(job: Job) {
  if (job.type === "DELETE_THREAD" && job.threadId) {
    await removeThread(job.householdId, job.threadId, job.sessionId);
    return;
  }
  if (job.type !== "DELETE_VISIT" || !job.visitId)
    throw new AppError("UNKNOWN_JOB", 400, "Unsupported deletion job.");
  const pk = visitPK(job.householdId, job.visitId);
  let cursor: Key | undefined;
  do {
    const page = await queryPK(tables.visits, pk, {
      prefix: "THREAD#",
      limit: 50,
      cursor,
    });
    for (const ref of page.items)
      await removeThread(job.householdId, ref.threadId);
    cursor = page.cursor;
  } while (cursor);
  const state = await getItem(tables.visits, pk, "STATE");
  if (state) {
    const door = await getItem(
      tables.config,
      householdPK(job.householdId),
      `DOOR#${state.doorId}`,
    );
    if (door?.activeVisitId === job.visitId) {
      try {
        await db.send(
          new UpdateCommand({
            TableName: tables.config,
            Key: { PK: door.PK, SK: door.SK },
            UpdateExpression: "REMOVE activeVisitId",
            ConditionExpression: "activeVisitId = :id",
            ExpressionAttributeValues: { ":id": job.visitId },
          }),
        );
      } catch (error) {
        if (!conditionConflict(error)) throw error;
      }
    }
  }
  await deletePartition(tables.visits, pk);
  await deletePartition(tables.runtime, pk);
}
export const jobService = {
  dueJobs,
  claimJob,
  completeJob,
  failJob,
  executeDeleteJob,
};
