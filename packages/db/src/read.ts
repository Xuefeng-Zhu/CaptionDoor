import {
  AppError,
  presets,
  type Actor,
  type Visit,
  type Thread,
  type ConversationItem,
  type Bootstrap,
  type VisitView,
  type GuestView,
  type Settings,
} from "@captiondoor/domain";
import {
  commandSchema,
  guestMessageSchema,
  settingsSchema,
  type VisitCommand,
  type SettingsInput,
} from "@captiondoor/contracts";
import {
  type Row,
  type Key,
  type Job,
  tables,
  db,
  getItem,
  queryPK,
  queryIndex,
  putItem,
  deleteItem,
  put,
  del,
  transact,
  conditionConflict,
  seconds,
  now,
  id,
  pad,
  visitPK,
  threadPK,
  householdPK,
  hashToken,
  makeJob,
  jobPut,
  UpdateCommand,
} from "./repository";
import {
  authenticate,
  sessionFromId,
  createResidentSession,
  demoLogin,
  createGuest,
  refresh,
  resident,
  member,
  authConditions,
  revokeSession,
  rateLimit,
  secret,
  threadVisitAccessible,
} from "./auth";
import {
  ttl,
  wsUrl,
  clean,
  rows,
  profile,
  rawVisit,
  viewVisit,
  assertHandler,
  audit,
  stateRow,
} from "./common";
export async function bootstrap(actor: Actor): Promise<Bootstrap> {
  actor = await resident(actor);
  const [p, config, list, threads] = await Promise.all([
    profile(actor.householdId),
    rows(tables.config, householdPK(actor.householdId)),
    queryIndex(
      tables.visits,
      "household-time",
      "gsi1pk",
      `HOUSEHOLD#${actor.householdId}#VISITS`,
      { limit: 20 },
    ),
    queryIndex(
      tables.visits,
      "household-time",
      "gsi1pk",
      `HOUSEHOLD#${actor.householdId}#THREADS`,
      { limit: 30 },
    ),
  ]);
  const visits = (
    await Promise.all(list.map((r) => getItem(tables.visits, r.PK, "STATE")))
  ).filter(
    (r): r is Row =>
      !!r &&
      r.householdId === actor.householdId &&
      typeof r.id === "string" &&
      r.PK === visitPK(actor.householdId, r.id) &&
      r.SK === "STATE" &&
      r.expiresAt > seconds() &&
      !r.deleted,
  );
  const freshThreads = (
    await Promise.all(threads.map((r) => getItem(tables.visits, r.PK, "STATE")))
  ).filter(
    (r): r is Row =>
      !!r &&
      r.householdId === actor.householdId &&
      typeof r.id === "string" &&
      r.PK === threadPK(actor.householdId, r.id) &&
      r.SK === "STATE" &&
      r.expiresAt > seconds() &&
      !r.deleted,
  );
  const parentAccess = await Promise.all(
    freshThreads.map((thread) =>
      threadVisitAccessible(actor.householdId, thread),
    ),
  );
  const visibleThreads = freshThreads.filter((_, index) => parentAccess[index]);
  const members = config
    .filter(
      (r) =>
        r.SK.startsWith("MEMBER#") && !r.revoked && r.expiresAt > seconds(),
    )
    .map((r) => clean<any>(r));
  const m = members.find((r) => r.userId === actor.userId);
  return {
    user: { id: actor.userId, name: m?.name || "Resident" },
    household: { id: actor.householdId, name: p.name },
    doors: config
      .filter((r) => r.SK.startsWith("DOOR#"))
      .map((r) => clean<any>(r)),
    members,
    visits: visits.map((r) =>
      viewVisit(
        r,
        actor,
        p.settings.consent.sharing || r.handlerId === actor.userId,
      ),
    ),
    threads: actor.grants.visitorText
      ? visibleThreads.map((r) => {
          const thread = clean<Thread>(r);
          const linked = visits.find((v) =>
            r.visitId
              ? v.id === r.visitId
              : v.doorId === r.doorId && v.status === "CLAIMED",
          );
          if (
            !p.settings.consent.sharing &&
            linked?.handlerId !== actor.userId
          ) {
            delete thread.lastMessage;
            delete thread.category;
          }
          return thread;
        })
      : [],
    settings: p.settings,
    mode: {
      ring: process.env.RING_MODE || "demo",
      transcribe: process.env.TRANSCRIBE_MODE || "fixture",
      auth: process.env.AUTH_MODE || "demo",
    },
    csrf: actor.csrf,
    wsUrl: wsUrl(),
  };
}

