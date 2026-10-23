# Official Playground audio and caption proof

Updated **2026-10-23**. One authorized remote provider attempt completed after dedicated AWS database setup and official Playground device discovery. It recorded **SKIP: INCOMING_AUDIO_NOT_OBSERVED_WITHIN_BOUND**; the coordinator returned **BLOCKED / exit 2**. No incoming tracks, PCM or AWS final captions were observed, and the harness did not start Transcribe capture. The precise media failure cause was not recorded; the later diagnostics change applies only to future runs.

Exact own-content and encrypted-cleanup-copy absence in AWS was verified. Ring DELETE and expiry remained unobserved. See [the remote provider checkpoint](remote-provider-session.md) for the completed run, retained resources, budget baseline and cleanup evidence. The single authorized attempt is exhausted. A second run requires fresh authorization; this documentation update makes no provider call.

## Which procedure applies

- **Credential-free local demo:** use [local development](local-development.md) or [judge replay](judging-replay.md). These use LOCAL events and fixture captions.
- **Completed remote provider test:** read [remote-provider-session.md](remote-provider-session.md). Its receipts are ignored operator-local evidence, not files shipped in a clone.
- **Former Local paid test:** [provider-session.md](provider-session.md) is historical. Its scope was retired during the approved remote migration; do not remove its marker, reset its ledger or run the old command to obtain another attempt.

## Historical Local preparation and acceptance criteria

The material below preserves the earlier Local procedure and budget rationale. References to pending access, no prior requests, token generation or active Local approval describe that preparation checkpoint. They are superseded by the completed remote checkpoint above and do not represent current permission to execute. General evidence boundaries still apply: label event, media and transcript provenance separately and never substitute fixture/resident-microphone audio for missing incoming Ring audio.

## Budget approved; access and execution prerequisites pending

The user approved **$10 total for the current CaptionDoor AWS transcription verification** on 2026-10-22. This replaces the earlier proposed $0.10 operator allowance. It is separate from any DynamoDB or SayGo budget and is not a spending target. No AWS budget resource or hard cap has been provisioned. No Ring/Transcribe call has started; cumulative estimated transcription charges are **$0.00 of $10.00**. The STS identity reads are separate from streaming evidence.

The user subsequently confirmed the short-lived Ring access and AWS identity-check step. This permits only the described metadata/receive-only WHEP scope; no token has been generated or received by the agent. Before execution, resolve the remaining applicable prerequisites below. Neither that confirmation nor the budget authorizes new IAM credentials/grants, persistent access, unknown portal terms or changes to the root guard. Current identity and account checks passed in process-only `us-east-1`; Transcribe authorization and execution remain unverified. Root is authorized only through the explicit one-off Local test exception below. An environment flag records the operator's acknowledged scope; it is not itself human approval.

