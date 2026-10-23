import { encodePcmFrame, PCM_SAMPLES } from "./protocol";
export type RemoteCaptureOptions = {
  context?: AudioContext;
  track: MediaStreamTrack;
  source: "ring-remote";
  websocket: WebSocket;
  visitId: string;
  leaseId: string;
  mediaSessionId: string;
  onInterrupted: (reason: string) => void;
};
/** Call directly from a resident action after explicit AWS processing consent.
 * No getUserMedia call exists. The caller must pass its authorized remote track.
 */
export async function startRemoteCapture(
  options: RemoteCaptureOptions,
): Promise<{ stop: () => Promise<void> }> {
  const { track, websocket } = options;
  if (
    options.source !== "ring-remote" ||
    track.kind !== "audio" ||
    track.readyState !== "live"
  )
    throw new Error(
      "No live incoming remote audio track is available. Text remains available.",
    );
  if (websocket.readyState !== WebSocket.OPEN)
    throw new Error(
      "The caption connection is offline. Text remains available.",
    );
  const context = options.context ?? new AudioContext();
  let stopped = false;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let gain: GainNode | undefined;
  let sequence = 0;
  let offset = 0;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    track.removeEventListener("ended", ended);
    websocket.removeEventListener("close", closed);
    websocket.removeEventListener("message", serverStatus);
    node?.port.postMessage({ type: "stop" });
    source?.disconnect();
    node?.disconnect();
    gain?.disconnect();
    if (websocket.readyState === WebSocket.OPEN)
      websocket.send(
        JSON.stringify({
          type: "capture-stop",
          visitId: options.visitId,
          leaseId: options.leaseId,
        }),
      );
    await context.close();
  };
  const interrupt = (reason: string) => {
    void stop();
    options.onInterrupted(reason);
  };
  const serverStatus = (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data.visitId && data.visitId !== options.visitId) return;
    if (
      data.type === "capture-stopped" ||
      data.type === "media-status" ||
      data.type === "error"
    )
      interrupt(
        data.message || "Caption capture stopped. Text remains available.",
      );
  };
  const ended = () =>
    interrupt("Incoming audio ended. Text remains available.");
  const closed = () =>
    interrupt("Caption connection interrupted. Text remains available.");
  // Resume immediately in the user gesture before waiting for server authorization.
  await context.resume();
  try {
    const approved = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Caption authorization timed out."));
      }, 8000);
      const cleanup = () => {
        clearTimeout(timer);
        websocket.removeEventListener("message", received);
      };
      const received = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (data.type === "capture-ready" && data.visitId === options.visitId) {
          cleanup();
          resolve();
        } else if (data.type === "error") {
          cleanup();
          reject(
            new Error(data.message || "Caption authorization was denied."),
          );
        }
      };
      websocket.addEventListener("message", received);
    });
    websocket.send(
      JSON.stringify({
        type: "capture",
        visitId: options.visitId,
        leaseId: options.leaseId,
        mediaSessionId: options.mediaSessionId,
      }),
    );
    await approved;
    await context.audioWorklet.addModule("/pcm-worklet.js");
    if (stopped) throw new Error("Caption capture was stopped.");
    source = context.createMediaStreamSource(new MediaStream([track]));
    node = new AudioWorkletNode(context, "captiondoor-pcm", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCountMode: "explicit",
      channelCount: 1,
    });
    gain = context.createGain();
    gain.gain.value = 0;
    node.port.onmessage = (event: MessageEvent) => {
      if (stopped || event.data?.type !== "pcm") return;
      if (
        websocket.readyState !== WebSocket.OPEN ||
        websocket.bufferedAmount > 32000
      ) {
        interrupt(
          "Audio connection overloaded. Buffered audio was discarded. Text remains available.",
        );
        return;
      }
      websocket.send(encodePcmFrame(sequence++, offset, event.data.pcm));
      offset += PCM_SAMPLES;
    };
    source.connect(node);
    node.connect(gain);
    gain.connect(context.destination);
    track.addEventListener("ended", ended);
    websocket.addEventListener("close", closed);
    websocket.addEventListener("message", serverStatus);
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
