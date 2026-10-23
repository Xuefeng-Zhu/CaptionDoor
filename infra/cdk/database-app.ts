#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { CaptionDoorDatabaseStack } from "./database-stack";

const app = new App({ analyticsReporting: false });
// Explicit metadata only. No profile login, account lookup or credential creation.
const account =
  app.node.tryGetContext("databaseAccount") ??
  process.env.CAPTIONDOOR_AWS_ACCOUNT;
const region =
  app.node.tryGetContext("databaseRegion") ??
  process.env.CAPTIONDOOR_AWS_REGION;
const tablePrefix =
  app.node.tryGetContext("databasePrefix") ??
  process.env.CAPTIONDOOR_AWS_TABLE_PREFIX;
new CaptionDoorDatabaseStack(app, "CaptionDoorDatabaseDev", {
  env: { account, region },
  tablePrefix,
  description:
    "CaptionDoor remote fictional-demo DynamoDB only; provisioning requires separate approval",
});
app.synth();
