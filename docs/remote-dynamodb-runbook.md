# CaptionDoor remote DynamoDB development runbook

**Scope note — 2026-10-23:** this ordinary `remote-demo` database plan is separate from the executed [dedicated remote provider test](remote-provider-session.md). Its table names, non-root access plan and pending approvals remain distinct.

Prepared 2026-10-22 UTC. **This is an approval-ready database proposal, not a completed migration.** The application remains on its preserved local database until the resource, identity and smoke-test scope below are explicitly approved. A successful offline synth or DynamoDB Local test is not evidence of a deployed AWS table, working AWS permission or remote persistence.

## Verified account facts and decisions still needed

Earlier read-only checks used the existing `tally` CLI profile and returned AWS account **256604024085**, principal `arn:aws:iam::256604024085:root`. The profile had no configured Region; `us-east-1` was explicitly proposed for metadata discovery, not selected by the user. The regional table listing returned no names beginning CaptionDoor/captiondoor. The account-wide IAM role listing, filtered to names beginning CaptionDoor, returned no matches. Other Regions and unrelated table contents were not inspected. No credential, profile, IAM permission or resource was changed.

The app must use a separately approved **non-root runtime identity**, with temporary role/federated credentials obtained through the normal AWS SDK chain. Do not configure `tally` as its runtime profile. A suitable existing non-root principal has not been verified. New trust, policy attachment, login/role access or credential persistence requires approval; this runbook creates none. AWS recommends temporary credentials, workload roles and least privilege. [IAM guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)

Before any execution, confirm the proposed account/Region, the precise trusted non-root principal ARN and the spending allowance. SayGo's $20 budget and Sway's pilot budget do not apply to CaptionDoor. Do not reuse SayGo, Sway, Tally, DoorDesk or production tables.

## Smallest database-only resources

The focused CDK entry point is `infra/cdk/database-app.ts`, with stack `CaptionDoorDatabaseDev`. Its target account and Region must be explicit; it performs no account lookup. The proposed default prefix is `CaptionDoorDev`. An alternate prefix must be `CaptionDoorDev-<approved lowercase suffix>` and changes all names and policy resources together.

| New resource            | Keys / index / stream                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `CaptionDoorDevConfig`  | String partition key `PK`, string sort key `SK`; no GSI or stream                                 |
| `CaptionDoorDevVisits`  | `PK`/`SK`; `household-time` GSI on `gsi1pk`/`gsi1sk`, projection `KEYS_ONLY`                      |
| `CaptionDoorDevRuntime` | `PK`/`SK`; `due-work` GSI on `duePk`/`dueSk`, projection `KEYS_ONLY`; DynamoDB Stream `KEYS_ONLY` |

All **three** tables use Standard table class, on-demand billing, TTL attribute `expiresAt`, AWS-owned encryption, deletion protection and CloudFormation Retain/UpdateReplace Retain. PITR is off for this fictional development dataset. Each table and each GSI has a 50 read/50 write request-unit-per-second target. AWS-owned encryption has no additional KMS charge; AWS-managed/custom keys are different. [Encryption types](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/EncryptionAtRest.html)

Maximum-throughput settings are best-effort targets and may be exceeded temporarily by burst capacity. They are **not a hard spending cap**. [Throughput limits](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode-max-throughput.html)

This stack does not create IAM, compute, SQS/DLQ, Lambda, Cognito, KMS, a public endpoint or a whole application deployment. The stream is enabled for schema compatibility; this development plan uses the single Mac worker's due-index poller, not a new stream consumer. Stream dispatch/SQS behavior remains untested until separately deployed and authorized. Do not deploy `infra/cdk/app.ts` just to obtain these tables.

## Cost and operating allowance

Rechecked against official AWS pricing on 2026-10-22 UTC. For proposed `us-east-1`, Standard on-demand prices are **$0.625/million WRUs**, **$0.125/million RRUs** and **$0.25/GB-month storage**. No free tier, credits or another project's budget is assumed. [AWS on-demand pricing](https://aws.amazon.com/dynamodb/pricing/on-demand/)

| Thirty-day planning consumption across all three tables/indexes                                                             |    Estimated USD |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------: |
| 1.2 million total WRUs, including transactional writes, index maintenance, retries and churn                                |           0.7500 |
| 1.2 million application RRUs, including strong/transactional reads and due-job candidate reloads                            |           0.1500 |
| One continuously running worker, 5,000ms recovery polling: 30 × 24 × 60 × 60 ÷ 5 = 518,400 queries, budgeted at 1 RRU/query |           0.0648 |
| At most 1GB combined base-table/index storage                                                                               |           0.2500 |
| **Database planning subtotal**                                                                                              | **1.2148/month** |

