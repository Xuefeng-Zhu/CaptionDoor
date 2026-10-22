# CaptionDoor

**Understand your doorstep without relying on sound.**

CaptionDoor is an accessibility-first local application for a household's selected door. It runs a real persisted journey: a doorbell event creates a visible alert, a resident claims responsibility, available captions stay separate from visitor text, a resident explicitly sends a reply to a private visitor page, the visitor can choose **Got it**, and the resident explicitly closes the visit.

This checkout is at `/Users/frank/mygit/CaptionDoor`. It was created after a case-insensitive search found no existing CaptionDoor directory. No other project, shared database, public repository, cloud deployment or hackathon submission is part of this work. A subsequent instruction authorized the separate private source repository. The latest expanded browser rerun is blocked by an unresponsive shared Docker server; earlier local passes and exact recovery prerequisites are recorded in docs/test-results.md.

## Run the credential-free local demo

Prerequisites: Node **24 LTS** (`.nvmrc` is 24.14.1), Corepack, and Docker/OrbStack running. pnpm **12.14.0** is pinned. Use `corepack pnpm` if no global `pnpm` command exists.

```sh
cd /Users/frank/mygit/CaptionDoor
corepack pnpm install --frozen-lockfile
corepack pnpm setup:local
corepack pnpm dev
```

Open **http://127.0.0.1:3410/onboarding**. Select the explicitly local Alex identity, review the three independent consents, and continue. Use a separate browser profile for Sam, and a private browser for **http://127.0.0.1:3410/door/front-demo**. Jordan belongs to the isolated second household.

The printable local QR uses the configured loopback origin and works on this Mac. A phone cannot reach the Mac through its own `127.0.0.1`; use an explicitly authorized reachable HTTPS origin before printing a sign for another device. No public tunnel or domain was created.

`setup:local` starts only Compose project `captiondoor_local`, creates the three DynamoDB tables/indexes, and seeds missing local records without replacing existing records. It creates an ignored `.env` and a private local fixture signing key if absent. It never requests AWS credentials. After `.env` changes, restart web/worker processes.

Ports are isolated: **3410 web**, **3411 worker WebSocket/health**, **8410 DynamoDB Local**, optional **3443 HTTPS**. All host bindings are loopback. No SayGo/Sway process or shared database is stopped or reused.

## Docker application processes

After setup, stop only this project's host `pnpm dev` process before starting the application containers on the same ports:

```sh
corepack pnpm setup:local
docker compose -p captiondoor_local --profile app up --build -d
curl --fail http://127.0.0.1:3410/api/health
curl --fail http://127.0.0.1:3411/health
```

The local application targets use explicit development/demo modes. The separate production targets use actual OIDC/Ring/AWS configuration and reject demo/fixture combinations. `infra/compose.aws.yaml` is a deployment configuration for later review, not an executed deployment. The optional HTTPS profile uses Caddy's private CA and **does not install system trust**; see `docs/architecture.md`. No certificate/security setting is changed automatically.

To stop only CaptionDoor's containers: `docker compose -p captiondoor_local --profile app stop web worker`. Do not run a global Docker prune or stop other projects.

## Try the complete journey

1. `/demo` → **A visitor rings**. This signs LOCAL fixture bytes and uses the same HMAC normalization and DynamoDB transaction path. It is not the official Ring Playground.
2. On the home screen choose **I'll handle this.** Claiming sends nothing.
3. In the visit choose **Start Demo transcript** after consent. Its revisable fixture ends with **Do not leave it.** Finalized means the segment ended, not that recognition is verified.
4. In the private visitor browser send Delivery, Appointment or Other text. In the resident visit explicitly choose **Associate thread**. A scan or nearby timestamp proves neither identity nor presence.
5. Edit a preset and choose **Send to visitor page**. Watch ACCEPTED, then DISPLAYED while the visitor page is visible, then CONFIRMED only after **Got it**.
6. Choose a closure outcome and **Close visit**. A timeout never establishes departure.

The other local cards exercise unavailable media and duplicate semantic deliveries. Real tests cover concurrent claims, stale handler/audio fences, expiry, worker restart, guest disconnect/reconnect and tenant denials. The under-three-minute walkthrough is in [docs/demo-script.md](docs/demo-script.md).

A visitor without a phone may supply incoming audio for available captions, but cannot receive these web replies. The app never speaks through a Ring speaker, unlocks a door, monitors continuously, identifies faces/emotions, diagnoses emergencies or sends automatic/LLM replies. The app does not record audio/video or request a resident/visitor microphone.

## Commands and verification

```sh
corepack pnpm check
corepack pnpm test:integration
corepack pnpm exec playwright install chromium
corepack pnpm test:e2e
corepack pnpm judge:replay
corepack pnpm infra:synth
```

The credential-free `judge:replay` command runs one synthetic journey through actual local services, preserves nonzero failures and writes a new timestamped evidence directory per attempt. It refuses production/provider modes and existing active demo visits; deliberately close the current local visit first. See [docs/judging-replay.md](docs/judging-replay.md). Its latest attempt is BLOCKED by the current Docker runtime outage, not counted as passing.

Integration tests require the real local database on port8410; browser tests also require web3410 and worker3411. They create isolated fixtures/threads. `test:recovery` requires the main CaptionDoor worker to be stopped first; it starts/stops only its own child worker and refuses an occupied port. It verifies a durable job across a real process restart.

`corepack pnpm build` compiles production Next artifacts with explicit OIDC/live/AWS build modes and makes no provider calls. Runtime still requires actual production configuration. Production does not permit the local demo environment. Cloud SDK/provider calls remain opt-in; no successful cloud/device behavior is inferred from fixture tests or synth.

