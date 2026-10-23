# Ring access discovery checkpoint

Evidence date: **2026-10-22 UTC**. CaptionDoor was handled alone; DoorDesk and CaptionDoor application containers remain stopped. No provider token, password, OAuth grant, account configuration or paid service was created or used.

## Observed local readiness

- CaptionDoor is configured for `RING_MODE=demo`.
- Earlier presence-only inspection of the existing `.env` and command environment found no configured Playground token, Ring client ID/secret, partner HMAC secret, registered callback, development credential-encryption key or KMS key identifier. Values were not printed or copied.
- The existing Ring adapter remains implemented. Earlier focused local mocked checks passed: `corepack pnpm exec vitest run tests/unit/ring.test.ts tests/unit/browser-ring.test.ts --maxWorkers=1` → **17/17**, two files,215ms. These tests made no real Ring/AWS request and are not provider evidence.

## Historical browser gate

The supported browser is **Chrome**, browser ID1. The CaptionDoor-owned session is **🔎 CaptionDoor Ring access**, held tab ID **1626947194**, marked for user handoff.

The official [Ring Developer Playground](https://developer.amazon.com/ring/console/playground) opened using an existing signed-in Amazon Developer session but redirected to **Amazon Developer Registration**. The visible form asks for legal name, primary email, customer-facing business name, individual address, support email and phone information. It presents **Agree and Continue** and the **Amazon Developer Services Agreement**. Existing name/email prefills were present. No field was changed and no registration or agreement was submitted by the agent. Personal values are omitted from this document.

**Current blocker:** the user has reported completing Amazon Developer registration, but the current execution toolset has no supported Mac browser/computer-control tool. Registration completion, current tab state, portal-specific token permissions, displayed expiry and any new terms therefore remain **unverified**. No UI action was attempted in this resumed check; there is no denied or uncertain token action. This tool limitation is not evidence of registration failure or Ring ineligibility. Last known browser binding was Chrome ID1/tab1626947194; its continued availability has not been observed.

The smallest next step is to restore the supported browser-control tool and inspect the [official Playground](https://developer.amazon.com/ring/console/playground) read-only in the existing signed-in browser, without clicking Generate Token or opening/copying any existing secret. If the user inspects it directly, report only the presence of the access action and nonsecret scope/expiry/terms text; never send a token or screenshot containing one.

## Next steps and separate approval boundaries

1. Verify the user-reported completed registration read-only. Do not repeat or accept an agreement on the user's behalf; the agent did not submit the earlier form. Any newly required agreement or identity step remains a separate gate.
2. After completion, inspect the official Playground read-only. Do not infer eligibility from a successful Amazon sign-in alone.
3. Immediately before **Generate Token**, obtain specific approval: it creates an approximately30-minute Playground credential. Public docs say Playground does not need Ring app registration, client credentials, account linking or an active Ring subscription; that does not remove the observed Amazon Developer registration gate.
4. Obtain specific approval before copying/transferring or configuring the token, including exact destination, use and lifetime. Never use chat, command-line arguments, screenshots, logs, Git or browser storage for secret transfer. Ongoing `.env` or encrypted-storage configuration is a separate action from temporary in-memory validation.
5. Before transmitting a bearer token, obtain approval for the exact read-only scope and destination: documented Ring API operations such as `GET /v1/users/me`, `GET /v1/devices?include=capabilities,status`, and selected-device details/configuration at `https://api.amazonvision.com`. No account-link, refresh, unlink, WHEP media, scenario or AWS operation is included merely by approving metadata reads.
6. Media/scenario creation, OAuth grants, callback/app configuration, identity verification, credential persistence or AWS/Transcribe paid operations need their own concrete authorization. Never disable encryption or create public infrastructure to bypass access gates.

## Primary-source recheck

- [Official sample](https://github.com/AmazonAppDev/ring-api-helloworld): Playground entry and short-lived token flow; no app OAuth/client credentials needed for that mode.
- [Release notes](https://developer.amazon.com/docs/ring/release-notes.html): latest listed entry October 22, including unsigned one-way code delivery/no retry and refresh invalidation; May28 documents Playground simulation without account linking/active Ring subscription.
- [Developer FAQ](https://developer.amazon.com/docs/ring/developer-faq.html): current private apps allow up to10 authorized accounts; historical July21 release text says five. Private real-device access requires subscription/trial; Playground exemption is separate.
- [Current API](https://developer.amazon.com/docs/ring/api-documentation.html): partner-initiated OAuth remains invitation-only. WHEP requires video, optional incoming audio, all recvonly, no speaker reply. TAKE/E2EE restrictions stay visible.

Actual Ring runtime evidence remains absent. LOCAL replay and intercepted tests do not change that status. The last-known browser tab is the intended read-only handoff target, not a freshly verified live page; this file contains no account identity, token or personal registration data.

## Resumed local verification

The initial default-sandbox test attempt could not write Vitest's temporary config cache (`EPERM`); it did not run tests. The same focused fixture tests ran successfully with authorized checkout write access (17/17 baseline,224ms). New regressions then reproduced 13 failures among32 tests; the scoped fixes passed32/32 in 208ms. Full follow-up check results are recorded in [test-results.md](test-results.md). The full `corepack pnpm check` then passed TypeScript and 62/62 unit tests in 1.07s; after final connected-video/audio expiry and lease-latency refinements, it passed 64/64 across 8 files in 1.01s. The initial fixture-only stage started no project runtime or build. The subsequent requested local verification passed 41/41 real DynamoDB tests in 9.94s, 12/12 Chromium browser tests in 45.5s and the production build/packaging checks. Only CaptionDoor services were started and then stopped normally, retaining the database volume and closing 3410/3411/8410. No provider call, credential transfer or push occurred. Repository `.agents/skills` directories were absent; no relevant CaptionDoor/Ring entry was found in the read-only local memory index.

Automated local Playwright worked through the repository runner despite absent interactive Mac Chrome controls. The optional skill helper was missing, but no required local check was blocked by that helper. Current rendered narrow-home and caption-withdrawal screens were inspected. The new browser report is `output/ring-verification/20261022T1005Z/report/index.html`; earlier evidence was preserved. The project slot is ready for sequential handoff. Resume later with `docker compose -p captiondoor_local --profile app up -d web worker` (starts the existing database dependency, preserving data), then check 3410/3411 health. Official Playground inspection and credential approval remain pending.
