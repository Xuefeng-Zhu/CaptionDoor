import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from "@aws-sdk/client-dynamodb";
import {
  client,
  tables,
  db,
  getItem,
  putItem,
  seconds,
  householdPK,
} from "../packages/db/src/repository";
import { allGrants } from "../packages/db/src/auth";
import { presets } from "@captiondoor/domain";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const endpoint = process.env.DYNAMODB_ENDPOINT || "http://127.0.0.1:8410";
export function assertLocalReset() {
  const url = new URL(endpoint);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== "8410" ||
    process.env.NODE_ENV === "production" ||
    tables.config !== "CaptionDoorConfig" ||
    tables.visits !== "CaptionDoorVisits" ||
    tables.runtime !== "CaptionDoorRuntime"
  )
    throw new Error(
      "Destructive reset refused: only exact isolated local endpoint port 8410 and CaptionDoor table names are allowed.",
    );
}
async function exists(name: string) {
  try {
    await client.send(new DescribeTableCommand({ TableName: name }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "ResourceNotFoundException")
      return false;
    throw error;
  }
}
export async function ensureTables() {
  for (const name of Object.values(tables)) {
    if (await exists(name)) continue;
    const attrs: any[] = [
      { AttributeName: "PK", AttributeType: "S" },
      { AttributeName: "SK", AttributeType: "S" },
    ];
    let indexes: any[] = [];
    if (name === tables.visits) {
      attrs.push(
        { AttributeName: "gsi1pk", AttributeType: "S" },
        { AttributeName: "gsi1sk", AttributeType: "S" },
      );
      indexes = [
        {
          IndexName: "household-time",
          KeySchema: [
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "KEYS_ONLY" },
        },
      ];
    }
    if (name === tables.runtime) {
      attrs.push(
        { AttributeName: "duePk", AttributeType: "S" },
        { AttributeName: "dueSk", AttributeType: "S" },
      );
      indexes = [
        {
          IndexName: "due-work",
          KeySchema: [
            { AttributeName: "duePk", KeyType: "HASH" },
            { AttributeName: "dueSk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "KEYS_ONLY" },
        },
      ];
    }
    await client.send(
      new CreateTableCommand({
        TableName: name,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        AttributeDefinitions: attrs,
        ...(indexes.length ? { GlobalSecondaryIndexes: indexes } : {}),
        ...(name === tables.runtime
          ? {
              StreamSpecification: {
                StreamEnabled: true,
                StreamViewType: "KEYS_ONLY",
              },
            }
          : {}),
      }),
    );
    await waitUntilTableExists(
      { client, maxWaitTime: 30, minDelay: 1 },
      { TableName: name },
    );
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: name,
        TimeToLiveSpecification: { Enabled: true, AttributeName: "expiresAt" },
      }),
    );
    console.info(`Created ${name}`);
  }
}
async function seed(
  table: string,
  row: Record<string, any> & { PK: string; SK: string },
) {
  if (!(await getItem(table, row.PK, row.SK))) await putItem(table, row);
}
export async function seedLocal() {
  const expiry = seconds() + 365 * 86400;
  for (const household of [
    {
      id: "h1",
      name: "Cedar house",
      doorId: "front-door",
      publicDoorId: "front-demo",
      accountId: "demo-account",
      users: [
        { id: "alex", name: "Alex", role: "owner" },
        { id: "sam", name: "Sam", role: "member" },
      ],
    },
    {
      id: "h2",
      name: "Maple house",
      doorId: "other-door",
      publicDoorId: "other-demo",
      accountId: "demo-account-h2",
      users: [{ id: "jordan", name: "Jordan", role: "owner" }],
    },
  ]) {
    const PK = householdPK(household.id);
    await seed(tables.config, {
      PK,
      SK: "PROFILE",
      id: household.id,
      name: household.name,
      settings: {
        retentionHours: 24,
        captionSize: 32,
        consent: { ring: false, transcription: false, sharing: false },
        presets,
      },
    });
    await seed(tables.config, {
      PK,
      SK: `DOOR#${household.doorId}`,
      id: household.doorId,
      householdId: household.id,
      name: "Front door",
      publicDoorId: household.publicDoorId,
      ringAccountId: household.accountId,
    });
    await seed(tables.config, {
      PK,
      SK: "INTEGRATION#ring",
      status: "LOCAL_SIMULATION",
      mode: "demo",
      connected: false,
    });
    await seed(tables.config, {
      PK: `PUBLICDOOR#${household.publicDoorId}`,
      SK: "LOOKUP",
      householdId: household.id,
      doorId: household.doorId,
    });
    await seed(tables.config, {
      PK: `RINGACCOUNT#${household.accountId}`,
      SK: "LOOKUP",
      householdId: household.id,
      deviceId: household.doorId,
      doorId: household.doorId,
    });
    for (const user of household.users) {
      await seed(tables.config, {
        PK,
        SK: `MEMBER#${user.id}`,
        userId: user.id,
        name: user.name,
        role: user.role,
        expiresAt: expiry,
        grants: { ...allGrants, membership: user.role === "owner" },
      });
      await seed(tables.config, {
        PK: `USER#${user.id}`,
        SK: "LOOKUP",
        userId: user.id,
        householdId: household.id,
      });
    }
  }
  await seed(tables.config, { PK: "HEALTH", SK: "HEALTH", schemaVersion: 1 });
}
export async function setupLocal(reset = false) {
  assertLocalReset();
  const compose = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      "captiondoor_local",
      "-f",
      resolve(root, "compose.yaml"),
      "up",
      "-d",
      "dynamodb",
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (compose.status !== 0)
    throw new Error(
      "Isolated CaptionDoor Docker service did not start. Start OrbStack/Docker and rerun setup:local.",
    );
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await client.send(new DescribeTableCommand({ TableName: tables.config }));
      ready = true;
      break;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ResourceNotFoundException"
      ) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!ready)
    throw new Error("DynamoDB Local not reachable at isolated endpoint.");
  if (reset) {
    for (const name of Object.values(tables)) {
      if (await exists(name)) {
        await client.send(new DeleteTableCommand({ TableName: name }));
        await waitUntilTableNotExists(
          { client, maxWaitTime: 30, minDelay: 1 },
          { TableName: name },
        );
      }
    }
    console.info("Reset only CaptionDoor tables on localhost:8410.");
  }
  await ensureTables();
  await seedLocal();
  const example = resolve(root, ".env.example"),
    env = resolve(root, ".env");
  if (!existsSync(env) && existsSync(example)) copyFileSync(example, env);
  let envText = existsSync(env) ? readFileSync(env, "utf8") : "";
  const signingLine = /^LOCAL_SIGNING_SECRET=(.*)$/m.exec(envText);
  if (!signingLine || !signingLine[1].trim()) {
    const line = `LOCAL_SIGNING_SECRET=${randomBytes(32).toString("base64url")}`;
    envText = signingLine
      ? envText.replace(/^LOCAL_SIGNING_SECRET=.*$/m, line)
      : `${envText}\n${line}\n`;
    writeFileSync(env, envText, { mode: 0o600 });
  }
  chmodSync(env, 0o600);
  console.info(
    "CaptionDoor local setup ready. Existing records preserved unless --reset was explicitly requested.",
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  setupLocal(process.argv.includes("--reset")).catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Local setup failed",
    );
    process.exitCode = 1;
  });
}
