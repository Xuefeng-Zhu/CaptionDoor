# Local development

The default demo needs no Ring account or AWS credentials. It uses real DynamoDB Local, fictional identities, simulated doorbell events and fixture captions. Use Node 24 from [`.nvmrc`](../.nvmrc), Corepack, pinned pnpm 12.14.0 and a running Docker-compatible runtime.

## Start from a clone

```sh
git clone https://github.com/Xuefeng-Zhu/CaptionDoor.git
cd CaptionDoor
corepack pnpm install --frozen-lockfile
corepack pnpm setup:local
corepack pnpm dev
```

Setup creates the exact local tables `CaptionDoorConfig`, `CaptionDoorVisits` and `CaptionDoorRuntime`, their indexes and missing fictional seed rows. It preserves existing records and creates an ignored `.env` with a local fixture signing key if needed. Never commit that file. The defaults are documented in [`.env.example`](../.env.example).

Open [onboarding](http://127.0.0.1:3410/onboarding), select Alex and review the independent consents. Sam is the other household member; use a separate browser profile. Jordan is in a different household. Create a fixture event from [/demo](http://127.0.0.1:3410/demo). Optional guest text is at [/door/front-demo](http://127.0.0.1:3410/door/front-demo) in a private window. See [the demo script](demo-script.md) for the complete journey.

| Port | Purpose                        |
| ---- | ------------------------------ |
| 3410 | Web and HTTP API               |
| 3411 | Worker WebSocket and `/health` |
| 8410 | DynamoDB Local                 |
| 3443 | Optional HTTPS proxy           |

The Compose project is always `captiondoor_local`, with its own volume and loopback host bindings. Do not reuse a shared database or stop another project's process to free a port.

## Run the application in containers

Use either host development processes or application containers on 3410/3411. Stop this checkout's host `pnpm dev` with Ctrl-C before starting containers:

```sh
corepack pnpm setup:local
docker compose -p captiondoor_local --profile app up --build -d
curl --fail http://127.0.0.1:3410/api/health
curl --fail http://127.0.0.1:3411/health
```

Normal Compose explicitly selects local database, demo authentication, simulated Ring and fixture transcription. A healthy response is startup evidence, not a successful journey or provider observation. After code changes, rebuild application containers; after `.env` changes, restart host processes or recreate containers.

The optional `https` profile uses Caddy's private CA on 3443. It does not install system trust. See [architecture](architecture.md) and [Caddyfile](../Caddyfile) before configuring HTTPS. A phone cannot reach the Mac through its own loopback address; a phone QR test needs an intentionally configured reachable HTTPS origin and matching WebSocket/session settings.

## Check a change

| Command                                          | Prerequisites and meaning                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `corepack pnpm check`                            | TypeScript and unit suites; provider/SDK transport may be mocked                           |
| `corepack pnpm test:integration`                 | Actual DynamoDB Local on 8410; guards reject AWS/nonlocal targets                          |
| `corepack pnpm exec playwright install chromium` | Downloads the browser once; network required                                               |
| `corepack pnpm test:e2e`                         | Local web, worker, database and Chromium; real local API/socket journey                    |
| `corepack pnpm judge:replay`                     | Same local services; close active demo visits first; unique evidence directory per attempt |
| `corepack pnpm test:recovery`                    | Stop the main worker first; owns a child worker on 3411 and verifies restart durability    |
| `corepack pnpm build`                            | Production compilation and private-file/browser-SDK packaging checks; no provider calls    |
| `corepack pnpm build --webpack`                  | Supported alternative compiler for environments where Turbopack IPC is unavailable         |
| `corepack pnpm infra:synth`                      | Generates the full architecture template in ignored `output/cdk`; does not deploy          |

The build supplies synthetic production account/Region/table metadata and strips inherited AWS credentials. A successful build does not mean the production runtime is configured. If a restricted tool environment blocks the `tsx` launcher's IPC socket, `node --import tsx scripts/build.ts --webpack` runs the same build script without that launcher; it does not bypass runtime authorization.

Record the exact command, revision, outcome and skipped layers in [test-results.md](test-results.md). Generated reports live under ignored `output/`; preserve failed attempts and do not commit screenshots, traces, tokens or private content. See [judge replay](judging-replay.md) for its evidence format.

## Stop and preserve data

For host development, Ctrl-C stops the owned web/worker children. Stop only this project's remaining containers when finished:

```sh
docker compose -p captiondoor_local --profile app stop web worker
docker compose -p captiondoor_local stop dynamodb
```

If the optional proxy is running, stop it with `docker compose -p captiondoor_local --profile https stop proxy`. Alternatively, `docker compose -p captiondoor_local --profile app --profile https down` removes this project's containers/network while retaining named volumes. Do not add `--volumes` to a normal shutdown or run a global Docker prune.

`corepack pnpm demo:reset` **deletes and recreates only the three validated local application tables**. It refuses production, AWS/nonlocal modes and unexpected endpoints, ports or table names. Use normal setup for routine restarts; reset only when you intend to discard this demo's data.

## Troubleshooting

| Symptom                                     | Action                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Docker socket missing or connection refused | Start Docker/OrbStack normally, then rerun setup. A shared-runtime restart needs coordination with any other running projects.                   |
| Port already occupied                       | Identify the listener and its owner. Stop only CaptionDoor's own conflicting process.                                                            |
| Missing/incompatible database mode          | Use the preserved Local setup or an explicitly configured approved AWS target. There is no implicit fallback.                                    |
| Missing local signing key                   | Rerun setup and restart web/worker; do not print or paste the key.                                                                               |
| HTTP 409 after a claim or handoff           | Reload current visit state; conditional versions allow only one winning handler.                                                                 |
| Captions stop                               | Check consent, incoming track, active lease, expiry and connection. Reconnect reloads permitted history without replaying delayed audio as live. |
| Provider configuration returns 503          | Configure the named provider explicitly. Simulated local mode is a separate choice.                                                              |
| Guest refresh cannot restore a thread       | Only that browser's unexpired scoped cookie restores its thread; another browser has a different thread.                                         |

## Keep cloud modes separate

`remote-demo` retains fictional auth/events/captions while moving only persistence to separately approved AWS tables. Its [runbook](remote-dynamodb-runbook.md) remains a proposal. `remote-provider` is the dedicated bounded provider-test namespace whose completed attempt is documented in [remote-provider-session.md](remote-provider-session.md). Neither mode is activated by local setup.

Do not source Local `.env` into AWS mode, add dummy credentials to an AWS target, reset a provider ledger or reuse historical approval flags as permission to make another paid call. Runtime credentials belong in approved protected process configuration, never source or browser variables.