export async function getVisit(
  actor: Actor,
  visitId: string,
  cursor?: string,
): Promise<VisitView> {
  actor = await resident(actor);
  const raw = await rawVisit(actor.householdId, visitId);
  const config = await profile(actor.householdId);
  const content =
    config.settings.consent.sharing || raw.handlerId === actor.userId;
  const pk = visitPK(actor.householdId, visitId);
  const refs = await rows(tables.visits, pk, "THREAD#");
  const threadRows = (
    await Promise.all(
      refs.map((ref) =>
        getItem(
          tables.visits,
          threadPK(actor.householdId, ref.threadId),
          "STATE",
        ),
      ),
    )
  ).filter(
    (r): r is Row =>
      !!r && r.visitId === visitId && r.expiresAt > seconds() && !r.deleted,
  );
  let parts: Record<string, string | null> = {};
  if (cursor) {
    try {
      if (cursor.length > 8192) throw Error();
      parts = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (!parts || typeof parts !== "object") throw Error();
    } catch {
      throw new AppError("VALIDATION", 400, "Invalid conversation cursor.");
    }
  }
  const sources = [
    { key: "visit", PK: pk, prefix: "TIMELINE#" },
    ...(actor.grants.visitorText && content
      ? threadRows.map((t) => ({ key: t.id, PK: t.PK, prefix: "MESSAGE#" }))
      : []),
  ];
  const next: Record<string, string | null> = {};
  const collected: ConversationItem[] = [];
  for (const source of sources) {
    if (parts[source.key] === null) {
      next[source.key] = null;
      continue;
    }
    const sk = parts[source.key];
    if (sk !== undefined && typeof sk !== "string")
      throw new AppError("VALIDATION", 400, "Invalid conversation cursor.");
    const page = await queryPK(tables.visits, source.PK, {
      prefix: source.prefix,
      limit: 30,
      forward: false,
      cursor: sk ? { PK: source.PK, SK: sk } : undefined,
    });
    next[source.key] = page.cursor?.SK || null;
    const contentRows =
      source.key === "visit"
        ? await Promise.all(
            page.items.map((ref) => getItem(tables.visits, pk, ref.contentSK)),
          )
        : page.items;
    for (const item of contentRows) {
      if (!item) continue;
      if (
        item.expiresAt <= seconds() ||
        !["event", "caption", "message"].includes(item.kind)
      )
        continue;
      if (item.kind === "caption" && (!actor.grants.captions || !content))
        continue;
      if (item.kind === "message" && (!actor.grants.visitorText || !content))
        continue;
      collected.push(clean<ConversationItem>(item));
    }
  }
  collected.sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  return {
    access: {
      captions: Boolean(actor.grants.captions && content),
      visitorText: Boolean(actor.grants.visitorText && content),
      camera: Boolean(actor.grants.camera && content),
    },
    visit: viewVisit(raw, actor, content),
    items: collected,
    threads: actor.grants.visitorText
      ? threadRows.map((t) => {
          const thread = clean<Thread>(t);
          if (!content) {
            delete thread.lastMessage;
            delete thread.category;
          }
          return thread;
        })
      : [],
    ...(Object.values(next).some((v) => v !== null)
      ? { nextCursor: Buffer.from(JSON.stringify(next)).toString("base64url") }
      : {}),
  };
}

export async function guestView(
  actor: Actor,
  cursor?: string,
): Promise<GuestView & { nextCursor?: string }> {
  actor = await refresh(actor, "visitorText");
  if (actor.kind !== "guest" || !actor.threadId)
    throw new AppError("FORBIDDEN", 403, "Visitor access is required.");
  const thread = await getItem(
    tables.visits,
    threadPK(actor.householdId, actor.threadId),
    "STATE",
  );
  if (
    !thread ||
    thread.deleted ||
    thread.expiresAt <= seconds() ||
    !(await threadVisitAccessible(actor.householdId, thread))
  )
    throw new AppError("EXPIRED", 403, "This conversation has expired.");
  let sk: string | undefined;
  if (cursor) {
    try {
      if (cursor.length > 2048) throw Error();
      sk = Buffer.from(cursor, "base64url").toString();
      if (!sk.startsWith("MESSAGE#") || sk.length > 500) throw Error();
    } catch {
      throw new AppError("VALIDATION", 400, "Invalid conversation cursor.");
    }
  }
  const page = await queryPK(tables.visits, thread.PK, {
    prefix: "MESSAGE#",
    limit: 30,
    forward: false,
    cursor: sk ? { PK: thread.PK, SK: sk } : undefined,
  });
  return {
    thread: {
      id: thread.id,
      category: thread.category,
      expiresAt: thread.expiresAt,
      associated: !!thread.visitId,
    },
    messages: page.items
      .filter((r) => r.expiresAt > seconds())
      .map((r) => clean<ConversationItem>(r))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    csrf: actor.csrf,
    wsUrl: wsUrl(),
    ...(page.cursor
      ? { nextCursor: Buffer.from(page.cursor.SK).toString("base64url") }
      : {}),
  };
}
