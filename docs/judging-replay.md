# Reproduce the LOCAL judge journey

Current execution results, provenance and intentionally paused service state are recorded in [test-results.md](test-results.md).

Prepared **2026-10-22 UTC**. Run `corepack pnpm judge:replay` to exercise CaptionDoor’s existing browser journey against its real local HTTP APIs, authenticated WebSockets, Node worker and DynamoDB Local. No Ring Playground token, AWS account or cloud credentials are required for this **LOCAL** run.

“Replay” means a reproducible run of the product flow. It is **not a recording or replay of an earlier real Ring session**. The doorbell event is signed synthetic LOCAL input; media state is a LOCAL_FIXTURE; the words are a FIXTURE **Demo transcript**. Actual Ring runtime evidence remains absent.

## Prerequisites and startup

Use a dedicated local demo checkout with synthetic data. Install Node24 LTS, Corepack and a working Docker runtime; the repository pins pnpm12.14.0 and its dependencies. Run these commands from the checkout root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright install chromium
corepack pnpm setup:local
docker compose -p captiondoor_local --profile app up --build -d
curl --fail --max-time 8 http://127.0.0.1:3410/api/health
curl --fail --max-time 8 http://127.0.0.1:3411/health
corepack pnpm judge:replay
```

The first dependency, browser and Docker image downloads need network access. The replay itself uses the loopback local application and fixtures; it makes no real Ring or AWS Transcribe call. Setup generates the private local signing configuration without requiring or displaying a partner credential.

The web health response must identify demo Ring/auth and fixture transcription; the worker must be healthy. The replay command is restricted to loopback web3410/worker3411 and those local modes. To watch Chromium perform the same run:

```sh
corepack pnpm judge:replay --headed
```

Use `corepack pnpm judge:replay --help` for the command’s local usage.

If this checkout’s host `pnpm dev` processes already own3410/3411, stop only those CaptionDoor processes before starting Compose. The isolated project is `captiondoor_local`, with DynamoDB on8410. Do not stop SayGo/Sway, restart the shared Docker runtime, reuse another database, deploy cloud resources or create a public tunnel for this replay.

The judge entry point refuses to claim, take over or close an existing active seeded visit. If it reports that precondition, inspect the visit at `http://127.0.0.1:3410/home` and deliberately close that demo visit with the appropriate outcome before retrying. It does not reset tables or delete existing history. A normal `setup:local` preserves records; `demo:reset` is not a prerequisite.

## What the run changes and demonstrates

The automated journey opens three independent browser contexts: Alex, Sam and one guest. Alex and Sam are explicit seeded residents in one household; the guest has its own short-lived scoped session and isolated text thread. Ordinary tabs sharing cookies are not guest-isolation evidence.

This is a local test action: it enables the demo household’s separate Ring-media, transcription and sharing consent settings. Review those settings before using the demo afterward. It creates a synthetic visit/thread and their durable messages, finalized fixture caption and audit records. It closes its own visit with **COMPLETED**, then reloads to verify persisted history. It does not modify real provider accounts or send a push notification.

| Step               | Action and visible evidence                                                                                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visible alert      | A signed LOCAL button-press fixture follows the application webhook normalization and real DynamoDB transaction path. Alex sees the unclaimed visit on the home screen.                                                                                                                             |
| Responsibility     | Playwright deliberately clicks **I’ll handle this.** Alex becomes handler; Sam sees that handler. The test checks that claiming sent no message.                                                                                                                                                    |
| Available captions | A deliberate **Start Demo transcript** click starts the fixture job. The caption is keyed by media session/result, revises to **Do not leave it.**, and is labeled **Finalized** and **Demo transcript**. Finalized does not mean verified. No real incoming track or AWS transcription is implied. |
| Visitor text       | The separate guest context chooses **Delivery** and sends synthetic text. Alex explicitly chooses **Associate thread**. Neither the QR entrance nor timing proves identity or presence.                                                                                                             |
| Approved reply     | Selecting a preset fills the editable reply only. The test checks no reply was sent, then deliberately clicks **Send to visitor page**. These are scripted resident actions; the application has no autonomous reply policy.                                                                        |
| Delivery stages    | The guest is deliberately offline during send, so the reply stays **ACCEPTED**. After reconnect and visible rendering it becomes **DISPLAYED**. Only the guest’s explicit **Got it** click records **CONFIRMED**. A socket is never treated as an acknowledgement.                                  |
| Explicit closure   | Alex selects an outcome and clicks **Close visit**. Reload shows the closed state and persisted finalized caption. Session closure does not establish a person’s departure.                                                                                                                         |

