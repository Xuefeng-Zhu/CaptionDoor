# CaptionDoor

**Understand your doorstep without relying on sound.**

CaptionDoor helps a deaf or hard-of-hearing resident understand incoming doorstep speech. A visible doorbell alert leads to an explicit claim, an explicitly started caption session, handling the visit in person, and recorded closure. Visitor text and approved replies remain an optional separate fallback. Ring's current WHEP contract does not send reply audio to its doorbell speaker.

This checkout is at `/Users/frank/mygit/CaptionDoor`. The local demo uses real DynamoDB Local persistence and clearly labeled simulated Ring events/fixture captions. Database-only AWS configuration and its focused template are prepared and locally verified; **AWS cutover has not occurred**. See the [remote DynamoDB runbook](docs/remote-dynamodb-runbook.md) for the proposed resources, identity, cost and approval steps. Exact dated results and restart instructions are in [docs/test-results.md](docs/test-results.md); earlier passes do not verify subsequent changes or real providers.

## Run the credential-free local demo

Prerequisites: Node **24 LTS** (`.nvmrc` is 24.14.1), Corepack, and Docker/OrbStack running. pnpm **12.14.0** is pinned. Use `corepack pnpm` if no global `pnpm` command exists.

```sh
cd /Users/frank/mygit/CaptionDoor
corepack pnpm install --frozen-lockfile
corepack pnpm setup:local
corepack pnpm dev
```

Open **http://127.0.0.1:3410/onboarding**. Select the explicitly local Alex identity, review the three independent consents, and continue. Use a separate browser profile for Sam. For optional visitor text, use a private browser for **http://127.0.0.1:3410/door/front-demo**. Jordan belongs to the isolated second household.

The printable local QR uses the configured loopback origin and works on this Mac. A phone cannot reach the Mac through its own `127.0.0.1`; use an explicitly authorized reachable HTTPS origin before printing a sign for another device. No public tunnel or domain was created.

`setup:local` starts only Compose project `captiondoor_local`, creates the three DynamoDB tables/indexes, and seeds missing local records without replacing existing records. It creates an ignored `.env` and a private local fixture signing key if absent, preserving existing values. Local setup selects `CAPTIONDOOR_DB_MODE=local`, `CAPTIONDOOR_ENV=local` and `DYNAMODB_ENDPOINT=http://127.0.0.1:8410`; `.env.example` documents the remaining local values. It never requests AWS credentials. After configuration changes, restart web/worker processes. Missing or incompatible database modes fail visibly; there is no implicit AWS/Local fallback.

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

To stop the application containers, use `docker compose -p captiondoor_local --profile app stop web worker`. To free the sequential project slot, also stop CaptionDoor's database with `docker compose -p captiondoor_local stop dynamodb`; if using the optional HTTPS profile, stop its CaptionDoor proxy too. Stopping preserves volumes. Do not run a global Docker prune or stop other projects.

## AWS database development on the Mac

AWS storage is separate from provider/auth modes. The proposed `remote-demo` still runs the web/worker on loopback with fictional demo identities, simulated Ring and fixture transcription. Production continues to require its own OIDC/live/AWS configuration and rejects demo combinations.

The review template is [config/aws-demo.env.example](config/aws-demo.env.example). After separate resource/access approval, AWS mode requires `CAPTIONDOOR_DB_MODE=aws`, `CAPTIONDOOR_ENV=remote-demo`, an approved `AWS_ACCOUNT_ID`/`AWS_REGION`, all three explicit `CaptionDoorDev…` table names and an approved non-root temporary identity through the normal SDK chain. It skips Local `.env` loading and rejects endpoint overrides, local dummy credentials, root and account mismatches. Do not source the Local `.env` or configure the existing root profile as app identity.

The focused plan creates only **three tables, two `KEYS_ONLY` GSIs, TTL and a Runtime `KEYS_ONLY` stream**, with a 5,000ms Mac worker poller. No full application stack, IAM grant, seed or private-content migration has been executed. Account `256604024085` was observed read-only; Region `us-east-1` is proposed and the exact trusted non-root principal is unresolved. The estimate is **$1.2148/month** for the runbook workload, before tax/transfer and without assuming free credits. The proposed $5/month review allowance is unapproved and is not a hard cap. Follow the [runbook](docs/remote-dynamodb-runbook.md) before activating any remote access or write.

## Try the complete journey

1. `/demo` → **A visitor rings**. This signs LOCAL fixture bytes and uses the same HMAC normalization and DynamoDB transaction path. It is not the official Ring Playground.
2. On the home screen choose **I'll handle this.** Claiming sends nothing.
3. In the visit choose **Start Demo transcript** after consent. Its revisable fixture ends with **Do not leave it.** Finalized means the segment ended, not that recognition is verified.
4. Read the captions and handle the visit in person. This local scenario does not actually capture a visitor or perform an in-person action. Media can expire while responsibility and permitted caption history remain.
5. Choose a closure outcome and **Close visit**. A timeout never establishes departure.

