import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as eventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as logs from "aws-cdk-lib/aws-logs";
import { dispatcherCode } from "./dispatch-code";

export class CaptionDoorStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    Tags.of(this).add("Application", "CaptionDoor");
    const origin = new CfnParameter(this, "AppOrigin", {
      type: "String",
      default: "https://captiondoor.invalid",
      allowedPattern: "^https://[^/]+$",
      description:
        "Authorized HTTPS origin. Replace reserved .invalid before any deployment.",
    });
    const wrappingKey = new kms.Key(this, "CredentialWrappingKey", {
      description:
        "CaptionDoor Ring credential envelope encryption; never sent to a browser",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
      pendingWindow: Duration.days(30),
    });
    const table = (
      logical: string,
      name: string,
      stream?: dynamodb.StreamViewType,
    ) =>
      new dynamodb.Table(this, logical, {
        tableName: name,
        partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
        timeToLiveAttribute: "expiresAt",
        stream,
        deletionProtection: true,
        removalPolicy: RemovalPolicy.RETAIN,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      });
    const config = table("Config", "CaptionDoorConfig");
    const visits = table("Visits", "CaptionDoorVisits");
    visits.addGlobalSecondaryIndex({
      indexName: "household-time",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });
    const runtime = table(
      "Runtime",
      "CaptionDoorRuntime",
      dynamodb.StreamViewType.KEYS_ONLY,
    );
    runtime.addGlobalSecondaryIndex({
      indexName: "due-work",
      partitionKey: { name: "duePk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "dueSk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });
    const deadLetters = new sqs.Queue(this, "JobDeadLetters", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const jobs = new sqs.Queue(this, "Jobs", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: Duration.seconds(60),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: deadLetters, maxReceiveCount: 5 },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const dispatcherLogs = new logs.LogGroup(this, "DispatcherLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const dispatchRole = new iam.Role(this, "DispatchRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    dispatcherLogs.grantWrite(dispatchRole);
    const dispatcher = new lambda.Function(this, "DispatchJobs", {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromInline(dispatcherCode),
      memorySize: 128,
      timeout: Duration.seconds(15),
      reservedConcurrentExecutions: 2,
      environment: { JOB_QUEUE_URL: jobs.queueUrl },
      logGroup: dispatcherLogs,
      role: dispatchRole,
    });
    dispatcher.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sqs:SendMessage"],
        resources: [jobs.queueArn],
      }),
    );
    dispatcher.addEventSource(
      new eventSources.DynamoEventSource(runtime, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 20,
        maxBatchingWindow: Duration.seconds(1),
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        retryAttempts: 3,
        maxRecordAge: Duration.hours(1),
        filters: [
          lambda.FilterCriteria.filter({
            eventName: ["INSERT"],
            dynamodb: {
              Keys: { PK: { S: [{ prefix: "JOB#" }] }, SK: { S: ["JOB"] } },
            },
          }),
        ],
      }),
    );
    // An already-authorized single AWS host may attach this profile. No host is provisioned.
    const appRole = new iam.Role(this, "SingleHostRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description:
        "CaptionDoor single-host web and worker runtime; no scan or table administration",
    });
    const resources = [config, visits, runtime].flatMap((t) => [
      t.tableArn,
      `${t.tableArn}/index/*`,
    ]);
    appRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:ConditionCheckItem",
        ],
        resources,
      }),
    );
    // IAM authorizes transaction suboperations through their individual item permissions.
    appRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Encrypt", "kms:Decrypt"],
        resources: [wrappingKey.keyArn],
        conditions: {
          StringEquals: {
            "kms:EncryptionContext:application": "CaptionDoor",
            "kms:EncryptionContext:provider": "Ring",
          },
        },
      }),
    );
    jobs.grantConsumeMessages(appRole);
    appRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["transcribe:StartStreamTranscription"],
        resources: ["*"],
      }),
    );
    const profile = new iam.CfnInstanceProfile(this, "SingleHostProfile", {
      roles: [appRole.roleName],
    });
    const pool = new cognito.UserPool(this, "Residents", {
      userPoolName: "CaptionDoorResidents",
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 14,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const client = pool.addClient("WebClient", {
      generateSecret: true,
      preventUserExistenceErrors: true,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [`${origin.valueAsString}/api/auth/callback`],
        logoutUrls: [origin.valueAsString],
      },
      accessTokenValidity: Duration.minutes(15),
      idTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.days(1),
      enableTokenRevocation: true,
    });
    pool.addDomain("LoginDomain", {
      cognitoDomain: {
        domainPrefix: `captiondoor-${this.account}-${this.region}`,
      },
    });
    new CfnOutput(this, "ConfigTable", { value: config.tableName });
    new CfnOutput(this, "VisitsTable", { value: visits.tableName });
    new CfnOutput(this, "RuntimeTable", { value: runtime.tableName });
    new CfnOutput(this, "JobQueueUrl", { value: jobs.queueUrl });
    new CfnOutput(this, "JobDeadLetterQueueUrl", {
      value: deadLetters.queueUrl,
    });
    new CfnOutput(this, "CredentialKeyArn", { value: wrappingKey.keyArn });
    new CfnOutput(this, "InstanceProfileName", { value: profile.ref });
    new CfnOutput(this, "OidcIssuer", {
      value: `https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}`,
    });
    new CfnOutput(this, "OidcClientId", { value: client.userPoolClientId });
    new CfnOutput(this, "AuthorizedAppOrigin", { value: origin.valueAsString });
  }
}
