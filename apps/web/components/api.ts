import type { Bootstrap, ConversationItem } from "@captiondoor/domain";
export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    csrf?: string;
    key?: string;
  } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: options.method || (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...(options.csrf ? { "X-CSRF-Token": options.csrf } : {}),
      ...(options.body === undefined
        ? {}
        : { "Idempotency-Key": options.key || crypto.randomUUID() }),
    },
    credentials: "same-origin",
    cache: "no-store",
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new HttpError(
      "The service did not return a readable response. Please try again.",
      res.status,
      "UNREADABLE",
    );
  }
  if (!res.ok)
    throw new HttpError(
      data.error?.message || "This action could not be completed.",
      res.status,
      data.error?.code || "REQUEST_FAILED",
    );
  return data as T;
}
export function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : "This action could not be completed. Please try again.";
}
export function timeLabel(value: number) {
  return new Date(value < 1e12 ? value * 1000 : value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
export function dateLabel(value: number) {
  return new Date(value < 1e12 ? value * 1000 : value).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}
export function mergeItems(a: ConversationItem[], b: ConversationItem[]) {
  const m = new Map(
    a.map((i) => [
      i.kind === "caption" ? `${i.mediaSessionId}:${i.resultId}` : i.id,
      i,
    ]),
  );
  for (const i of b) {
    const key =
      i.kind === "caption" ? `${i.mediaSessionId}:${i.resultId}` : i.id;
    const previous = m.get(key);
    if (previous?.kind === "caption" && !previous.isPartial && i.isPartial)
      continue;
    m.set(key, i);
  }
  return [...m.values()].sort((x, y) => x.createdAt - y.createdAt);
}
export function modeLabel(data: Bootstrap) {
  return data.mode.ring === "demo"
    ? "LOCAL DEMO"
    : data.mode.ring === "playground"
      ? "RING PLAYGROUND"
      : "RING LIVE";
}
