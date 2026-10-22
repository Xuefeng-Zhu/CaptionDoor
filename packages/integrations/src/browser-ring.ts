// Browser-only entry point: deliberately never exports credentials or server SDKs.
export type RingBrowserState =
  "CONNECTING" | "LIVE" | "ENDED" | "UNAVAILABLE" | "INTERRUPTED";
export type RingBrowserSession = {
  mediaSessionId: string;
  answer: string;
  expiresAt: number;
};
export type RingBrowserOptions = {
  includeAudio: boolean;
  signal?: AbortSignal;
  iceServers?: RTCIceServer[];
  createSession: (offer: string) => Promise<RingBrowserSession>;
  closeSession: (mediaSessionId: string) => Promise<void>;
  onState: (state: RingBrowserState, message: string) => void;
  onRemoteAudio?: (track: MediaStreamTrack, stream: MediaStream) => void;
};
export type RingBrowserController = {
  stream: MediaStream;
  mediaSessionId: string;
  close: () => Promise<void>;
};

/** Call only after a resident action and consent. Never asks for a microphone. */
export async function connectRingMedia(
  options: RingBrowserOptions,
): Promise<RingBrowserController> {
  if (typeof RTCPeerConnection === "undefined") {
    options.onState(
      "UNAVAILABLE",
      "This browser cannot receive Ring media. Text remains available.",
    );
    throw new Error("WebRTC is unavailable.");
  }
  if (options.signal?.aborted) throw new Error("Media request was cancelled.");
  const peer = new RTCPeerConnection({ iceServers: options.iceServers ?? [] });
  const stream = new MediaStream();
  let session: RingBrowserSession | undefined;
  let closed = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let trackTimer: ReturnType<typeof setTimeout> | undefined;
  let closeRequest: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closeRequest) return closeRequest;
    closed = true;
    clearTimeout(expiryTimer);
    clearTimeout(trackTimer);
    options.signal?.removeEventListener("abort", abort);
    peer.ontrack = null;
    peer.onconnectionstatechange = null;
    for (const track of stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
    peer.close();
    closeRequest = session
      ? Promise.resolve().then(() =>
          options.closeSession(session!.mediaSessionId),
        )
      : Promise.resolve();
    return closeRequest;
  };
  const terminate = (state: RingBrowserState, message: string): void => {
    if (closed) return;
    options.onState(state, message);
    // close() closes local capture synchronously even when signaling cleanup fails.
    void close().catch(() =>
      options.onState(state, `${message} Server cleanup will be retried.`),
    );
  };
  const abort = (): void =>
    terminate("ENDED", "Media stopped. Text remains available.");

  // Register handlers before creating an offer: early track events must not be lost.
  peer.ontrack = (event) => {
    if (closed) {
      event.track.stop();
      return;
    }
    if (
      !["audio", "video"].includes(event.track.kind) ||
      (event.track.kind === "audio" && !options.includeAudio)
    ) {
      event.track.stop();
      return;
    }
    if (!stream.getTracks().some((track) => track.id === event.track.id))
      stream.addTrack(event.track);
    if (event.track.kind === "audio")
      options.onRemoteAudio?.(event.track, stream);
    if (event.track.kind === "video" && peer.connectionState === "connected")
      options.onState(
        "LIVE",
        stream.getAudioTracks().length
          ? "Incoming Ring media connected."
          : "Incoming video connected; waiting for optional audio.",
      );
    event.track.onended = () =>
      terminate("INTERRUPTED", "Incoming media ended. Text remains available.");
  };
  peer.onconnectionstatechange = () => {
    if (closed) return;
    if (peer.connectionState === "connected") {
      if (stream.getVideoTracks().length)
        options.onState(
          "LIVE",
          stream.getAudioTracks().length
            ? "Incoming Ring media connected."
            : "Incoming video connected; waiting for optional audio.",
        );
      else
        options.onState(
          "CONNECTING",
          "Connection established; waiting for incoming media tracks…",
        );
    }
    if (["failed", "disconnected"].includes(peer.connectionState))
      terminate(
        "INTERRUPTED",
        "Media connection interrupted. Text remains available.",
      );
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  options.onState("CONNECTING", "Connecting to incoming Ring media…");
  peer.addTransceiver("video", { direction: "recvonly" });
  if (options.includeAudio)
    peer.addTransceiver("audio", { direction: "recvonly" });
  try {
    await peer.setLocalDescription(await peer.createOffer());
    await waitForIce(peer, options.signal);
    if (closed || !peer.localDescription?.sdp)
      throw new Error("Media connection cancelled.");
    session = await options.createSession(peer.localDescription.sdp);
    if (closed || options.signal?.aborted) {
      await options.closeSession(session.mediaSessionId);
      throw new Error("Media connection cancelled.");
    }
    if (
      !session.mediaSessionId ||
      !/^v=0\r?\n/.test(session.answer) ||
      session.expiresAt <= Date.now()
    )
      throw new Error("Media session response is invalid or expired.");
    await peer.setRemoteDescription({ type: "answer", sdp: session.answer });
    const remaining = Math.min(
      60_000,
      Math.max(0, session.expiresAt - Date.now()),
    );
    expiryTimer = setTimeout(
      () =>
        terminate(
          "ENDED",
          "Ring media session expired. Text remains available.",
        ),
      remaining,
    );
    trackTimer = setTimeout(
      () => {
        if (!stream.getVideoTracks().length)
          terminate(
            "UNAVAILABLE",
            "No incoming media tracks arrived. Text remains available.",
          );
        else if (peer.connectionState !== "connected")
          terminate(
            "INTERRUPTED",
            "Incoming media did not connect. Text remains available.",
          );
        else if (options.includeAudio && !stream.getAudioTracks().length)
          options.onState(
            "LIVE",
            "Video is available. No incoming audio track arrived; captions are unavailable.",
          );
      },
      Math.min(8_000, remaining),
    );
    return {
      stream,
      mediaSessionId: session.mediaSessionId,
      close: async () => {
        if (!closed)
          options.onState("ENDED", "Media stopped. Text remains available.");
        await close();
      },
    };
  } catch (error) {
    if (!closed)
      options.onState(
        "UNAVAILABLE",
        "Incoming Ring media is unavailable. Text remains available.",
      );
    await close().catch(() => undefined);
    throw error;
  }
}

function waitForIce(
  peer: RTCPeerConnection,
  signal?: AbortSignal,
): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", changed);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const changed = (): void => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const aborted = (): void =>
      finish(new Error("Media connection cancelled."));
    const timer = setTimeout(
      () => finish(new Error("ICE gathering timed out.")),
      5_000,
    );
    peer.addEventListener("icegatheringstatechange", changed);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}
