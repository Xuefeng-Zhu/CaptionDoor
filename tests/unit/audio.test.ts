import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  decodePcmFrame,
  encodePcmFrame,
  PcmSequence,
  PCM_BYTES,
} from "../../packages/integrations/src/audio/protocol";
import {
  AudioBufferQueue,
  streamingCaptionFromResult,
} from "../../packages/integrations/src/audio/transcribe";
function worklet(sampleRate: number) {
  let Processor: any;
  const chunks: ArrayBuffer[] = [];
  class Base {
    port = {
      onmessage: null as any,
      postMessage: (v: any) => chunks.push(v.pcm),
    };
  }
  vm.runInNewContext(readFileSync("apps/web/public/pcm-worklet.js", "utf8"), {
    AudioWorkletProcessor: Base,
    sampleRate,
    registerProcessor: (_: string, p: any) => {
      Processor = p;
    },
    ArrayBuffer,
    DataView,
    Math,
  });
  const processor = new Processor();
  return { processor, chunks };
}
describe("remote PCM transport", () => {
  it("encodes a bounded 100ms PCM frame with sequence and source sample offset", () => {
    const bytes = new Uint8Array(PCM_BYTES);
    new DataView(bytes.buffer).setInt16(0, -16384, true);
    const frame = decodePcmFrame(
      new Uint8Array(encodePcmFrame(7, 11200, bytes)),
    );
    expect(frame.sequence).toBe(7);
    expect(frame.sampleOffset).toBe(11200);
    expect(new DataView(frame.pcm.buffer).getInt16(0, true)).toBe(-16384);
    expect(() => encodePcmFrame(0, 0, new Uint8Array(44))).toThrow();
    expect(() => decodePcmFrame(new Uint8Array(3200))).toThrow();
  });
  it("rejects delayed, missing, reordered and malformed PCM", () => {
    const sequence = new PcmSequence();
    sequence.accept(
      decodePcmFrame(
        new Uint8Array(encodePcmFrame(0, 0, new Uint8Array(3200))),
      ),
    );
    expect(() =>
      sequence.accept(
        decodePcmFrame(
          new Uint8Array(encodePcmFrame(0, 0, new Uint8Array(3200))),
        ),
      ),
    ).toThrow();
    expect(() =>
      sequence.accept(
        decodePcmFrame(
          new Uint8Array(encodePcmFrame(2, 3200, new Uint8Array(3200))),
        ),
      ),
    ).toThrow();
  });
  it.each([44100, 48000])(
    "resamples actual %i Hz stereo blocks to 16k mono signed PCM without relabelling",
    (sampleRate) => {
      const { processor, chunks } = worklet(sampleRate);
      const inputSamples = Math.ceil(sampleRate * 0.22);
      for (let offset = 0; offset < inputSamples; offset += 128) {
        const left = new Float32Array(128);
        const right = new Float32Array(128);
        for (let i = 0; i < 128; i++) {
          left[i] =
            Math.sin((2 * Math.PI * 1000 * (offset + i)) / sampleRate) * 0.8;
          right[i] = 0;
        }
        const output = new Float32Array(128).fill(1);
        processor.process([[left, right]], [[output]]);
        expect(output.every((x) => x === 0)).toBe(true);
      }
      expect(chunks.length).toBe(2);
      expect(chunks[0].byteLength).toBe(3200);
      const v = new DataView(chunks[0]);
      const samples = Array.from({ length: 1600 }, (_, i) =>
        v.getInt16(i * 2, true),
      );
      const max = Math.max(...samples);
      expect(max).toBeGreaterThan(11500);
      expect(max).toBeLessThan(14000);
      let crossings = 0;
      for (let i = 1; i < samples.length; i++)
        if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
      expect(crossings).toBeGreaterThanOrEqual(98);
      expect(crossings).toBeLessThanOrEqual(101);
    },
  );
  it("attenuates input frequencies above the new Nyquist limit instead of aliasing them", () => {
    const { processor, chunks } = worklet(48000);
    for (let offset = 0; offset < 11000; offset += 128) {
      const signal = Float32Array.from(
        { length: 128 },
        (_, i) => Math.sin((2 * Math.PI * 12000 * (offset + i)) / 48000) * 0.8,
      );
      processor.process([[signal]], [[new Float32Array(128)]]);
    }
    const v = new DataView(chunks[0]);
    const peak = Math.max(
      ...Array.from({ length: 1600 }, (_, i) =>
        Math.abs(v.getInt16(i * 2, true)),
      ),
    );
    expect(peak).toBeLessThan(300);
  });
  it("discards stopped and overloaded buffers", async () => {
    const q = new AudioBufferQueue(2);
    expect(q.push(new Uint8Array([1]))).toBe(true);
    expect(q.push(new Uint8Array([2]))).toBe(true);
    expect(q.push(new Uint8Array([3]))).toBe(false);
    q.close();
    expect(q.push(new Uint8Array([4]))).toBe(false);
    expect((await q[Symbol.asyncIterator]().next()).done).toBe(true);
  });
  it("preserves provider result IDs, offsets and finalization from synthetic AWS response fixtures", () => {
    const result = {
      ResultId: "segment-1",
      StartTime: 0.25,
      EndTime: 1.1,
      IsPartial: true,
      Alternatives: [{ Transcript: "Do not" }],
    };
    expect(streamingCaptionFromResult("media-1", result)).toMatchObject({
      mediaSessionId: "media-1",
      resultId: "segment-1",
      startTime: 0.25,
      endTime: 1.1,
      isPartial: true,
      text: "Do not",
    });
    expect(
      streamingCaptionFromResult("media-1", {
        ...result,
        IsPartial: false,
        Alternatives: [{ Transcript: "Do not leave it." }],
      }),
    ).toMatchObject({ isPartial: false, text: "Do not leave it." });
  });
  it("refuses missing or invalid provider timing/finalization instead of inventing metadata", () => {
    const base = {
      ResultId: "r",
      Alternatives: [{ Transcript: "words" }],
      StartTime: 0,
      EndTime: 1,
      IsPartial: false,
    };
    expect(() =>
      streamingCaptionFromResult("m", { ...base, ResultId: undefined }),
    ).toThrow("InvalidTranscriptMetadata");
    expect(() =>
      streamingCaptionFromResult("m", { ...base, StartTime: undefined }),
    ).toThrow("InvalidTranscriptMetadata");
    expect(() =>
      streamingCaptionFromResult("m", { ...base, IsPartial: undefined }),
    ).toThrow("InvalidTranscriptMetadata");
    expect(() =>
      streamingCaptionFromResult("m", { ...base, EndTime: -1 }),
    ).toThrow("InvalidTranscriptMetadata");
    expect(
      streamingCaptionFromResult("m", { ...base, Alternatives: [] }),
    ).toBeUndefined();
  });
  it("the shipping browser helper has no resident microphone request", () => {
    expect(
      readFileSync("packages/integrations/src/audio/browser.ts", "utf8"),
    ).not.toMatch(/navigator\.mediaDevices|getUserMedia\s*\(/);
  });
});
