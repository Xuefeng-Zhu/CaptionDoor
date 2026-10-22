/** Browser-safe wire protocol. 100 ms, mono, signed PCM16LE at 16 kHz. */
export const PCM_SAMPLE_RATE = 16000;
export const PCM_SAMPLES = 1600;
export const PCM_BYTES = PCM_SAMPLES * 2;
export const PCM_HEADER_BYTES = 12;
export const PCM_MAGIC = 0x43445031; // CDP1
export type PcmFrame = {
  sequence: number;
  sampleOffset: number;
  pcm: Uint8Array;
};
export function encodePcmFrame(
  sequence: number,
  sampleOffset: number,
  pcm: ArrayBuffer | Uint8Array,
): ArrayBuffer {
  const data = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
  if (data.byteLength !== PCM_BYTES)
    throw new Error("A PCM frame must contain exactly 100 ms of mono PCM16LE.");
  const result = new ArrayBuffer(PCM_HEADER_BYTES + PCM_BYTES);
  const view = new DataView(result);
  view.setUint32(0, PCM_MAGIC, false);
  view.setUint32(4, sequence, false);
  view.setUint32(8, sampleOffset, false);
  new Uint8Array(result, PCM_HEADER_BYTES).set(data);
  return result;
}
export function decodePcmFrame(input: Uint8Array): PcmFrame {
  if (input.byteLength !== PCM_HEADER_BYTES + PCM_BYTES)
    throw new Error("Invalid PCM frame length.");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (view.getUint32(0, false) !== PCM_MAGIC)
    throw new Error("Invalid PCM frame format.");
  return {
    sequence: view.getUint32(4, false),
    sampleOffset: view.getUint32(8, false),
    pcm: input.slice(PCM_HEADER_BYTES),
  };
}
/** Reordering or missing audio is an interruption, never a delayed live backlog. */
export class PcmSequence {
  private sequence = 0;
  private sampleOffset = 0;
  accept(frame: PcmFrame) {
    if (
      frame.sequence !== this.sequence ||
      frame.sampleOffset !== this.sampleOffset
    )
      throw new Error("Audio sequence interrupted.");
    this.sequence++;
    this.sampleOffset += PCM_SAMPLES;
  }
}