These are item/request-unit budgets, not visitor or resident-command counts: one command can touch several items. A working assumption is 300,000 mutations of at most 1 KB, all transactional (600,000 WRUs), with another 600,000 WRUs reserved for index changes/retries; 600,000 reads of at most 4 KB are conservatively treated as transactional (1.2 million RRUs). Larger items, conflicts and repeated attempts increase use. [Transaction capacity](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)

An empty eventual GSI query still consumes capacity and sparse partitions can cost more; record `ReturnConsumedCapacity: INDEXES` during the approved smoke rather than assuming zero-cost polling. Stop the single worker when unused. [Query consumption](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.Other.html)

The subtotal excludes taxes, internet/cross-Region data transfer, unexpected traffic and all other services. No stream GetRecords consumer or backup is planned. A **proposed $5/month operating review allowance for this CaptionDoor development database** provides headroom but is not yet approved or an automatic enforcement mechanism. At a projected/observed allowance breach, stop CaptionDoor's worker and remote demo and seek new approval. Retained storage can still charge while processes are stopped. Account billing data can lag; no cap or real-time budget alarm is claimed. Any budget/alarm resource itself must be reviewed before creation.

## Runtime configuration and isolation

The runtime configuration contract separates storage from auth/provider modes:

| Intended target           | Required distinction                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolated DynamoDB Local   | `CAPTIONDOOR_DB_MODE=local`, `CAPTIONDOOR_ENV=local`, explicitly isolated local endpoint; local SDK test credentials only                                                                |
| AWS fictional development | `CAPTIONDOOR_DB_MODE=aws`, `CAPTIONDOOR_ENV=remote-demo`, explicit `AWS_ACCOUNT_ID` and `AWS_REGION`, approved `CAPTIONDOOR_AWS_TABLE_PREFIX`; normal approved non-root credential chain |
| Production                | Separate production environment, real OIDC/Ring/AWS modes and production namespace; remote-demo is not production                                                                        |

After approval only, the intended AWS development metadata is:

```dotenv
# Review example only: account/Region/identity still require approval.
NODE_ENV=development
CAPTIONDOOR_DB_MODE=aws
CAPTIONDOOR_ENV=remote-demo
AWS_ACCOUNT_ID=256604024085
AWS_REGION=us-east-1
AWS_PROFILE=APPROVED_NON_ROOT_SESSION_PROFILE
CAPTIONDOOR_AWS_TABLE_PREFIX=CaptionDoorDev
CAPTIONDOOR_CONFIG_TABLE=CaptionDoorDevConfig
CAPTIONDOOR_VISITS_TABLE=CaptionDoorDevVisits
CAPTIONDOOR_RUNTIME_TABLE=CaptionDoorDevRuntime
CAPTIONDOOR_JOB_POLL_INTERVAL_MS=5000
AUTH_MODE=demo
RING_MODE=demo
TRANSCRIBE_MODE=fixture
APP_ORIGIN=http://127.0.0.1:3410
WS_PUBLIC_URL=ws://127.0.0.1:3411/ws
WORKER_PORT=3411
# No DYNAMODB_ENDPOINT, AWS endpoint override, access key or secret belongs here.
```

The placeholder-only template is [config/aws-demo.env.example](../config/aws-demo.env.example); this example is configuration documentation, not an active remote environment file. All three AWS table names are required and must exactly match the approved shared prefix and role suffixes. Set approved metadata in the process environment only after authorization; this preparation does not create an active AWS environment or credential file. Polling defaults to 500ms locally and 5,000ms in AWS mode; the estimate assumes one AWS-mode worker running for 30 days. Explicit AWS mode skips Local `.env` loading in the repository, worker and development launcher, so a stale Local environment cannot silently select the database. Do not copy a root profile, local dummy keys or a stale `.env` into remote mode. AWS mode must fail on an invalid/missing target or credential/identity failure, never silently fall back to Local. Before DynamoDB requests, the runtime's lazy STS identity check must match the expected account and reject root. A successful identity check is cached per client/process; restart every app and worker after changing the runtime profile or identity. This is a startup identity fence, not continuous credential auditing; the scoped IAM policy remains the data-access boundary. `GetCallerIdentity` is an identity read, not creation of a credential or login grant. [STS contract](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html)

The remote demo remains loopback-only on the Mac. It uses fictional demo identities and synthetic LOCAL/FIXTURE content, with a fresh isolated household namespace. AWS storage does not turn an event into official Ring evidence or make fixture audio into AWS Transcribe. Production still rejects demo auth and fixture/provider combinations. No production guardrail is disabled to make this development mode work.