1. The short-lived token access is confirmed, but inspect the actual token screen and disclose its scope, expiry and any new terms before generation/intake. Stop for a materially broader request or new agreement. Generate only one Playground token (documented lifetime about 30 minutes) and securely transfer it to temporary backend process configuration. The token is not a read-only-scoped credential: restrict this test to account/device/configuration reads and selected-device receive-only WHEP POST/DELETE. No OAuth grant, refresh, unlink, app registration or physical-device scenario is included.
2. Generate a temporary 32-byte development encryption key and permit an encrypted access-only cleanup copy in the dedicated Local Runtime table. The original token/key stay in server process memory, outside git, URLs, browser storage, screenshots, logs and command-line arguments. The cleanup copy is bound to WHEP DELETE, device and media session, with at most 60 seconds validity; physical removal can lag expiry during an outage. Request and observe its deletion separately. Never promise RAM-only handling for this existing cleanup path.
3. For the caption stage only: recheck the same AWS identity/account/Region immediately before execution. The 2026-10-23 CLI and installed SDK checks passed for `256604024085` / ROOT with `us-east-1` supplied only to their processes; no persistent Region was configured. This is identity proof, not proof of `transcribe:StartStreamTranscription` permission. Non-root remains the normal app default; the user explicitly permits root for the narrow Local exception described below. Creating IAM roles/keys, a new login grant or persistent credential configuration requires separate approval if later needed. Required runtime action: `transcribe:StartStreamTranscription` on `*` (this operation has no resource-level ARN), restricted to the approved Region; no S3, model, analytics or administrator permissions. A bounded read-only STS identity check uses the same SDK credential provider before capture becomes ready; root acceptance additionally requires the worker-issued test permit. [AWS action permissions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_transcribe.html).
4. Keep the initial verification at most three media attempts of 30 seconds each and **90 seconds of Standard Streaming Transcribe total**, including bounded retries. The approved **$10 total** is a ceiling for this verification, not permission to expand the initial test or make unnecessary calls. At $0.024/minute, 90 seconds is approximately **$0.036**. Standard streaming is billed in one-second increments with no minimum; no free-tier credit is assumed. The approved ceiling is not an AWS hard cap or a provisioned budget. Each harness run makes one attempt; the operator must track duration and cumulative estimated charges across runs and stop at the initial duration limit or budget limit, whichever applies first. Additional testing still requires a concrete need and satisfied access prerequisites. [Published pricing](https://aws.amazon.com/transcribe/pricing/), [official rate example](https://aws.amazon.com/blogs/machine-learning/live-meeting-assistant-with-amazon-transcribe-amazon-bedrock-and-strands-agents/). Ring portal terms/fees must be checked separately; they were not observed.

Do not send passwords, bearer tokens, keys or session credentials through chat. Use the supported hidden-terminal handoff; stop if a new agreement, permission, sensitive identity or security prompt appears. No paid stream may start until the remaining token, selected-device, encryption/cleanup and execution prerequisites are satisfied; the worker must still verify identity for the actual attempt.

## Isolated setup after approval

Preserve the normal `.env`, `CaptionDoor*` tables and Docker volume. Prepare a separate temporary process environment with:

| Setting                                               | Required value / meaning                                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `CAPTIONDOOR_ENV`, `CAPTIONDOOR_DB_MODE`, `AUTH_MODE` | `local`, `local`, `demo`; never production                                                                            |
| `APP_ORIGIN`                                          | Exactly `http://127.0.0.1:3410`                                                                                       |
| `DYNAMODB_ENDPOINT`                                   | Host loopback `http://127.0.0.1:8410`                                                                                 |
| Table variables                                       | Same explicit `CaptionDoorProviderSmoke…` prefix plus `Config`, `Visits`, `Runtime`; never original app or AWS tables |
| `RING_MODE`, `CAPTIONDOOR_PROVIDER_SMOKE`             | `playground`, `1`                                                                                                     |
| `RING_PLAYGROUND_TOKEN`                               | Approved short-lived secret, backend only                                                                             |
| `CREDENTIAL_ENCRYPTION_MODE`, `DEV_CREDENTIAL_KEY`    | `development`, approved temporary Base64 32-byte key                                                                  |
| `CAPTIONDOOR_SMOKE_DEVICE_ID`                         | Authorized selected device, not guessed from a public door ID                                                         |
| `TRANSCRIBE_MODE`                                     | `fixture` for `ring-audio` (capture never started); `aws` for `captions`                                              |
| `CAPTIONDOOR_SMOKE_APPROVAL`                          | Exactly the approved stage, `ring-audio` or `captions`                                                                |
| Caption-stage AWS settings                            | Explicit `TRANSCRIBE_AWS_ACCOUNT_ID`, `TRANSCRIBE_AWS_REGION` and approved temporary normal SDK credential source     |

Use the repository's table creation/fictional seed functions only under that guarded dedicated namespace. They create Local tables, not remote resources. Start only CaptionDoor web/worker with the same isolated settings. The ordinary Compose application service pins demo/fixture modes and is **not** a provider configuration. Do not run destructive reset, copy private content/sessions, or place real secrets into a checked-in example. Temporary identity credentials must reach the worker through an approved mechanism; Local database dummy credentials must never become the Transcribe identity.

Both health endpoints must report `providerSmoke: true`, the same guarded `providerSmokeTablePrefix`, Local database/demo auth/Playground mode and stage-matching transcription. Normal demo health reports false and the feeder denies requests.

## Reproducible stages

The default command is a **zero-network presence/configuration preflight**. It does not resolve credentials, contact STS/Ring/AWS, create tables, seed or start services:

```sh
corepack pnpm smoke:provider --help
corepack pnpm smoke:provider --stage ring-audio
corepack pnpm smoke:provider --stage captions
```

BLOCKED exits 2 with sanitized categories. READY means local configuration passed, not authorization or provider validation. Only after the exact stage has been approved and the isolated services are ready may the operator add `--run`. Never run the provider Playwright configuration directly to bypass CLI prerequisites.

The bounded browser flow signs in as a fictional owner, checks both health contracts, obtains real account/discovery/configuration data through the existing adapter and selects the approved device. It creates a local event through authenticated `POST /api/provider-smoke/press`, with tenant/owner/consent checks and transaction fences. **Event provenance remains LOCAL**. It explicitly claims responsibility and starts required video plus optional receive-only audio. Signaling success alone is insufficient: observe actual connected tracks. `ring-audio` never requests AWS capture. `captions` requires real remote audio and an explicit start action; the worker verifies the approved SDK identity before authorizing PCM. Non-root is the normal default; the fixed, explicitly authorized Local root exception additionally requires its reservation and single-use permit. Mono 16 kHz PCM uses no `NumberOfChannels` field; AWS supports that field only with two-channel identification. [Streaming API contract](https://docs.aws.amazon.com/transcribe/latest/APIReference/API_streaming_StartStreamTranscription.html).

The caption run must observe nonzero binary PCM transfer and actual AWS final caption persistence. Missing audio, no final recognition, expiry or provider failure is recorded honestly as SKIP/FAIL/BLOCKED. There is no fixture injection, fabricated speech, microphone capture or automatic reply. Finalized remains recognition finalization, not correctness. A Playground simulated media observation is not physical Ring hardware or a verified doorbell webhook.

The harness stops media/capture, records `NO_RESPONSE_RECORDED` closure and requests deletion only for its own generated visit ID. A deletion request/404 does not prove physical cleanup. Separately verify completion of the scoped deletion job and cleanup credential removal; do not inspect or delete unrelated records. Stop the isolated web/worker, discard the original token/key from process configuration and stop only CaptionDoor's Local database when handing off the sequential slot. Preserve the normal data volume and avoid global Docker operations.

## Evidence and remaining gaps

Provider runs write only sanitized outcome, modes/sources, timing/counts and cleanup-request status under `output/provider-smoke/<run-id>/result.json`. Browser traces, screenshots, video, raw audio, caption text, SDP, provider profile/device bodies, cookies and bearer values are excluded. Browser children do not inherit provider/AWS secrets. Local unit/DB/browser passes are recorded in [test-results.md](test-results.md), separately from this still-unexecuted Ring/Transcribe procedure.

On 2026-10-23, six delayed-WHEP race regressions passed using mocked Ring transport and real DynamoDB Local. The authorized Ring client still creates media; a bounded DELETE-only credential copy is prepared before the provider await. Fresh session, grants, consent, handler, door/integration and active media-session conditions then fence atomic admission. A handoff, revocation, expired session or withdrawn camera grant cannot admit the late answer. Failed DELETE retains bounded cleanup metadata and a durable retry rather than resurrecting reusable credentials. These tests do not establish actual provider DELETE behavior. The full Local integration suite passed **86/86 in 19.35s**, `check` passed **361/361 in 2.14s**, and the production build passed.

The official API and release notes were rechecked on 2026-10-23; the latest release remained October 22. WHEP still requires receive-only video, permits optional incoming receive-only audio and limits media to 30 seconds on battery / 60 seconds on line power. CaptionDoor conservatively caps sessions at 30 seconds. No Ring-speaker reply is supported. [WHEP contract](https://developer.amazon.com/docs/ring/api-documentation.html#whep-live-video-streaming), [release notes](https://developer.amazon.com/docs/ring/release-notes.html).

Ring-driven linking remains absent. The current official protocol specifies unsigned form `code`/`client_id` exchange, durable token/account persistence before 200, an unclaimed-account association pool, time-limited signed nonce after explicit partner sign-in, and app-integration completion. Initial failure has no retry. Before implementation, verify provisioned partner endpoints/HMAC key and the stable `Hardware_Id` identity scope for the initial exchange before a partner user is known; do not invent a nonce/account matching shortcut. These partner-only operations are not prerequisites for Playground token testing and are not exercised by this harness. [Current API contract](https://developer.amazon.com/docs/ring/api-documentation.html), [October 22 release clarification](https://developer.amazon.com/docs/ring/release-notes.html).

## Cumulative verification cost ledger

| Checkpoint / run                       | Actual streaming seconds | Estimated charge | Cumulative estimated charge | Status                                                                      |
| -------------------------------------- | ------------------------ | ---------------- | --------------------------- | --------------------------------------------------------------------------- |
| Budget approval recorded, 2026-10-22   | 0                        | $0.00            | $0.00                       | No Ring/Transcribe calls; access prerequisites pending                      |
| Identity/preflight recheck, 2026-10-23 | 0                        | $0.00            | $0.00                       | CLI + SDK STS passed; no Ring/Transcribe calls; three setup blockers remain |

For each later authorized attempt, record a sanitized run ID, actual connected streaming duration, applicable rate, estimated charge and cumulative total, including failed/retried billable streams. Reconcile estimates with AWS billing when available; estimates are not a bill. Do not log audio, transcript text or credentials. Keep the initial combined duration at or below 90 seconds and do not spend the remainder merely because it is approved.

## User-assisted hidden token intake (prepared, not performed)

The checkout has no secret-entry web UI. Its real harness accepts `RING_PLAYGROUND_TOKEN` from process environment. The smallest supported handoff is the user's **interactive Mac zsh terminal**, not chat, a screenshot, a tool-call argument, an environment file or shell assignment containing the token. The current AWS identity checks have passed. Wait until the selected device, approved temporary encryption/cleanup setup and secure portal/terminal handoff are ready so the short token lifetime is not wasted. The official [sample](https://github.com/AmazonAppDev/ring-api-helloworld) says the token works with all Ring APIs; our test restricts actual operations to metadata and selected-device receive-only WHEP. If the portal presents additional terms/permissions, pause and report them before accepting.

Once that handoff is ready, the user can run:

```zsh
cd /Users/frank/mygit/CaptionDoor
set +x
set +v
read -r -s 'RING_PLAYGROUND_TOKEN?Ring Playground token (hidden): '
print
export RING_PLAYGROUND_TOKEN
```

Paste only into that hidden terminal prompt. The value is not a command/history entry, file or command-line argument. It remains in that shell and descendants' process environment; it is not received by this agent merely because the command was supplied. Never run `env`, `printenv`, tracing or token-printing commands. Default `corepack pnpm smoke:provider --stage ring-audio` may then confirm presence/configuration categories without network, but does not validate the token. Do not start providers or the ordinary demo Compose services from this snippet. The dedicated guarded tables, explicit modes, approved temporary encryption key/cleanup handling and selected device still need to be ready; the actual caption attempt must recheck the currently verified AWS account/Region/identity.

The existing host `corepack pnpm dev` launcher inherits explicit environment into web/worker. Normal Compose pins demo/fixture and is not suitable for this provider run. `setup:local` guards the original table namespace; dedicated provider tables must use the existing exported `ensureTables`/`seedLocal` functions under the strict smoke namespace, without reset. No such provider setup or token-entry action was performed in this checkpoint. After authorized cleanup and service shutdown, unset the token/key in the same terminal. Do not unset a still-required cleanup key before its bounded cleanup path is resolved.

## Explicit one-off root exception — prepared, disabled by default

The user expressly approved root for this CaptionDoor test after being told about the app guard. It is not categorically prohibited, and it does not authorize IAM users/keys, broader policies, deployment, permanent access or changes to the ordinary app/production/AWS-database guard. No actual root provider stream has run.

The exact opt-in is `CAPTIONDOOR_ROOT_SMOKE=1` plus `CAPTIONDOOR_ROOT_SMOKE_APPROVAL=captiondoor-root-verification-20261022`, captions-stage approval, AWS transcription mode, expected account `256604024085`, Region `us-east-1` and the fixed `CaptionDoorProviderSmoke20261022Config/Visits/Runtime` Local tables. The fixed scope/namespace prevents a new run ID or table prefix from resetting the approved duration. The account/ROOT identity now match successful 2026-10-23 CLI and installed SDK STS observations with process-only `us-east-1`. This does not establish Transcribe permission or renew the fixed approval/ledger. Normal demo and production reject the exception. Example flags remain disabled.

The worker strongly reauthorizes session, grants, handler, consent, media and capture lease, then atomically reserves 30 seconds in the Local Runtime ledger before identity/paid transport. Reservations are nonrefundable, including uncertain attempts, with **90 seconds total** and a $10 ceiling at 400 microUSD/second. The stricter duration limit bounds the current reservation estimate at $0.036. A persisted budget and attempt records retain only IDs/timing/scope/cost metadata, no tokens/audio/text, with **no TTL** or automatic reset. Do not delete a real ledger to gain further attempts; any deliberate reset/new authorization requires a separate decision. Fictional regression fixtures conditionally remove only their own rows and refuse a pre-existing real budget.

The in-process permit is issued only after reservation, accepted only once, bound to the exact account/Region/scope and expires no later than 30 seconds or the earlier media/lease/session deadline. A server-side timer aborts SDK transport and discards PCM even if the browser fails to stop; deadline checks also guard frame/result handling. Default root rejection remains when there is no permit, including when environment flags alone are set. The authenticated own-visit capture-ready receipt labels verified ROOT versus NON_ROOT only after STS and a fresh lease check. Budget summaries alone do not prove AWS identity or actual billing.

## Historical identity blocker, resolved at the current checkpoint

On 2026-10-22, the bounded STS CLI attempt exited 255, local profile metadata reads exited 253 and no configured Region was returned. Supplying `us-east-1` only to the process then produced `SESSION_OR_CREDENTIAL_EXPIRED` / `AWS_LOGIN_REQUIRED`. At that time, a user-assisted `aws login --profile tally --region us-east-1` was documented as the possible next step. The agent did not initiate login or accept a login/security prompt.

That expired-login diagnosis is historical. On 2026-10-23, both AWS CLI and the installed JavaScript SDK STS checks succeeded using existing access; a new login is **not a current prerequisite**. No agent-created login, new credential, persistent configuration, token receipt, Ring call or Transcribe stream occurred. CaptionDoor has resumed its sequential slot. Current provider execution remains blocked by the missing selected Playground device, token and approved local encryption setup, alongside the locked-desktop/interactive portal limitation. Real estimated streaming spend remains **$0.00 of $10.00**.
