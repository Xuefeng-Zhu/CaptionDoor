export type VisitStatus = "UNCLAIMED" | "CLAIMED" | "CLOSED";
export type MediaStatus =
  | "IDLE"
  | "CONNECTING"
  | "LIVE"
  | "ENDED"
  | "UNAVAILABLE"
  | "INTERRUPTED";
export type DeliveryStatus = "ACCEPTED" | "DISPLAYED" | "CONFIRMED";
export type Actor = {
  kind: "resident" | "guest";
  userId: string;
  householdId: string;
  sessionId: string;
  expiresAt: number;
  csrf: string;
  threadId?: string;
  grants: {
    camera: boolean;
    captions: boolean;
    visitorText: boolean;
    membership: boolean;
  };
};
export type Visit = {
  id: string;
  householdId: string;
  doorId: string;
  doorName: string;
  status: VisitStatus;
  version: number;
  handlerId?: string;
  handlerName?: string;
  pendingHandoff?: {
    targetUserId: string;
    targetName: string;
    requestedBy: string;
  };
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  outcome?: "COMPLETED" | "DISMISSED" | "NO_RESPONSE_RECORDED";
  mediaStatus: MediaStatus;
  mediaSessionId?: string;
  mediaExpiresAt?: number;
  audioLease?: {
    id: string;
    holderId: string;
    epoch: number;
    expiresAt: number;
  };
  eventSource: "LOCAL" | "PLAYGROUND" | "LIVE";
  mediaSource: "NONE" | "LOCAL_FIXTURE" | "RING";
  transcriptSource: "NONE" | "FIXTURE" | "AWS";
  deleted?: boolean;
};
export type Thread = {
  id: string;
  householdId: string;
  doorId: string;
  createdAt: number;
  expiresAt: number;
  visitId?: string;
  category?: string;
  lastMessage?: string;
};
export type ConversationItem = {
  id: string;
  kind: "message" | "caption" | "event";
  createdAt: number;
  expiresAt: number;
  text: string;
  direction?: "visitor" | "resident";
  threadId?: string;
  deliveryStatus?: DeliveryStatus;
  mediaSessionId?: string;
  resultId?: string;
  isPartial?: boolean;
  startTime?: number;
  endTime?: number;
  source?: "FIXTURE" | "AWS";
  version?: number;
};
export type Settings = {
  retentionHours: number;
  captionSize: number;
  consent: { ring: boolean; transcription: boolean; sharing: boolean };
  presets: string[];
};
export type Member = {
  userId: string;
  name: string;
  role: "owner" | "member";
  expiresAt: number;
  revoked?: boolean;
  grants: Actor["grants"];
};
export type Door = {
  id: string;
  name: string;
  publicDoorId: string;
  householdId: string;
  activeVisitId?: string;
};
export type Bootstrap = {
  user: { id: string; name: string };
  household: { id: string; name: string };
  doors: Door[];
  members: Member[];
  visits: Visit[];
  threads: Thread[];
  settings: Settings;
  mode: { ring: string; transcribe: string; auth: string };
  csrf: string;
  wsUrl: string;
};
export type VisitView = {
  access: { captions: boolean; visitorText: boolean; camera: boolean };
  visit: Visit;
  items: ConversationItem[];
  threads: Thread[];
  nextCursor?: string;
};
export type GuestView = {
  thread: {
    id: string;
    category?: string;
    expiresAt: number;
    associated: boolean;
  };
  messages: ConversationItem[];
  csrf: string;
  wsUrl: string;
  nextCursor?: string;
};
export class AppError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public current?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}
export const presets = [
  "I’m coming. Please wait.",
  "Please leave the package by the door.",
  "Please type your request here.",
];
export function assertFresh(expiresAt: number) {
  if (expiresAt <= Math.floor(Date.now() / 1000))
    throw new AppError("EXPIRED", 403, "Access has expired.");
}
export function validateModes(env: Record<string, string | undefined>) {
  const production = env.NODE_ENV === "production";
  if (
    production &&
    ((env.AUTH_MODE || "demo") === "demo" ||
      (env.RING_MODE || "demo") === "demo" ||
      (env.TRANSCRIBE_MODE || "fixture") === "fixture")
  )
    throw new Error(
      "Production rejects demo authentication, Ring simulation and fixture transcription.",
    );
  if (!["demo", "oidc"].includes(env.AUTH_MODE || "demo"))
    throw new Error("Invalid AUTH_MODE");
  if (!["demo", "playground", "live"].includes(env.RING_MODE || "demo"))
    throw new Error("Invalid RING_MODE");
  if (!["fixture", "aws"].includes(env.TRANSCRIBE_MODE || "fixture"))
    throw new Error("Invalid TRANSCRIBE_MODE");
}
