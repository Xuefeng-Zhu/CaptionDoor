import {
  StartStreamTranscriptionCommand,
  type AudioStream,
  type Result,
} from "@aws-sdk/client-transcribe-streaming";
import { AppError } from "@captiondoor/domain";
import { createVerifiedTranscribeClient } from "./aws-identity";
import {
  armRootSmokeDeadline,
  assertRootSmokePermit,
  type RootSmokePermit,
} from "./root-smoke-permit";
import {
  armRemoteProviderDeadline,
  assertRemoteProviderPermit,
  type RemoteProviderPermit,
} from "./remote-provider-permit";

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
  private aws: ReturnType<typeof createVerifiedTranscribeClient> | undefined;
  private preparing: Promise<void> | undefined;
  private running = false;
  private stopped = false;
  private cancelRootDeadline: (() => void) | undefined;
  private cancelRemoteDeadline: (() => void) | undefined;
  constructor(
    private mediaSessionId: string,
    private onCaption: (caption: StreamingCaption) => Promise<void>,
    private onFailure: (category: string) => void,
    private readonly rootPermit?: RootSmokePermit,
    private readonly remotePermit?: RemoteProviderPermit,
  ) {
    if (rootPermit)
      this.cancelRootDeadline = armRootSmokeDeadline(rootPermit, () => {
        if (this.stopped) return;
        this.stop();
        this.onFailure("ROOT_SMOKE_DURATION_LIMIT");
      });
    if (remotePermit)
      this.cancelRemoteDeadline = armRemoteProviderDeadline(
        remotePermit,
        () => {
          if (this.stopped) return;
          this.stop();
          this.onFailure("REMOTE_PROVIDER_SMOKE_DURATION_LIMIT");
        },
      );
  }
  private rootDeadlineReached() {
    if (!this.rootPermit || Date.now() < this.rootPermit.expiresAt)
      return false;
    if (!this.stopped) {
      this.stop();
      this.onFailure("ROOT_SMOKE_DURATION_LIMIT");
    }
    return true;
  }
  private remoteDeadlineReached() {
    if (!this.remotePermit || Date.now() < this.remotePermit.expiresAt)
      return false;
    if (!this.stopped) {
      this.stop();
      this.onFailure("REMOTE_PROVIDER_SMOKE_DURATION_LIMIT");
    }
    return true;
  }
  private deadlineReached() {
    return this.rootDeadlineReached() || this.remoteDeadlineReached();
  }
  push(pcm: Uint8Array) {
    if (this.deadlineReached()) return false;
    return this.queue.push(pcm);
  }
  /** Complete account verification before the worker permits the browser to send PCM. */
  prepare(): Promise<void> {
    if (!this.preparing)
      this.preparing = (async () => {
        if (this.stopped)
          throw new AppError(
            "TRANSCRIBE_STREAM_ENDED",
            409,
            "Caption stream ended.",
          );
        this.aws = createVerifiedTranscribeClient(
          this.abort.signal,
          process.env,
          this.rootPermit,
          this.remotePermit,
        );
        await this.aws.verify();
        if (this.stopped)
          throw new AppError(
            "TRANSCRIBE_STREAM_ENDED",
            409,
            "Caption stream ended.",
          );
      })();
    return this.preparing;
  }
  async run() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.prepare();
      if (this.stopped || this.deadlineReached()) return;
      if (this.rootPermit)
        assertRootSmokePermit(this.rootPermit, this.rootPermit);
      if (this.remotePermit)
        assertRemoteProviderPermit(this.remotePermit, this.remotePermit);
      await this.aws!.verifyCredentials();
      if (this.stopped || this.deadlineReached()) return;
      const chunks = this.queue;
      async function* audio(): AsyncGenerator<AudioStream> {
        for await (const chunk of chunks)
          yield { AudioEvent: { AudioChunk: chunk } };
      }
      const output = await this.aws!.client.send(
        new StartStreamTranscriptionCommand({
          LanguageCode: "en-US",
          MediaEncoding: "pcm",
          MediaSampleRateHertz: 16000,
          AudioStream: audio(),
        }),
        { abortSignal: this.abort.signal },
      );
      for await (const event of output.TranscriptResultStream || []) {
        if (this.stopped || this.deadlineReached()) break;
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
          error instanceof AppError
            ? error.code
            : error instanceof Error
              ? error.name
              : "TranscribeFailure",
        );
    } finally {
      this.stop();
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelRootDeadline?.();
    this.cancelRemoteDeadline?.();
    this.queue.close();
    this.abort.abort();
    this.aws?.destroy();
  }
}