Optional visitor text: open **Visitor text (optional)**, send a fictional request from the private visitor browser and explicitly **Associate thread**. Edit a preset, then choose **Send to visitor page**. ACCEPTED, DISPLAYED and explicit **Got it** confirmation are separate. A QR scan or nearby timestamp establishes neither identity nor presence. No visitor page is needed for the primary caption journey.

The other local cards exercise unavailable media and duplicate semantic deliveries. Real tests cover concurrent claims, stale handler/audio fences, expiry, worker restart, guest disconnect/reconnect and tenant denials. The under-three-minute walkthrough is in [docs/demo-script.md](docs/demo-script.md). The current114-second caption-first Local rehearsal is saved at `output/demo-caption-first-20261023/CaptionDoor-caption-first-demo.mp4`; it labels synthetic sources and does not claim Ring/AWS provider proof.

A visitor without a phone may supply incoming audio for available captions, but cannot receive these web replies. The app never speaks through a Ring speaker, unlocks a door, monitors continuously, identifies faces/emotions, diagnoses emergencies or sends automatic/LLM replies. The app does not record audio/video or request a resident/visitor microphone.

## Commands and verification

```sh
corepack pnpm check
corepack pnpm test:integration
corepack pnpm exec playwright install chromium
corepack pnpm test:e2e
corepack pnpm judge:replay
# Full application architecture template; not a database-only deployment:
corepack pnpm infra:synth
```

The credential-free `judge:replay` command runs one synthetic journey through actual local services, preserves nonzero failures and writes a new timestamped evidence directory per attempt. It refuses production/provider modes and existing active demo visits; deliberately close the current local visit first. See [docs/judging-replay.md](docs/judging-replay.md). The current replay passed in14.3s; evidence is in `output/judge-replay/2026-10-23T12-07-23-610Z-88eb48` (LOCAL/FIXTURE only). The earlier BLOCKED run and active-visit refusal remain in the verification log. It establishes LOCAL/FIXTURE behavior only.

Integration tests require the real local database on port 8410; browser tests also require web 3410 and worker 3411. Their guards refuse AWS/nonlocal database modes, even if the app origin is loopback. They create isolated fixtures/threads. `test:recovery` requires the main CaptionDoor worker to be stopped first; it starts/stops only its own child worker and refuses an occupied port. It verifies a durable job across a real process restart. These suites are not a remote smoke test.

`corepack pnpm build` compiles production Next artifacts with explicit OIDC/live/AWS modes and synthetic account/Region/table metadata, making no SDK/provider calls. That metadata is for compilation only; runtime still requires actual approved production configuration. Production does not permit the local demo environment. Cloud SDK/provider calls remain opt-in; no successful cloud/device behavior is inferred from fixture tests or synth.

The separate `infra:database:synth` prepares only the three-table development template with explicit account/Region metadata and lookups disabled. `db:verify --help` describes the read-only AWS readiness check; running `db:verify` contacts STS/DynamoDB and belongs to the approved access stage. See the [runbook](docs/remote-dynamodb-runbook.md) for the offline synth command and gated sequence.

See [docs/test-results.md](docs/test-results.md) for exact observed commands, pass/fail/skip history, screenshots and single-run latency observations. WCAG 2.2 AA is a design target, not certification. Chromium checks include 320px, keyboard/focus, 48px controls, reduced motion, effective 320px reflow at 200% zoom and axe. Physical Safari/iOS and real provider/device paths require separate validation.

## Boundaries and storage

The pnpm workspace contains `apps/web` (Next App Router resident PWA, guest page and HTTP APIs), `apps/worker` (single long-running authenticated WebSocket/audio/job worker), browser-safe `packages/domain`/`contracts`, DynamoDB `packages/db`, provider `packages/integrations`, `infra/cdk`, fixtures and tests.

DynamoDB is the **only persistent application database**. Local names are `CaptionDoorConfig`, `CaptionDoorVisits`, `CaptionDoorRuntime`; the isolated AWS development proposal uses `CaptionDoorDevConfig`, `CaptionDoorDevVisits`, `CaptionDoorDevRuntime`. There is no SQL/Prisma/Postgres/SQLite/Supabase/Redis or in-memory persistence substitute. State, idempotency, audit and outbox writes are atomic. Base-table strong reads and conditional versions authorize decisions; GSIs are discovery mechanisms. Each final caption/message is its own item. Application expiry is enforced before delayed TTL cleanup; explicit durable deletion removes content copies.

Local jobs use a bounded due-index poller and the same handlers. The proposed database-only AWS development mode keeps that single Mac poller, defaulting to 5,000ms, with no deployed stream consumer. This is a transport substitute, **not Streams/SQS validation**. The separate full AWS architecture uses KEYS_ONLY Streams → filtered Lambda → SQS job keys only → Node worker, with due-index recovery, conditional leases/retries and DLQ. One worker is the supported MVP; replicas need shared fan-out because SQS competing consumers do not broadcast.

