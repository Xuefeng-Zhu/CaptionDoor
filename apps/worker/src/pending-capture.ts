import { AppError } from "@captiondoor/domain";
// Single-worker transient registry only; responsibility and leases stay in DynamoDB.
const pending = new Set<string>();
export async function withPendingCapture<T>(
  scope: string,
  start: () => Promise<T>,
): Promise<T> {
  if (pending.has(scope))
    throw new AppError(
      "CAPTURE_ACTIVE",
      409,
      "Incoming audio is already starting for this visit.",
    );
  pending.add(scope);
  try {
    return await start();
  } finally {
    pending.delete(scope);
  }
}
