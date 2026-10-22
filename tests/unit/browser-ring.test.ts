import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  connectRingMedia,
  type RingBrowserState,
} from "../../packages/integrations/src/browser-ring";

class FakeTrack {
  kind = "video";
  id = "remote-video-fixture";
  onended: (() => void) | null = null;
  stop = vi.fn();
}
class FakeStream {
  private tracks: MediaStreamTrack[] = [];
  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
  }
  getTracks() {
    return [...this.tracks];
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}
class FakePeer {
  static instances: FakePeer[] = [];
  static emitEarlyVideo = true;
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  ontrack: ((event: { track: MediaStreamTrack }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  video = new FakeTrack();
  transceivers: { kind: string; direction: string }[] = [];
  close = vi.fn(() => {
    this.connectionState = "closed";
  });
  constructor() {
    FakePeer.instances.push(this);
  }
  addTransceiver(kind: string, options: RTCRtpTransceiverInit) {
    this.transceivers.push({ kind, direction: options.direction! });
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    // An early remote-track event would be lost if handlers were registered later.
    if (!this.ontrack || !this.onconnectionstatechange)
      throw new Error("Media handlers must precede negotiation");
    return { type: "offer", sdp: "v=0\r\ns=mock-offer\r\n" };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
  }
  async setRemoteDescription() {
    if (FakePeer.emitEarlyVideo)
      this.ontrack?.({ track: this.video as unknown as MediaStreamTrack });
  }
  connect() {
    this.connectionState = "connected";
    this.onconnectionstatechange?.();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
  FakePeer.instances = [];
  FakePeer.emitEarlyVideo = true;
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  vi.stubGlobal("MediaStream", FakeStream);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function connect() {
  const states: { state: RingBrowserState; message: string }[] = [];
  const closeSession = vi.fn(async (_id: string) => undefined);
  const controller = await connectRingMedia({
    includeAudio: true,
    createSession: async () => ({
      mediaSessionId: "opaque-media-fixture",
      answer: "v=0\r\ns=mock-answer\r\n",
      expiresAt: Date.now() + 30_000,
    }),
    closeSession,
    onState: (state, message) => states.push({ state, message }),
  });
  return { controller, states, closeSession, peer: FakePeer.instances[0] };
}
describe("browser Ring readiness with mocked WebRTC, no hardware", () => {
  it("never promotes an early video track to LIVE when ICE has not connected", async () => {
    const { controller, states, closeSession, peer } = await connect();
    expect(controller.stream.getVideoTracks()).toHaveLength(1);
    expect(peer.connectionState).toBe("new");
    expect(states.some((event) => event.state === "LIVE")).toBe(false);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(states.some((event) => event.state === "LIVE")).toBe(false);
    expect(states.at(-1)?.state).toBe("INTERRUPTED");
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(peer.video.stop).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(
      "opaque-media-fixture",
    );
  });
  it("reports missing optional audio honestly only after the peer and video are connected", async () => {
    const { controller, states, closeSession, peer } = await connect();
    peer.connect();
    expect(states.at(-1)?.state).toBe("LIVE");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(states.at(-1)).toMatchObject({
      state: "LIVE",
      message: expect.stringContaining("captions are unavailable"),
    });
    expect(closeSession).not.toHaveBeenCalled();
    expect(peer.transceivers).toEqual([
      { kind: "video", direction: "recvonly" },
      { kind: "audio", direction: "recvonly" },
    ]);
    await controller.close();
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(
      "opaque-media-fixture",
    );
  });
  it("does not call a connected peer LIVE when no video track arrives", async () => {
    FakePeer.emitEarlyVideo = false;
    const { states, closeSession, peer } = await connect();
    peer.connect();
    expect(states.at(-1)?.state).toBe("CONNECTING");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(states.some((event) => event.state === "LIVE")).toBe(false);
    expect(states.at(-1)?.state).toBe("UNAVAILABLE");
    expect(closeSession).toHaveBeenCalledTimes(1);
  });
});
