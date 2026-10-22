/** Runtime stream records are KEYS_ONLY; the queue body is always exactly a job key. */
export const dispatcherCode = `
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const client = new SQSClient({});
exports.handler = async (event) => {
  const failures = [];
  for (const record of event.Records || []) {
    const key = record.dynamodb?.Keys;
    const PK = key?.PK?.S;
    const SK = key?.SK?.S;
    if (record.eventName !== 'INSERT' || !PK?.startsWith('JOB#') || SK !== 'JOB') continue;
    try {
      await client.send(new SendMessageCommand({
        QueueUrl: process.env.JOB_QUEUE_URL,
        MessageBody: JSON.stringify({PK, SK})
      }));
    } catch {
      failures.push({itemIdentifier: record.dynamodb.SequenceNumber});
    }
  }
  return {batchItemFailures: failures};
};
`;
