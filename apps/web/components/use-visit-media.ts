"use client";
import { useEffect, useRef, useState } from "react";
import type { Visit } from "@captiondoor/domain";
import type { PerformVisitCommand } from "./visit-types";
import { api, errorText } from "./api";
type Options = {
  id: string;
  visit?: Visit;
  currentUserId?: string;
  cameraAllowed: boolean;
  captionsAllowed: boolean;
  csrf?: string;
  wsUrl?: string;
  perform: PerformVisitCommand;
  load: () => Promise<void>;
  setBusy: (value: string) => void;
};
export function useVisitMedia({
  id,
  visit,
  currentUserId,
  cameraAllowed,
  captionsAllowed,
  csrf,
  wsUrl,
  perform,
  load,
  setBusy,
}: Options) {
  const [includeAudio, setIncludeAudio] = useState(false),
    [mediaNote, setMediaNote] = useState(""),
    [captureNote, setCaptureNote] = useState(""),
    [mediaReady, setMediaReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null),
    remoteTrack = useRef<MediaStreamTrack | null>(null),
    mediaControl = useRef<{ close: () => Promise<void> } | null>(null),
    captureControl = useRef<{ stop: () => Promise<void> } | null>(null),
    captureSocket = useRef<WebSocket | null>(null);
  useEffect(
    () => () => {
      void captureControl.current?.stop().catch(() => {});
      captureSocket.current?.close();
      void mediaControl.current?.close().catch(() => {});
    },
    [],
  );
  useEffect(() => {
    if (
      !visit ||
      !currentUserId ||
      !cameraAllowed ||
      visit.handlerId !== currentUserId ||
      !["LIVE", "CONNECTING"].includes(visit.mediaStatus)
    ) {
      void captureControl.current?.stop().catch(() => {});
      captureSocket.current?.close();
      captureControl.current = null;
      remoteTrack.current = null;
      void mediaControl.current?.close().catch(() => {});
      mediaControl.current = null;
      setMediaReady(false);
      if (videoRef.current) videoRef.current.srcObject = null;
    } else if (
      (!visit.audioLease || !captionsAllowed) &&
      captureControl.current
    ) {
      void captureControl.current.stop().catch(() => {});
      captureSocket.current?.close();
      captureControl.current = null;
    }
  }, [
    visit?.audioLease?.id,
    visit?.handlerId,
    visit?.mediaStatus,
    currentUserId,
    cameraAllowed,
    captionsAllowed,
    !!visit,
  ]);
  async function startMedia() {
    if (!cameraAllowed) {
      setMediaNote(
        "Incoming camera access is no longer available. Text remains available where authorized.",
      );
      return;
    }
    setBusy("media");
    setMediaReady(false);
    setMediaNote("Connecting to authorized incoming media…");
    let activeMediaId = "";
    let readyPosted = false;
    const markLive = async () => {
      if (readyPosted || !activeMediaId) return;
      readyPosted = true;
      try {
        await api(`/visits/${id}/media/ready`, {
          body: { mediaSessionId: activeMediaId },
          csrf: csrf,
        });
        setMediaReady(true);
        await load();
      } catch (e) {
        setMediaReady(false);
        setMediaNote(
          `Incoming media authorization ended. ${errorText(e)} Text remains available.`,
        );
        void mediaControl.current?.close();
      }
    };
    try {
      const { connectRingMedia } =
        await import("../../../packages/integrations/src/browser-ring");
      const control = await connectRingMedia({
        includeAudio,
        createSession: async (offer) => {
          const session = await api<{
            mediaSessionId: string;
            answer: string;
            expiresAt: number;
          }>(`/visits/${id}/media`, {
            body: {
              offer,
              includeAudio,
              consent: true,
              expectedVersion: visit!.version,
            },
            csrf: csrf,
          });
          activeMediaId = session.mediaSessionId;
          return session;
        },
        closeSession: (mediaSessionId) =>
          api(`/visits/${id}/media/${mediaSessionId}`, {
            method: "DELETE",
            body: {},
            csrf: csrf,
          }),
        onState: (state, message) => {
          setMediaNote(message);
          if (state === "LIVE") void markLive();
          if (["ENDED", "UNAVAILABLE", "INTERRUPTED"].includes(state))
            setMediaReady(false);
        },
        onRemoteAudio: (track) => {
          remoteTrack.current = track;
        },
      });
      mediaControl.current = control;
      if (videoRef.current) videoRef.current.srcObject = control.stream;
      if (!readyPosted)
        setMediaNote(
          "Media negotiation completed. Waiting for incoming tracks; captions require a separate action.",
        );
      await load();
    } catch (e) {
      setMediaNote(
        `Media unavailable. ${errorText(e)} Text remains available.`,
      );
    } finally {
      setBusy("");
    }
  }
  async function startCapture() {
    if (!captionsAllowed) {
      setCaptureNote("Caption access is no longer available.");
      return;
    }
    if (!remoteTrack.current) {
      setCaptureNote(
        "No incoming audio track is available. Visitor text still works.",
      );
      return;
    }
    if (typeof AudioContext === "undefined") {
      setCaptureNote(
        "This browser cannot process incoming audio. Visitor text remains available.",
      );
      return;
    }
    const gestureContext = new AudioContext();
    try {
      await gestureContext.resume();
    } catch (e) {
      await gestureContext.close();
      setCaptureNote(
        `Audio could not start. ${errorText(e)} Text remains available.`,
      );
      return;
    }
    const result = await perform({ type: "capture", consent: true });
    const lease = result?.visit.audioLease;
    if (!lease || !result?.visit.mediaSessionId) {
      await gestureContext.close();
      return;
    }
    setBusy("capture");
    try {
      const { startRemoteCapture } =
        await import("../../../packages/integrations/src/audio/browser");
      const socket = new WebSocket(wsUrl!);
      captureSocket.current = socket;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Audio connection timed out.")),
          5000,
        );
        socket.onopen = () => {
          clearTimeout(timeout);
          resolve();
        };
        socket.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("Audio connection failed."));
        };
      });
      captureControl.current = await startRemoteCapture({
        track: remoteTrack.current,
        source: "ring-remote",
        context: gestureContext,
        websocket: socket,
        visitId: id,
        leaseId: lease.id,
        mediaSessionId: result.visit.mediaSessionId,
        onInterrupted: (reason) =>
          setCaptureNote(
            `Captions interrupted. ${reason} Text remains available.`,
          ),
      });
      setCaptureNote(
        "Selected incoming audio is being processed by AWS Transcribe. No app recording is stored.",
      );
    } catch (e) {
      setCaptureNote(
        `Captions unavailable. ${errorText(e)} Text remains available.`,
      );
      captureSocket.current?.close();
      if (gestureContext.state !== "closed") await gestureContext.close();
    } finally {
      setBusy("");
    }
  }
  function stopMedia() {
    void captureControl.current?.stop();
    captureSocket.current?.close();
    void mediaControl.current?.close().catch(() => {});
    mediaControl.current = null;
    void perform({ type: "media", action: "stop" });
    setMediaReady(false);
    setMediaNote("Media ended. Text remains available.");
  }
  return {
    videoRef,
    includeAudio,
    setIncludeAudio,
    mediaNote,
    captureNote,
    mediaReady,
    hasMedia: !!mediaControl.current,
    startMedia,
    startCapture,
    stopMedia,
  };
}
export type VisitMediaController = ReturnType<typeof useVisitMedia>;
