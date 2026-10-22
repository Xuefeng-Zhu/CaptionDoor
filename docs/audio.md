# Incoming audio and captions

Verified against [Amazon Transcribe streaming](https://docs.aws.amazon.com/transcribe/latest/dg/streaming.html) and [partial results](https://docs.aws.amazon.com/transcribe/latest/dg/streaming-partial-results.html) on 2026-10-22. AWS accepts signed 16-bit little-endian PCM without WAV headers. Recommended chunk duration is 50–200 ms. This implementation uses 16 kHz mono, 100 ms, 1600 samples/3200 bytes. The sample rate is the actual resampling output, not a changed label.

## Browser path

The browser-only `startRemoteCapture` helper accepts the single explicitly selected live remote audio track from the authorized incoming Ring stream. It never calls `getUserMedia`, never selects a resident microphone and never asks a visitor for microphone access. Call it directly from a resident action after consent to AWS audio processing. The AudioContext resumes during that action. `MediaStreamAudioSourceNode` → AudioWorklet → zero-gain output keeps the graph active without local sound. Stopping disconnects nodes and closes AudioContext; it does not stop an independently owned Ring track used for media.

The shipping worklet downmixes channels, applies a 33-tap windowed-sinc low-pass resampler from the actual AudioContext sample rate, and emits bounded PCM16LE frames at 16 kHz. Each binary frame is exactly 3212 bytes: ASCII `CDP1`, uint32 sequence, uint32 sample offset (all header integers big-endian), then 3200 PCM bytes (little-endian). Sequence and offset start at zero. Missing/reordered frames interrupt capture instead of being replayed late.

The browser waits for an authenticated `capture-ready` acknowledgement. A send buffer above 32000 bytes, socket closure, remote track end, or server capture/error status discards buffered audio and stops capture. The worker accepts at most five queued PCM chunks and six pending socket operations. It checks the current session, consent, current handler, lease and media session for each binary frame and caption result. Heartbeats also recheck access on existing connections. A lease cannot open parallel audio streams in this single-worker runtime. Lost connection stops capture; it never silently transfers responsibility.

## AWS path

`AwsPcmStream` passes an async stream of PCM chunks to AWS SDK v3 `StartStreamTranscriptionCommand`, language `en-US`, `MediaEncoding=pcm`, `MediaSampleRateHertz=16000`, `NumberOfChannels=1`. A bounded ephemeral queue holds audio only until accepted by the live stream. Shutdown, handoff, lease loss, end, overload, or authorization failure aborts the SDK operation and empties it. No application audio/video recording exists. AWS processes audio under its service terms; provider data/backup limits must be disclosed separately from application retention.

Partial results use `(mediaSessionId, ResultId)` and replace prior text. Only final results are conditionally persisted once per result ID. Start/end offsets and `AWS` provenance are retained without invented confidence or rewriting. `Finalized` describes the service's result stage and is not a statement that the words were verified. Finals are still fallible. Screen-reader announcements must avoid every changing partial.

## Fixture path

`TRANSCRIBE_MODE=fixture` is explicit local demo only. It captures no audio and makes no AWS request. A durable `DEMO_CAPTIONS` job rehydrates the requesting session by hash, rechecks its handler/consent/lease before every result, and emits `Do` → `Do not` → `Do not leave it.` for a single result ID. Only the final is persisted. UI labels it **Demo transcript**. This is neither official Ring Playground evidence nor an end-to-end Ring/AWS observation. Production rejects fixture mode.

## Worker and jobs

The Node worker serves `/health` and `/ws` on isolated port 3411. Origin is checked before WebSocket upgrade. HttpOnly cookie sessions authenticate upgrades and every subscription/sensitive operation. Residents subscribe to their authorized household/visit; guest connections subscribe only to their own short-lived thread and never receive captions, household identity or other thread content. Event IDs/versions prompt strong HTTP state/history refetch on reconnect; the worker does not claim global ordering or socket-delivery acknowledgement.

Local jobs use the same durable DynamoDB handlers through a bounded due-index poller. This is a transport substitute, not validation of Streams/SQS. The cloud path consumes key-only SQS messages and also polls the due index to recover missed dispatch and future jobs. Conditional job leases, bounded retry attempts and retained dead-job categories live in DynamoDB. SQS competing consumers do not broadcast: **the MVP requires one worker**; replica scaling needs shared authorized fan-out before adding replicas. Notification provider acceptance is separate from a person seeing/acknowledging a notification.

## Evidence and limits

`pnpm exec vitest run tests/unit/audio.test.ts` passed 9 focused tests, including actual shipping worklet output at 44100 and 48000 Hz, downmix amplitude, 1 kHz timing, PCM signs/endianness, chunk length, silent graph output, sequence rejection anti-alias attenuation, bounded-buffer discard, and provider metadata validation using synthetic response fixtures. Final aggregate command/results belong in `docs/test-results.md`. Live incoming Ring tracks, Safari hardware AudioWorklet behavior and AWS transcription accuracy/latency require opt-in external credentials/device smoke tests and must not be recorded as passed from fixtures.