## Offline template preparation

The focused template can be synthesized without credentials, lookups, AWS calls or resource creation. Synthetic account metadata below is for local template inspection only; it is not the real deployment target or an approved Region decision:

```sh
CAPTIONDOOR_AWS_ACCOUNT=000000000000 CAPTIONDOOR_AWS_REGION=us-east-1 corepack pnpm infra:database:synth
```

The template is written to `output/cdk-database/CaptionDoorDatabaseDev.template.json`. Inspect its resource count, table/index schema, billing, TTL, retention/protection, throughput settings and Runtime stream. Do not run a deploy command in this preparation pass. The local runtime, identity guards and fixture metadata checks have been validated as recorded in [docs/test-results.md](test-results.md). That local evidence does not establish AWS readiness. The actual AWS `db:verify` operation remains unexecuted pending the resource/access approval.

## Least-privilege identity and provisioning separation

An operator approved to provision resources is separate from the app runtime identity. The focused stack does not create or attach this policy. The proposed runtime role name is `CaptionDoorDevRuntimeRole`; **the exact existing non-root trusted principal ARN is unresolved**. Resolve and verify it before an approval request is actionable. Do not substitute account-root or wildcard trust, create access keys, or grant broad `AmazonDynamoDBFullAccess`.

A narrowly scoped runtime policy for the proposed account/Region/default prefix is:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CaptionDoorTablesOnly",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:ConditionCheckItem",
        "dynamodb:DescribeTable",
        "dynamodb:DescribeTimeToLive"
      ],
      "Resource": [
        "arn:aws:dynamodb:us-east-1:256604024085:table/CaptionDoorDevConfig",
        "arn:aws:dynamodb:us-east-1:256604024085:table/CaptionDoorDevVisits",
        "arn:aws:dynamodb:us-east-1:256604024085:table/CaptionDoorDevRuntime"
      ]
    },
    {
      "Sid": "CaptionDoorIndexesOnly",
      "Effect": "Allow",
      "Action": "dynamodb:Query",
      "Resource": [
        "arn:aws:dynamodb:us-east-1:256604024085:table/CaptionDoorDevVisits/index/household-time",
        "arn:aws:dynamodb:us-east-1:256604024085:table/CaptionDoorDevRuntime/index/due-work"
      ]
    }
  ]
}
```

Transaction authorization uses these underlying item actions; `ConditionCheck` uses `dynamodb:ConditionCheckItem`. Adding a made-up `dynamodb:TransactWriteItems` action is not required. [Transaction IAM](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html) The resource ARNs and read-only metadata actions follow the [DynamoDB authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_dynamodb.html).

There is no runtime Scan, table creation/deletion/update, TTL alteration, IAM administration, stream read, backup/export, SQS, Cognito, KMS or Transcribe permission. Application tenant authorization continues to rely on strong base-table reads and checked membership/grants; this shared backend role is not a substitute for tenant isolation.

Any separate provisioning principal needs a reviewed database-only CloudFormation deployment permission set for this exact template, including table creation/configuration/tagging and deployment-stack metadata. The app role must not receive those permissions. No CDK bootstrap, trust-policy edit or execution-role grant is authorized implicitly. If deployment requests a new bootstrap resource, role, bucket, permission or named IAM capability, stop and surface that change before execution.

## Approval request to present before any AWS write

First replace the identity placeholder with the verified non-root principal ARN. This is one combined resource/access request, not permission already obtained:

> Approve creating only `CaptionDoorDevConfig`, `CaptionDoorDevVisits` and `CaptionDoorDevRuntime` in AWS account 256604024085, proposed Region `us-east-1`, with the two specified indexes, TTL, Runtime KEYS_ONLY stream, on-demand billing, AWS-owned encryption, PITR off, Retain/deletion protection and 50/50 throughput targets; approve a $5/month CaptionDoor development operating review allowance. Approve creating/attaching only the exact runtime policy above to `CaptionDoorDevRuntimeRole`, trusted solely by **[verified non-root principal ARN]**, using temporary credentials without creating or persisting access keys. Approve selecting the explicit remote database metadata and running only the read-only `db:verify` readiness check. Fresh fictional initial records, remote app/demo use and the bounded synthetic write/read smoke below require a separately reviewed and authorized follow-up before their first write. No existing local/private content is copied; no other app/cloud resources, Ring/Transcribe calls, public deployment or submission are included.

If only existing scoped access will be used, replace the role-creation clause with the exact verified existing role/profile and explicitly state no IAM change. An unspecified trusted principal, Region decision or spending allowance is still a blocker. After approval, inspect the final deployment diff and target again; do not widen this request to the full app stack.

## Opt-in cutover and smoke sequence

No remote smoke or seed has run. Before the first write, the approved operator must be able to show the exact target account/Region and a non-root identity, plus ACTIVE tables with the expected schema, indexes, TTL and stream. Stop if a table is missing, unexpected, owned by another account, or a local endpoint/dummy credential is configured. Do not auto-create a missing table from an HTTP request or worker.

1. Preserve the Local volume and existing configuration. Stop only CaptionDoor's current web/worker before a target change; never run both targets against the same ports or perform dual writes.
2. Review offline local tests, build and focused template evidence in `docs/test-results.md`; those checks establish preparation only. Use the offline command above to prepare the focused template, then have the approved operator regenerate/review it with the exact approved CDK `CAPTIONDOOR_AWS_ACCOUNT` and `CAPTIONDOOR_AWS_REGION` target metadata. Synth is not deployment and needs no credentials. Have the approved operator provision just that reviewed database template and approved scoped identity. Re-read table metadata; do not proceed on a CloudFormation progress message alone.
3. Activate only the approved remote metadata and approved temporary identity through process environment, using `config/aws-demo.env.example` as a placeholder reference. Run `corepack pnpm db:verify` for read-only STS, DescribeTable and TTL readiness; it must reject root or an unexpected account. Do not overwrite the preserved Local environment or store credentials in repository files, command arguments, logs, screenshots or browser storage. Start only CaptionDoor's owned loopback services after the separately approved fictional initial records are ready. This preparation pass includes no remote seed/write runner.
4. After separately approved remote seed/write scope, create a new fictional household and isolated second household, two fictional residents, one selected door and unique run IDs. Import no local app/guest sessions, tokens, memberships, personal messages, audio, video or transcripts. New demo sessions belong to this run only and expire promptly.
5. Race two residents' expected-version claim commands: exactly one wins and the loser sees the authoritative conflict state. Verify claim responsibility remains after an owned worker restart. Transactionally persist state/idempotency/audit/outbox; induce a controlled validation/condition failure and verify no partial commit. Never pair ConditionCheck and Update on the same item.
6. Verify strong reads/pagination, distinct ACCEPTED/DISPLAYED/CONFIRMED states, guessed-ID/cross-household read/write/subscribe denial, expired grants before TTL, and isolated guest threads with no captions. Do not authorize from a GSI or claim a socket proved read/acknowledgement.
7. Check a synthetic durable job is still present while the single worker is stopped, then lease/retry/complete it through the configured AWS-table due GSI after restart. This observes remote DynamoDB plus the Mac poller only; it does not validate Streams/Lambda/SQS transport or broadcast scaling.
8. Observe access expiry and run only the app's explicit deletion job for this run's fictional content. Verify known run keys are removed from all three tables/indexes; TTL remains a delayed backstop, not proof of immediate physical deletion. [TTL behavior](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html)
9. Retain sanitized IDs, timestamps, target, operation outcomes, request-unit consumption and actual PASS/FAIL/SKIP/BLOCKED results. Record no credential, private content, raw SDK response or signaling. Stop the worker/demo when unused. Remove only the approved synthetic run data using exact known keys and the approved deletion flow; no scan or broad cleanup.

Use a bounded, explicitly approved run (for example at most 100 synthetic visits and ten minutes) and measure consumed capacity. New scripts/commands must be verified in the checkout before use; this runbook does not invent a `remote:seed`, `remote:smoke` or deploy command. Real Ring, AWS audio, push, production sign-in and production cloud dispatch need their own authorization and evidence.

## Rollback and eventual cleanup

Rollback means stop only CaptionDoor's remote-demo processes, restore explicit Local configuration, and restart only the isolated Local services using the existing volume. Do not copy remote sessions/content into Local, alter AWS permissions to evade a failure, delete tables, or touch another project. An unreachable AWS service or expired identity must remain a visible remote failure until the operator deliberately selects Local.

Retain and deletion protection prevent a normal stack removal from deleting these tables; charges for retained storage can continue. End-of-pilot cleanup is a separate concrete, irreversible action requiring approval. Identify the three exact ARNs and any approved runtime role/policy, verify the fictional-data deletion requirements, disable protection only for those tables, and deliberately delete them with the approved operator. Review retained backups if any were separately enabled. Do not infer erasure from TTL or delete another project's budget/identity/data. No cleanup command or automatic teardown is included in this preparation pass.

Current observations and final local check outcomes remain in `docs/remote-dynamodb-preparation.md` and `docs/test-results.md`. Until an approved real AWS smoke supplies evidence, the correct status is **configuration prepared / AWS cutover pending**, not migrated.
