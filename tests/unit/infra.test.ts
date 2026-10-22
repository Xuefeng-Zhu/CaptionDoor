import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { dispatcherCode } from "../../infra/cdk/dispatch-code";
import { CaptionDoorStack } from "../../infra/cdk/stack";

type StreamRecord = {
  eventName: string;
  dynamodb: {
    SequenceNumber: string;
    Keys: { PK: { S: string }; SK: { S: string } };
    NewImage?: unknown;
  };
};
const record = (id: string, sequence: string): StreamRecord => ({
  eventName: "INSERT",
  dynamodb: {
    SequenceNumber: sequence,
    Keys: { PK: { S: `JOB#${id}` }, SK: { S: "JOB" } },
    NewImage: { privateText: "Do not queue this content." },
  },
});
function dispatcher(send: (input: unknown) => Promise<unknown>) {
  const scope = {
    exports: {} as {
      handler: (event: {
        Records: StreamRecord[];
      }) => Promise<{ batchItemFailures: { itemIdentifier: string }[] }>;
    },
    process: { env: { JOB_QUEUE_URL: "https://queue.invalid/jobs" } },
    require: () => ({
      SQSClient: class {
        send(command: { input: unknown }) {
          return send(command.input);
        }
      },
      SendMessageCommand: class {
        constructor(public input: unknown) {}
      },
    }),
  };
  runInNewContext(dispatcherCode, scope);
  return scope.exports.handler;
}
describe("cloud dispatch privacy and recovery contract", () => {
  it("sends only job keys and ignores unrelated/changed items", async () => {
    const sent: unknown[] = [];
    const fn = dispatcher(async (input) => {
      sent.push(input);
      return {};
    });
    const nonJob = record("ignored", "2");
    nonJob.dynamodb.Keys.PK.S = "SESSION#private";
    const modified = record("changed", "3");
    modified.eventName = "MODIFY";
    expect(
      await fn({ Records: [record("one", "1"), nonJob, modified] }),
    ).toEqual({ batchItemFailures: [] });
    expect(sent).toEqual([
      {
        QueueUrl: "https://queue.invalid/jobs",
        MessageBody: '{"PK":"JOB#one","SK":"JOB"}',
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain("privateText");
  });
  it("returns only failed record sequence numbers for bounded stream retry", async () => {
    let count = 0;
    const fn = dispatcher(async () => {
      count++;
      if (count === 2) throw new Error("transport");
      return {};
    });
    expect(
      await fn({
        Records: [
          record("one", "10"),
          record("two", "20"),
          record("three", "30"),
        ],
      }),
    ).toEqual({ batchItemFailures: [{ itemIdentifier: "20" }] });
    expect(count).toBe(3);
  });
  it("synthesizes isolated persistence/jobs/auth without runtime Scan permission", () => {
    const app = new App({ analyticsReporting: false });
    const stack = new CaptionDoorStack(app, "InfrastructureContract");
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::DynamoDB::Table", 3);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "CaptionDoorRuntime",
      StreamSpecification: { StreamViewType: "KEYS_ONLY" },
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      StartingPosition: "TRIM_HORIZON",
      MaximumRetryAttempts: 3,
    });
    template.resourceCountIs("AWS::SQS::Queue", 2);
    template.resourceCountIs("AWS::Cognito::UserPool", 1);
    expect(JSON.stringify(template.toJSON())).not.toContain("dynamodb:Scan");
  });
});
