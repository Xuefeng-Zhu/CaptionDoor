# CaptionDoor

## Inspiration
A door visit should not depend on hearing a bell or a spoken message. CaptionDoor explores a caption-first interface with clear responsibility, readable text and an optional visitor page.

## What it does
A resident sees a door alert, explicitly claims responsibility, reads revisable captions and can hand the visit to another resident only after acceptance. Visitors can separately choose a browser text conversation without an account. Replies distinguish ACCEPTED, DISPLAYED and explicitly CONFIRMED states. Presets draft a reply; they do not send it. Closing a visit records an outcome rather than claiming that someone has left.

## How we built it
TypeScript, Next.js, React and a dedicated WebSocket/job worker. DynamoDB is the only persistent application database, with conditional writes, tenant-scoped keys, TTL, indexed due work and explicit content deletion. Browser-safe contracts are separate from database and integration SDKs. The reproducible local demo uses real DynamoDB Local and clearly labeled simulated events and synthetic captions.

## Ring and AWS integration: observed status
The repository implements Ring account/device discovery, configuration and receive-only WHEP integration with provider consent and bounded session controls. An authorized temporary Ring Playground token successfully discovered an authorized device in a separate bounded test. That test did not observe incoming media, and AWS Transcribe was not started. The video is explicitly a LOCAL/FIXTURE rehearsal, not a recording of live Ring audio or AWS-generated captions. No physical Ring device success is claimed.

A separate AWS DynamoDB development stack with three dedicated tables was created and its metadata, TTL and bounded fictional writes were verified. Exact owned visit/runtime data and encrypted-token-copy absence were verified after the test; the owned services stopped. Ring DELETE/provider expiry was not independently observed. AWS Transcribe integration is implemented and gated but end-to-end transcription remains unverified.

## Demo and testing
The English on-screen, silent demo shows the simulated bell, claim, Updating/Finalized synthetic captions, media expiry, accepted handoff, optional visitor text, explicit Send, delivery acknowledgement and closure. Judges can reproduce the local workflow without supplying a Ring token: follow README local setup, start only the captiondoor_local Compose project, then run `corepack pnpm judge:replay`. Default demo sources remain clearly labeled. Real-provider testing is separate and opt-in.

## AI assistance
OpenAI Codex assisted implementation, debugging, test development and documentation. The local video uses deterministic fixture captions; it does not depict an AI transcription model operating on real incoming audio.

## Challenges and learning
We separated responsibility from connectivity, recognition finality from truth, delivery from acknowledgement and fixture evidence from provider evidence. Real-provider verification exposed the importance of preserving sanitized HTTP diagnostics rather than treating every missing-track observation as the same failure.

## Next steps
Resolve and re-test Ring media negotiation under a separately approved bounded attempt, then verify actual incoming-audio-to-AWS-final transcription and real device/browser compatibility.