See [docs/test-results.md](docs/test-results.md) for exact observed commands, pass/fail/skip history, screenshots and single-run latency observations. WCAG2.2AA is a design target, not certification. Chromium checks include 320px, keyboard/focus, 48px controls, reduced motion, effective320px reflow at200% zoom and axe. Physical Safari/iOS and real provider/device paths require separate validation.

## Boundaries and storage

The pnpm workspace contains `apps/web` (Next App Router resident PWA, guest page and HTTP APIs), `apps/worker` (single long-running authenticated WebSocket/audio/job worker), browser-safe `packages/domain`/`contracts`, DynamoDB `packages/db`, provider `packages/integrations`, `infra/cdk`, fixtures and tests.

DynamoDB is the **only persistent application database**: `CaptionDoorConfig`, `CaptionDoorVisits`, `CaptionDoorRuntime`. There is no SQL/Prisma/Postgres/SQLite/Supabase/Redis or in-memory persistence substitute. State, idempotency, audit and outbox writes are atomic. Base-table strong reads and conditional versions authorize decisions; GSIs are discovery mechanisms. Each final caption/message is its own item. Application expiry is enforced before delayed TTL cleanup; explicit durable deletion removes content copies.

Local jobs use a bounded due-index poller and the same handlers. This is a transport substitute, **not Streams/SQS validation**. The AWS design uses KEYS_ONLY Streams → filtered Lambda → SQS job keys only → Node worker, with due-index recovery, conditional leases/retries and DLQ. One worker is the supported MVP; replicas need shared fan-out because SQS competing consumers do not broadcast.

The service worker caches only a public offline page/icon. It does not cache private API responses, transcripts, media, tokens or session pages. Offline visibly means no live alerts.

## Real integration prerequisites

Copy only placeholders from `.env.example` and keep credentials in the ignored `.env`/protected runtime environment. Never use `NEXT_PUBLIC_`, localStorage, screenshots or logs for secrets. The local fixture HMAC key is separate from a real Ring partner HMAC key.

- **Cognito**: configure issuer/client/secret and HTTPS callback. OIDC is separate from Ring linking. A trusted operator must initially provision the owner identity/household. Owner-created invitation codes are one-use/expiring, bound to a verified Cognito subject at acceptance, and capped at two active members; no email is sent automatically. The local seed already contains two residents.
- **Ring Playground**: explicit `RING_MODE=playground` and an actual authorized short-lived token. Hardware or simulator use must include observed substantial Ring technology; organizer guidance allows a self-built simulator with that real integration evidence. LOCAL-only fixtures and intercepted tests do not supply it. There is no fallback to LOCAL. See the submission checklist for source links and mixed-provenance limits.
- **Ring live**: approved invitation-only partner access, OAuth credentials, registered HTTPS callback/webhook and signing key, selected authorized device. Tokens are encrypted before persistence; link completion is explicit. KMS is required in production; a separately generated AES-GCM key is available only for deliberate development linking.
- **Transcribe**: explicit `TRANSCRIBE_MODE=aws`, authorized AWS credentials/Region/IAM, separate transcription consent and a selected incoming remote audio track. AudioWorklet resamples to actual mono16kHz signedPCM16LE,100ms chunks. Missing audio/expiry/provider failure leaves text available.
- **Web Push**: VAPID configuration and explicit browser opt-in/test. Provider acceptance does not mean the user saw or acknowledged anything. iOS/iPadOS requires an installed Home Screen web app and a user gesture.

No cloud/device prerequisites are fabricated. See [docs/integration-contracts.md](docs/integration-contracts.md), [docs/compatibility-matrix.md](docs/compatibility-matrix.md), [docs/security-and-privacy.md](docs/security-and-privacy.md), and [docs/assumptions-and-blockers.md](docs/assumptions-and-blockers.md). Real provider smoke prerequisites are in [docs/ring-smoke.md](docs/ring-smoke.md), and factual developer feedback is in [docs/tool-feedback.md](docs/tool-feedback.md).

## Troubleshooting and reset

- Docker connection error: start the installed Docker/OrbStack application, then rerun setup. The application never changes system trust or asks you to disable Ring encryption.
- Port conflict: inspect the exact port and stop only this project's own process/container. Do not kill SayGo/Sway or reuse their database.
- Missing local signing key: rerun setup and restart web/worker. No key is printed.
- 503 provider configuration: read the visible error and configure the named provider explicitly; local text/demo remains independent.
- 409 command conflict: refetch the current visit; exactly one resident can win a claim. A pending handoff keeps the original resident responsible.
- Captions stop: check consent, incoming track, active lease, media expiry and connection. Reconnect reloads strong state plus paginated history; it does not replay delayed audio as live.
- Guest refresh retains only that browser's thread. A different browser gets a different thread. Expired/revoked cookies cannot restore content merely because TTL has not run.

`corepack pnpm demo:reset` is destructive **only to CaptionDoor's exact local tables**. It refuses nonlocal endpoints, unexpected ports/table names and production. Use it only to reset this controlled demo; normal setup preserves existing data. It does not delete shared services or Docker volumes from other projects.

New code is MIT; dependency licenses/notices remain in installed packages. See LICENSE and THIRD_PARTY_NOTICES.md. The user subsequently authorized the separate [private GitHub source repository](https://github.com/Xuefeng-Zhu/CaptionDoor). Public visibility, billable deployment and hackathon submission remain unauthorized. Repository verification is recorded in docs/test-results.md.
