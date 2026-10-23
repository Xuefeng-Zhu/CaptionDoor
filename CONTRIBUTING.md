# Contributing to CaptionDoor

Start with the [README](README.md), [local development guide](docs/local-development.md) and [architecture](docs/architecture.md). The credential-free local demo is the default development target. Follow [AGENTS.md](AGENTS.md) and any instructions beneath the directory you change.

## Make a change

1. Fetch origin and fast-forward the base branch when safe. Preserve existing checkout work and use a focused branch for your change.
2. Keep persistent application state in DynamoDB. Browser-safe types belong in `packages/domain` or `packages/contracts`; database and provider SDKs stay server side. Runtime request/job paths must use known keys/index queries, not table scans.
3. Preserve explicit claim, caption start, reply send, handoff acceptance and closure. Keep event, media and transcript provenance distinct, including in screenshots and docs.
4. Run the checks that cover the change. `corepack pnpm check` covers TypeScript and unit tests; persistence changes also need actual DynamoDB Local integration tests. UI/API/socket changes need the relevant browser journey with running local services.
5. Describe the behavior, evidence and remaining limits in your pull request. Do not report a mock or fixture as provider/device success. Include failed or skipped layers when material.

For script details and additional checks, see [local development](docs/local-development.md#check-a-change). Format edited files with the workspace's Prettier configuration; avoid unrelated formatting churn. Documentation links should work from a fresh clone, and local `output/` receipts should be described as untracked operator evidence.

## Protect runtime data

Never commit `.env` variants, credentials, signing/encryption keys, authentication captures, logs, private visitor text, raw SDP or audio/video. `.env.example` contains placeholders only. Use the isolated `captiondoor_local` Compose project and its documented ports. Do not stop or repurpose other projects or shared services.

Cloud/provider tools are opt-in. A command flag, historical receipt or available credential does not authorize deployment, paid provider use or a new resource grant. Keep source pushes, publication and submission within the repository owner's explicit authorization. New pull requests should be ready for review unless a draft is requested or a known blocker prevents review.

## License

New contributions follow the repository's [MIT license](LICENSE). Preserve third-party notices and verify rights before adding any external media or provider-derived content.
