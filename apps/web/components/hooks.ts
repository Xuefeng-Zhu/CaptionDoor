"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText, HttpError } from "./api";
import type { Bootstrap, ConversationItem } from "@captiondoor/domain";
export function useResident() {
  const [data, setData] = useState<Bootstrap | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try {
      const d = await api<Bootstrap>("/me");
      setData(d);
      setError("");
      return d;
    } catch (e) {
      if (e instanceof HttpError && [401, 403].includes(e.status))
        setData(null);
      setError(errorText(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}
export function useLive({
  url,
  visitId,
  guest,
  onChange,
  onCaption,
}: {
  url?: string;
  visitId?: string;
  guest?: boolean;
  onChange: () => void;
  onCaption?: (caption: ConversationItem) => void;
}) {
  const [state, setState] = useState<
    "connecting" | "live" | "reconnecting" | "offline"
  >("connecting");
  const changeRef = useRef(onChange),
    captionRef = useRef(onCaption);
  useEffect(() => {
    changeRef.current = onChange;
    captionRef.current = onCaption;
  }, [onChange, onCaption]);
  useEffect(() => {
    if (!url) return;
    let closed = false,
      socket: WebSocket | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      attempt = 0,
      generation = 0;
    const seenEvents = new Set<string>();
    const versions = new Map<string, number>();
    const connect = () => {
      if (closed) return;
      if (!navigator.onLine) {
        setState("offline");
        return;
      }
      setState(attempt ? "reconnecting" : "connecting");
      try {
        const current = ++generation;
        const active = new WebSocket(url);
        socket = active;
        active.onopen = () => {
          if (closed || current !== generation) {
            active.close();
            return;
          }
          attempt = 0;
          active.send(
            JSON.stringify(
              guest
                ? { type: "guest" }
                : { type: "subscribe", ...(visitId ? { visitId } : {}) },
            ),
          );
          changeRef.current();
        };
        active.onmessage = (e) => {
          if (closed || current !== generation) return;
          try {
            const msg = JSON.parse(String(e.data));
            if (msg.type === "subscribed") {
              setState("live");
              changeRef.current();
              return;
            }
            if (msg.type === "changed") {
              if (typeof msg.eventId === "string") {
                if (seenEvents.has(msg.eventId)) return;
                seenEvents.add(msg.eventId);
                if (seenEvents.size > 128)
                  seenEvents.delete(seenEvents.values().next().value!);
              }
              if (
                typeof msg.visitId === "string" &&
                typeof msg.version === "number"
              ) {
                if (msg.version < (versions.get(msg.visitId) ?? -1)) return;
                versions.set(msg.visitId, msg.version);
                if (versions.size > 128)
                  versions.delete(versions.keys().next().value!);
              }
            }
            if (msg.type === "caption" && msg.caption)
              captionRef.current?.(msg.caption);
            else if (
              ["changed", "snapshot", "event", "ready"].includes(msg.type)
            )
              changeRef.current();
            else if (msg.type === "ping")
              socket?.send(JSON.stringify({ type: "pong" }));
            else if (msg.type === "error") {
              setState("reconnecting");
              changeRef.current();
            }
          } catch {}
        };
        active.onclose = () => {
          if (!closed && current === generation) {
            setState(navigator.onLine ? "reconnecting" : "offline");
            timer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15000));
          }
        };
        active.onerror = () => active.close();
      } catch {
        timer = setTimeout(connect, 3000);
      }
    };
    const online = () => {
      clearTimeout(timer);
      generation++;
      socket?.close();
      connect();
      changeRef.current();
    };
    const offline = () => {
      setState("offline");
      generation++;
      socket?.close();
    };
    const visible = () => {
      if (document.visibilityState === "visible") changeRef.current();
    };
    connect();
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", visible);
    const poll = setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine)
        changeRef.current();
    }, 5000);
    const heartbeat = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "ping" }));
    }, 20000);
    return () => {
      closed = true;
      generation++;
      clearTimeout(timer);
      clearInterval(poll);
      clearInterval(heartbeat);
      socket?.close();
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [url, visitId, guest]);
  return state;
}
