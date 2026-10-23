# Assumptions and remaining evidence gates

Updated **2026-10-23**. The [README](../README.md) summarizes the product; the [verification log](test-results.md) preserves dated commands and historical failures. This page describes the current scope and outstanding evidence, rather than earlier machine-specific access blockers.

## Product scope

The MVP supports one selected door, two resident members, English, one worker and one AWS Region. Its primary journey is visible alert → explicit claim → explicitly started incoming captions → in-person handling → recorded closure. Visitor text and resident-approved web replies are optional. There is no Ring speaker reply, door unlocking, continuous monitoring, identification, emergency diagnosis or autonomous reply.

A public QR code is an entrance, not identity or presence proof. Each guest browser has a separately scoped secret and thread. The resident explicitly associates it. A handler is responsible for the application visit; the app does not identify the physical person at the door. No timeout proves departure.

Ring processing, transcription and sharing require separate consent. A finalized caption is not verified recognition. Retention changes apply to newly created content; existing content keeps its assigned expiry unless deleted. Sharing withdrawal and membership revocation fence access and capture; responsibility still requires explicit authorized handling. Application expiry and physical deletion are separate observations.

## Local baseline

The default setup needs no provider credentials. Only Compose project `captiondoor_local` and loopback ports 3410/3411/8410, optionally 3443, belong to this development environment. Setup preserves existing data. See [local development](local-development.md) for startup, tests and shutdown.

The local sign's loopback URL works on the Mac. A phone QR test requires an intentionally configured reachable HTTPS origin. No public application host, tunnel or system-trust change is established by local tests. Source is public at [Xuefeng-Zhu/CaptionDoor](https://github.com/Xuefeng-Zhu/CaptionDoor); public source is separate from deployment or hackathon submission.

## Latest provider checkpoint

The dedicated remote provider stack and fictional seed setup completed on 2026-10-23. One authorized attempt reached official Playground discovery but finished **SKIP: INCOMING_AUDIO_NOT_OBSERVED_WITHIN_BOUND**, with coordinator **BLOCKED / exit 2**. The harness observed no incoming audio/video tracks, PCM or AWS final captions, and did not start Transcribe capture. Its exact media/signaling failure cause was not recorded. Later diagnostic improvements do not retroactively establish that cause.

Strong reads verified absence of that run's own AWS visit/runtime content and encrypted cleanup copy. Provider DELETE and provider expiry remained unobserved. Owned processes stopped; retained tables and budget metadata remain. The single approved attempt is exhausted, and the prior Local paid scope is retired. No zero counter or historical command authorizes a retry. See [remote-provider-session.md](remote-provider-session.md) for scope, receipts and limits.

The separate `remote-demo` three-table database proposal remains unexecuted. Its ordinary non-root identity requirement is unchanged; the dedicated provider test exception does not authorize general root application access. See [the remote DynamoDB runbook](remote-dynamodb-runbook.md).

## Remaining gates

| Gate                                   | Current evidence and next requirement                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Incoming Ring media and AWS captions   | No observed successful track-to-PCM-to-final-caption journey. A future separately authorized test needs sanitized media/ready diagnostics and actual incoming audio.      |
| Real Ring event delivery               | LOCAL feeder events and discovery do not establish a registered webhook, partner HMAC delivery or live timing.                                                            |
| Live linking and credential encryption | Mock/local transaction tests cover OAuth and AES boundaries. Actual partner linking and KMS remain unverified.                                                            |
| Production login and initial owner     | Cognito sign-in and trusted owner/household provisioning need an authorized production identity; fictional seed/auth is rejected in production.                           |
| Cloud job dispatch                     | Local and remote Mac pollers do not validate Streams → Lambda → SQS/DLQ delivery or IAM.                                                                                  |
| Push and physical browsers             | VAPID/provider delivery, installed iOS PWA behavior, physical Safari and assistive-technology testing remain unverified.                                                  |
| External erasure and billing           | Own-data absence is verified only for the completed test's exact keys. Provider/backup erasure and actual billing are separate observations.                              |
| Submission                             | Substantial Ring-runtime demonstration and remaining event requirements need review; no submitted entry is recorded. See [submission readiness](submission-checklist.md). |

Prior registration, browser-control and expired-login checkpoints are historical in [test-results.md](test-results.md) and [ring-access-checkpoint.md](ring-access-checkpoint.md). They should not be presented as current failures. No credential/hardware skip is a pass, and no immediate provider/backup erasure is promised.
