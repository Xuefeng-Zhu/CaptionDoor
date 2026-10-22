# Ring access discovery checkpoint

Evidence date: **2026-10-22 UTC**. CaptionDoor was handled alone; DoorDesk and CaptionDoor application containers remain stopped. No provider token, password, OAuth grant, account configuration or paid service was created or used.

## Observed local readiness

- CaptionDoor is configured for `RING_MODE=demo`.
- Presence-only inspection of the existing `.env` and command environment found no configured Playground token, Ring client ID/secret, partner HMAC secret, registered callback, development credential-encryption key or KMS key identifier. Values were not printed or copied.
- The existing Ring adapter remains implemented. Focused local mocked checks passed: `corepack pnpm exec vitest run tests/unit/ring.test.ts tests/unit/browser-ring.test.ts --maxWorkers=1` → **17/17**, two files,215ms. These tests made no real Ring/AWS request and are not provider evidence.

## Observed browser gate

The supported browser is **Chrome**, browser ID1. The CaptionDoor-owned session is **🔎 CaptionDoor Ring access**, held tab ID **1626947194**, marked for user handoff.

The official [Ring Developer Playground](https://developer.amazon.com/ring/console/playground) opened using an existing signed-in Amazon Developer session but redirected to **Amazon Developer Registration**. The visible form asks for legal name, primary email, customer-facing business name, individual address, support email and phone information. It presents **Agree and Continue** and the **Amazon Developer Services Agreement**. No personal field value was inspected, entered or reported. No agreement or registration was submitted.

**Current blocker:** user completion/review of Amazon Developer registration. This is not a provider API denial or evidence of Ring ineligibility. No consequential operation has an uncertain outcome: none was attempted. The page remains available for the user to complete directly; do not request passwords, address details or tokens in chat.

## Next steps and separate approval boundaries

1. The user must review the registration requirements and agreement directly on the held official page, supply their own appropriate details and decide whether to complete registration. This transmits their registration details to Amazon and accepts legal terms. The agent must not silently submit it.
2. After completion, inspect the official Playground read-only. Do not infer eligibility from a successful Amazon sign-in alone.
3. Immediately before **Generate Token**, obtain specific approval: it creates an approximately30-minute Playground credential. Public docs say Playground does not need Ring app registration, client credentials, account linking or an active Ring subscription; that does not remove the observed Amazon Developer registration gate.
4. Obtain specific approval before copying/transferring or configuring the token, including exact destination, use and lifetime. Never use chat, command-line arguments, screenshots, logs, Git or browser storage for secret transfer. Ongoing `.env` or encrypted-storage configuration is a separate action from temporary in-memory validation.
5. Before transmitting a bearer token, obtain approval for the exact read-only scope and destination: documented Ring API operations such as `GET /v1/users/me`, `GET /v1/devices?include=capabilities,status`, and selected-device details/configuration at `https://api.amazonvision.com`. No account-link, refresh, unlink, WHEP media, scenario or AWS operation is included merely by approving metadata reads.
6. Media/scenario creation, OAuth grants, callback/app configuration, identity verification, credential persistence or AWS/Transcribe paid operations need their own concrete authorization. Never disable encryption or create public infrastructure to bypass access gates.

## Primary-source recheck

- [Official sample](https://github.com/AmazonAppDev/ring-api-helloworld): Playground entry and short-lived token flow; no app OAuth/client credentials needed for that mode.
- [Release notes](https://developer.amazon.com/docs/ring/release-notes.html): latest listed entry September21; May28 documents Playground simulation without account linking/active Ring subscription.
- [Developer FAQ](https://developer.amazon.com/docs/ring/developer-faq.html): current private apps allow up to10 authorized accounts; historical July21 release text says five. Private real-device access requires subscription/trial; Playground exemption is separate.
- [Current API](https://developer.amazon.com/docs/ring/api-documentation.html): partner-initiated OAuth remains invitation-only. WHEP requires video, optional incoming audio, all recvonly, no speaker reply. TAKE/E2EE restrictions stay visible.

Actual Ring runtime evidence remains absent. LOCAL replay and intercepted tests do not change that status. The browser tab is the current handoff target; this file contains no account identity, token or personal registration data.