The focused replay also runs axe against the populated resident screen. It does not replace the separate race, handoff, tenant-isolation, privacy-revocation, expiry, worker-restart or full accessibility suites. See [test-results.md](test-results.md) for exactly which checks were observed.

## Reports and current execution status

Each accepted local invocation creates a new `output/judge-replay/<UTC timestamp>-<id>/` directory and prints its evidence location. Earlier attempts are preserved.

- `result.json` records the attempt’s outcome and distinct provenance. Failed health/mode prerequisites record **BLOCKED** and exit2; no browser journey is counted as passed. When the browser runs, **PASS** requires the actual child process to exit0. A failing or interrupted browser run records **FAIL** and preserves its nonzero exit.
- `report/index.html` contains the Playwright result when the browser runner launches.
- `journey-observations.json` contains LOCAL event, LOCAL_FIXTURE media and FIXTURE transcript provenance plus single-run observed timings, when that stage is reached.
- `visit-desktop.png` and `visitor-desktop.png` show rendered synthetic resident/guest screens, when generated.
- `test-artifacts/` contains failure artifacts where generated. Browser tracing is disabled; request failures are sanitized.

A blocked preflight can legitimately contain only `result.json`. Do not infer that absent screenshots or timing files were produced. To open a browser report, replace `ATTEMPT` below with the timestamp-and-ID folder printed by that invocation:

```sh
corepack pnpm exec playwright show-report "output/judge-replay/ATTEMPT/report"
```

Do not present leftover files from an earlier run as a newly passing replay. A screenshot, successful build or provider request acceptance alone is not proof of the complete journey or user acknowledgement. Generated reports and screenshots are ignored by Git; keep credentials, environment files, session material and private visitor content out of anything shared externally.

**Actual LOCAL replay passed:** `output/judge-replay/2026-10-22T02-19-27-994Z-0ed445/result.json` records PASS/exit0 after1 browser journey in 12.4s. The final 12-case browser suite also passed in 42.5s, including both privacy withdrawals and explicit access messages. Earlier runtime failures and an active-fixture guard refusal remain in [test-results.md](test-results.md); the exact webhook fixture cleanup was repaired and its history retained. Services are intentionally stopped after verification for sequential handoff. Start only CaptionDoor for its next turn; no real Ring or AWS behavior is established by this pass.

## Judge walkthrough, QR and provider gates

The concise English narration in [demo-script.md](demo-script.md) fits under three minutes after setup. Use the replay report for automated evidence and the narrated walkthrough for explanation; neither is prior real Ring footage.

The printable sign uses the configured local origin. `127.0.0.1` on a visitor phone points to that phone, not this Mac. For this local review, open `/door/front-demo` in a separate browser context on the Mac. Testing an actual phone QR needs a separately authorized reachable HTTPS origin and corresponding origin/session configuration; this guide creates none. A visitor without a phone can supply incoming speech when real authorized incoming audio is available, but cannot receive a web-page reply. Replies never go through the Ring speaker.

Hardware is optional under the organizer’s documented simulator guidance. A participant-built simulator or clearly attributed mixed demonstration can be acceptable **when substantial actual Ring technology is used**; see the sourced interpretation in [submission-checklist.md](submission-checklist.md). CaptionDoor’s current LOCAL fixtures, implemented adapters and mocked-provider tests do not establish that actual-runtime component. A LOCAL event combined later with real Playground media and fixture captions must retain those separate labels and must not be called end-to-end Ring audio-to-AWS-caption evidence.

Remaining provider gates include authorized Ring/Playground operation and observed receive-only media, real incoming audio/AWS Transcribe, Cognito/KMS, cloud Streams/Lambda/SQS delivery, Web Push provider/device delivery, physical Safari/iOS and native accessibility testing. Physical-device ownership is not a prerequisite for this credential-free LOCAL replay; provider tests require their actual credentials, consent, compatible runtime and any separately required authorization. See [integration-contracts.md](integration-contracts.md) and [compatibility-matrix.md](compatibility-matrix.md).

No video publication, reviewer invitation, public repository, external deployment or hackathon submission is performed by this guide or replay command.
