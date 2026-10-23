# Remote DynamoDB preparation — locally verified, AWS cutover pending

Checkpoint: **2026-10-22 UTC**. Work remains on the Mac at `/Users/frank/mygit/CaptionDoor`. The sequential CaptionDoor preparation is complete and its owned services are stopped; DoorDesk can be prepared next. This checkpoint does not authorize resource creation or establish remote persistence.

## Completed code and local verification

- Explicit `local` / `aws` database selection and `local` / `remote-demo` / `production` environments; no silent fallback. AWS requires an explicit account, Region and all three names in an isolated CaptionDoor namespace, uses the normal credential chain, and rejects custom/local endpoints and Local dummy credentials. Production OIDC/provider restrictions remain intact.
- Lazy expected-account/non-root STS middleware inherited by DocumentClient. Concurrent checks share one promise; failures are sanitized and retryable. A successful check is cached per client/process: restart after changing runtime identity. This is not continuous credential auditing or a replacement for scoped IAM.
- Five-second default AWS due-work polling, separate Local health provenance, guarded Local setup/reset, browser/replay and worker recovery. Recovery checks the actual web health before login/write, because a loopback URL alone does not imply a Local database.
- Pinned STS SDK dependency/lockfile, placeholder-only `config/aws-demo.env.example`, read-only future `db:verify`, and a focused database-only CDK stack. Production build children do not inherit AWS credential providers.
- TypeScript and **227/227 unit tests** passed (12 files, final 1.33s), including 54 configuration, 11 identity, 80 metadata-readiness and 18 focused infrastructure cases. Readiness/identity AWS transport is fixture/mock only.
- Real isolated DynamoDB Local integration: **41/41**, 11.19s. Production build and private-artifact/browser-bundle checks passed. Non-destructive `setup:local` passed; a process selected as AWS was refused before the setup child launched.
- Final Chromium suite: **12/12**, 38.8s, after the shared Local preflight refinement. Includes keyboard/reduced motion/320 CSS px/axe, tenant/socket boundaries, privacy withdrawal and complete explicit resident/visitor flow. The earlier current-config run also passed 12/12 in 45.9s. Judge replay passed 1/1 in 13.3s; actual owned-worker restart preserved claim and completed its durable job, with 1234ms observed recovery.
- Final offline focused synth passed using synthetic account `000000000000` / `us-east-1`, lookups disabled. Template resource types are exactly **three `AWS::DynamoDB::Table` resources**; proposed runtime policy is output text only, not an IAM resource/grant.

Detailed commands, evidence and limits are in [test-results.md](test-results.md). The two earlier draft assertion failures (AWS-owned encryption `SSEEnabled:false`, table output `Ref`) were repaired and rerun successfully; they are historical failures, not AWS observations. Earlier Ring fixes and all unrelated work remain preserved. No commit or push occurred.

## Preserved runtime and data

Only CaptionDoor's isolated Compose project `captiondoor_local` was started. Web and worker stopped first, then DynamoDB; all three exited normally after SIGTERM (143). Ports **3410/3411/8410 are closed**. Named volume **captiondoor_local_dynamodb_data** remains. The shutdown/volume inspection succeeded. A later final `docker ps` could not connect because the Docker socket disappeared; `orbctl status` then reported Stopped. No engine stop was issued by this task, the cause is unverified, and no restart was attempted after handoff. Ports were rechecked closed. No reset, purge, global stop or other-project service action occurred. No test child remains running.

The ignored `.env` remains Local with permissions 0600. Only missing nonsecret `CAPTIONDOOR_DB_MODE=local` / `CAPTIONDOOR_ENV=local` labels were added; prior values and the existing signing key were preserved. Setup seeds missing Local fictional records only and did not reset data. Integration uses dedicated test tables; browser/recovery evidence is synthetic. No active AWS environment/profile was saved.

To restart Local later, from the project root run `corepack pnpm setup:local`, then `docker compose -p captiondoor_local --profile app up --build -d web worker`; open `http://127.0.0.1:3410`. Do not run this simultaneously with another project in the sequential slot.

## Earlier read-only AWS observations

- Existing named profile `tally` had no configured Region. The first STS command stopped with NoRegion; a read-only retry explicitly proposed `us-east-1` without persisting it.
- Account **256604024085**, principal `arn:aws:iam::256604024085:root`. Root is unsuitable for the application and is rejected by its AWS identity fence. No non-root runtime principal has been verified or configured.
- Filtered `ListTables` returned no CaptionDoor/captiondoor names in the proposed Region. No unrelated content or other Region was inspected. There were therefore no matching remote schema/index/TTL/stream facts to verify.
- Account-wide `ListRoles`, filtered to CaptionDoor names, returned no matches. This does not rule out another usable non-root identity.
- No new AWS account request ran in this final verification pass. Earlier observations were STS/ListTables/ListRoles reads only; no credentials, login grants, IAM or resources were created or changed.

## Smallest approval-ready plan

See the reviewed [remote runbook](remote-dynamodb-runbook.md) for exact resources, policy, approval wording, smoke stages, rollback and cleanup.

Propose account **256604024085**, Region **us-east-1** (not user-selected), and three new Standard on-demand tables: `CaptionDoorDevConfig`, `CaptionDoorDevVisits`, `CaptionDoorDevRuntime`. String PK/SK, TTL `expiresAt`; Visits `household-time` KEYS_ONLY GSI; Runtime `due-work` KEYS_ONLY GSI plus KEYS_ONLY Stream. AWS-owned encryption, Retain/UpdateReplace Retain, deletion protection, PITR off, table/GSI 50 RRU/50 WRU best-effort targets. No IAM/compute/SQS/Lambda/Cognito/KMS resource is in the focused template; the Mac uses the bounded due poller.

Official rates rechecked on 2026-10-22: $0.625/million WRUs, $0.125/million RRUs, $0.25/GB-month. The runbook's 30-day assumptions total **$1.2148/month**, excluding transfer/tax/other services and unexpected use. Its proposed **$5/month review allowance is unapproved and not a hard cap**. The earlier $1.80/500ms-poll draft is superseded by the implemented 5000ms AWS default. [AWS pricing](https://aws.amazon.com/dynamodb/pricing/on-demand/)

## Pending approval and unexecuted steps

**Pending, not denied:** confirm account/Region and spending allowance; verify the exact existing non-root trusted principal ARN; approve only the exact database resources and scoped temporary runtime access. The suggested role name is `CaptionDoorDevRuntimeRole`; trust is unresolved, never wildcard/account-root. The runbook supplies one concrete combined resource/access request after that ARN is known. A bootstrap or expanded deployment permission request would need separate review.

Actual AWS `db:verify`, provisioning, IAM changes, credential/login setup and remote data writes have **not run**. Fresh isolated fictional records and the bounded conditional-claim/transaction/persistence/tenant/job/deletion smoke require separately reviewed write approval. No local sessions, tokens, expired transcripts or personal content will be bulk-copied. Local remains the rollback target; TTL is delayed cleanup, not proof of deletion.

Real Ring/official Playground, AWS Transcribe, Web Push delivery, cloud Streams/Lambda/SQS, physical devices and native browser zoom remain unverified here. No provider/paid call, public deployment or submission was made. Local fixture success is not external integration evidence.
