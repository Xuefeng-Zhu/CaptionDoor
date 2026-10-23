#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { remoteProviderSmokeConfig } from "@captiondoor/domain";
import { CaptionDoorDatabaseStack } from "./database-stack";

/** Offline review target only. No account lookup, IAM grant or deployment. */
export function createRemoteProviderDatabaseStack(app: App) {
  return new CaptionDoorDatabaseStack(
    app,
    "CaptionDoorProviderDatabaseDev20261023",
    {
      env: {
        account: remoteProviderSmokeConfig.accountId,
        region: remoteProviderSmokeConfig.region,
      },
      tablePrefix: remoteProviderSmokeConfig.tablePrefix,
      description:
        "CaptionDoor isolated remote provider-test DynamoDB proposal; resource, data and access approval required",
    },
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = new App({ analyticsReporting: false, autoSynth: false });
  createRemoteProviderDatabaseStack(app);
  app.synth();
}
