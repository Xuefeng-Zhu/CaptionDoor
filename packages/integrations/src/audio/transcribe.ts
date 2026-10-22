import {
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
  type AudioStream,
  type Result,
} from "@aws-sdk/client-transcribe-streaming";
export type StreamingCaption = {
  mediaSessionId: string;
  resultId: string;
  text: string;
  isPartial: boolean;
  startTime: number;
  endTime: number;
  source: "AWS" | "FIXTURE";
};
export function streamingCaptionFromResult(
  mediaSessionId: string,
  result: Result,
): StreamingCaption | undefined {
  const text = result.Alternatives?.[0]?.Transcript;
  if (!text) return undefined;
  if (!result.ResultId) throw new Error("InvalidTranscriptMetadata");
  if (
    typeof result.IsPartial !== "boolean" ||
    typeof result.StartTime !== "number" ||
    typeof result.EndTime !== "number" ||
    !Number.isFinite(result.StartTime) ||
    !Number.isFinite(result.EndTime) ||
    result.StartTime < 0 ||
    result.EndTime < result.StartTime
  )
    throw new Error("InvalidTranscriptMetadata");
  return {
    mediaSessionId,
    resultId: result.ResultId,
    text,
    isPartial: result.IsPartial,
    startTime: result.StartTime,
    endTime: result.EndTime,
    source: "AWS",
  };
}
/** Only ephemeral bounded audio buffers. Never use this as application persistence. */
export class AudioBufferQueue implements AsyncIterable<Uint8Array> {
  private entries: Uint8Array[] = [];
  private waiter: ((value: IteratorResult<Uint8Array>) => void) | undefined;
  private ended = false;
  constructor(private readonly maxChunks = 5) {}
  push(chunk: Uint8Array) {
    if (this.ended) return false;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value: chunk, done: false });
      return true;
    }
    if (this.entries.length >= this.maxChunks) return false;
    this.entries.push(chunk);
    return true;
  }
  close() {
    this.ended = true;
    this.entries = [];
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator]() {
    return {
      next: (): Promise<IteratorResult<Uint8Array>> => {
        if (this.ended)
          return Promise.resolve({ value: undefined, done: true });
        const entry = this.entries.shift();
        if (entry) return Promise.resolve({ value: entry, done: false });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true as const };
      },
    };
  }
}
export class AwsPcmStream {
  private readonly queue = new AudioBufferQueue(5);
  private readonly abort = new AbortController();
  private readonly client: TranscribeStreamingClient;
  private stopped = false;
  constructor(
    private mediaSessionId: string,
    private onCaption: (caption: StreamingCaption) => Promise<void>,
    private onFailure: (category: string) => void,
  ) {
    this.client = new TranscribeStreamingClient({
      region: process.env.AWS_REGION || "us-east-1",
      maxAttempts: 1,
    });
  }
  push(pcm: Uint8Array) {
    return this.queue.push(pcm);
  }
  async run() {
    try {
      const chunks = this.queue;
      async function* audio(): AsyncGenerator<AudioStream> {
        for await (const chunk of chunks)
          yield { AudioEvent: { AudioChunk: chunk } };
      }
      const output = await this.client.send(
        new StartStreamTranscriptionCommand({
          LanguageCode: "en-US",
          MediaEncoding: "pcm",
          MediaSampleRateHertz: 16000,
          NumberOfChannels: 1,
          AudioStream: audio(),
        }),
        { abortSignal: this.abort.signal },
      );
      for await (const event of output.TranscriptResultStream || []) {
        if (this.stopped) break;
        for (const result of event.TranscriptEvent?.Transcript?.Results || []) {
          const caption = streamingCaptionFromResult(
            this.mediaSessionId,
            result,
          );
          if (caption) await this.onCaption(caption);
        }
      }
    } catch (error) {
      if (!this.stopped)
        this.onFailure(
          error instanceof Error ? error.name : "TranscribeFailure",
        );
    } finally {
      this.stop();
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.close();
    this.abort.abort();
    this.client.destroy();
  }
}
