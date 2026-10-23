import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { AppError } from "@captiondoor/domain";
export type AwsIdentity = { Account?: string; Arn?: string };
export type AwsIdentityGuardOptions = { allowRoot?: boolean };

/** One account check per process/client; restart after any runtime identity change. */
export function createAwsIdentityGuard(
  accountId: string,
  load: () => Promise<AwsIdentity>,
  options: AwsIdentityGuardOptions = {},
): () => Promise<void> {
  const allowRoot = options.allowRoot === true;
  let pending: Promise<void> | undefined;
  return () => {
    if (!pending)
      pending = Promise.resolve()
        .then(load)
        .then((identity) => {
          const arn = identity.Arn?.match(
            /^arn:[a-z0-9-]+:(iam|sts)::(\d{12}):(.+)$/,
          );
          if (
            identity.Account !== accountId ||
            !arn ||
            arn[2] !== accountId ||
            !(
              (arn[1] === "iam" && /^user\/.+/.test(arn[3])) ||
              (allowRoot &&
                identity.Arn === `arn:aws:iam::${accountId}:root`) ||
              (arn[1] === "sts" &&
                /^(assumed-role|federated-user)\/.+/.test(arn[3]))
            )
          )
            throw new Error("Unapproved account or root identity");
        })
        .catch(() => {
          // Reset after the promise has been installed, including synchronous loader errors.
          pending = undefined;
          throw new AppError(
            "AWS_DATABASE_IDENTITY_UNVERIFIED",
            503,
            allowRoot
              ? "AWS database access requires the approved account and an explicitly authorized identity."
              : "AWS database access requires the approved account and a verified non-root application identity.",
          );
        });
    return pending;
  };
}

export function installAwsIdentityGuard(
  client: DynamoDBClient,
  accountId: string,
  load: () => Promise<AwsIdentity>,
  options: AwsIdentityGuardOptions = {},
): void {
  const verify = createAwsIdentityGuard(accountId, load, options);
  client.middlewareStack.add(
    (next) => async (args) => {
      await verify();
      return next(args);
    },
    { step: "initialize", name: "captionDoorAwsAccount", priority: "high" },
  );
}