The service worker caches only a public offline page/icon. It does not cache private API responses, transcripts, media, tokens or session pages. Offline visibly means no live alerts.

## Real integration prerequisites

`.env.example` documents Local defaults and optional provider fields; it is not an approved AWS runtime configuration. Use only approved protected runtime configuration for real credentials, with temporary AWS identity through the normal SDK chain. Never use `NEXT_PUBLIC_`, localStorage, screenshots, logs or committed files for secrets. The local fixture HMAC key is separate from a real Ring partner HMAC key.

- **Cognito**: configure issuer/client/secret and HTTPS callback. OIDC is separate from Ring linking. A trusted operator must initially provision the owner identity/household. Owner-created invitation codes are one-use/expiring, bound to a verified Cognito subject at acceptance, and capped at two active members; no email is sent automatically. The local seed already contains two residents.
- **Ring Playground**: explicit `RING_MODE=playground` and an actual authorized short-lived token. Hardware or simulator use must include observed substantial Ring technology; organizer guidance allows a self-built simulator with that real integration evidence. LOCAL-only fixtures and intercepted tests do not supply it. There is no fallback to LOCAL. See the submission checklist for source links and mixed-provenance limits.
- **Ring live**: approved invitation-only partner access, OAuth credentials, registered HTTPS callback/webhook and signing key, selected authorized device. Tokens are encrypted before persistence; link completion is explicit. KMS is required in production; a separately generated AES-GCM key is available only for deliberate development linking.
- **Transcribe**: explicit `TRANSCRIBE_MODE=aws`, approved `TRANSCRIBE_AWS_ACCOUNT_ID`/`TRANSCRIBE_AWS_REGION` and temporary SDK credentials/IAM (non-root by default; a separately authorized fixed Local-only root test uses a durable 90-second budget and server deadline, documented in the provider runbook), separate transcription consent and a selected incoming remote audio track. AudioWorklet resamples to actual mono 16kHz signed PCM16LE, 100ms chunks. Missing audio/expiry/provider failure leaves text available.
- **Web Push**: VAPID configuration and explicit browser opt-in/test. Provider acceptance does not mean the user saw or acknowledged anything. iOS/iPadOS requires an installed Home Screen web app and a user gesture.

No cloud/device prerequisites are fabricated. See [docs/integration-contracts.md](docs/integration-contracts.md), [docs/compatibility-matrix.md](docs/compatibility-matrix.md), [docs/security-and-privacy.md](docs/security-and-privacy.md), and [docs/assumptions-and-blockers.md](docs/assumptions-and-blockers.md). The prepared `corepack pnpm smoke:provider` command defaults to zero-network preflight; actual provider execution is unapproved/unobserved. Exact approval, cost, isolated setup and evidence boundaries are in [docs/playground-audio-proof.md](docs/playground-audio-proof.md). General provider smoke prerequisites are in [docs/ring-smoke.md](docs/ring-smoke.md), and factual developer feedback is in [docs/tool-feedback.md](docs/tool-feedback.md).

## Troubleshooting and reset

- Docker connection error: start the installed Docker/OrbStack application, then rerun setup. The application never changes system trust or asks you to disable Ring encryption.
- Port conflict: inspect the exact port and stop only this project's own process/container. Do not kill SayGo/Sway or reuse their database.
- Missing database mode: rerun `setup:local` for the preserved Local setup, or deliberately select an approved AWS target using the runbook. Do not add dummy credentials or endpoint overrides to AWS mode.
- Missing local signing key: rerun setup and restart web/worker. No key is printed.
- 503 provider configuration: read the visible error and configure the named provider explicitly; local text/demo remains independent.
- 409 command conflict: refetch the current visit; exactly one resident can win a claim. A pending handoff keeps the original resident responsible.
- Captions stop: check consent, incoming track, active lease, media expiry and connection. Reconnect reloads strong state plus paginated history; it does not replay delayed audio as live.
- Guest refresh retains only that browser's thread. A different browser gets a different thread. Expired/revoked cookies cannot restore content merely because TTL has not run.

`corepack pnpm demo:reset` is destructive **only to CaptionDoor's exact local tables**. It refuses AWS/nonlocal modes, unexpected endpoints/ports/table names and production. Use it only to reset this controlled demo; normal setup preserves existing data. It does not delete shared services or Docker volumes from other projects.

New code is MIT; dependency licenses/notices remain in installed packages. See LICENSE and THIRD_PARTY_NOTICES.md. The user subsequently authorized the separate [private GitHub source repository](https://github.com/Xuefeng-Zhu/CaptionDoor). Public visibility, billable deployment and hackathon submission remain unauthorized. Repository verification is recorded in docs/test-results.md.
