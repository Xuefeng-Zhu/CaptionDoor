export type SessionDevice = { id: string; status?: string };
export type SessionScope = {
  householdId: "h1";
  visitId?: string;
  mediaSessionId?: string;
  mediaAttempted: boolean;
};
export type SessionCleanup = {
  result: "PASS" | "PENDING";
  cleanupCredentialsAbsent: boolean;
  category: string;
};
export type SessionFlowDependencies = {
  prepare(): Promise<void>;
  promptToken(): Promise<string>;
  generateKey(): string;
  startBackends(secrets: { token: string; keyBase64: string }): Promise<void>;
  discover(): Promise<SessionDevice[]>;
  selectDevice(devices: SessionDevice[]): Promise<string>;
  confirmAttempt(): Promise<void>;
  runAttempt(deviceId: string): Promise<void>;
  stopIntake(): Promise<void>;
  verifyCleanup(): Promise<SessionCleanup>;
  waitCleanupRetry(): Promise<void>;
  stopOwned(): Promise<void>;
  discardSecrets(): void;
  status(category: string): void;
  failureCategory?(error: unknown): string;
  storage?: "local" | "aws";
};
/** Keeps key-owning backends alive while scoped cleanup is unresolved. Never logs thrown values. */
export async function runProviderSessionFlow(
  d: SessionFlowDependencies,
): Promise<{ result: "COMPLETED" | "BLOCKED"; cleanupConfirmed: boolean }> {
  let backendsStarted = false,
    attemptStarted = false,
    failed = false,
    clean = false;
  try {
    await d.prepare();
    const token = await d.promptToken();
    if (!token || /[\s\x00-\x1f\x7f]/.test(token))
      throw new Error("TOKEN_REQUIRED");
    const secrets = { token, keyBase64: d.generateKey() };
    backendsStarted = true; // A partial start still belongs to this coordinator.
    await d.startBackends(secrets);
    const devices = await d.discover();
    if (!devices.length) throw new Error("NO_AUTHORIZED_DEVICE");
    const deviceId = await d.selectDevice(devices);
    if (!devices.some((device) => device.id === deviceId))
      throw new Error("SELECTION_REQUIRED");
    await d.confirmAttempt();
    attemptStarted = true;
    await d.runAttempt(deviceId);
  } catch (error) {
    failed = true;
    d.status(d.failureCategory?.(error) ?? "SESSION_BLOCKED_OR_CANCELLED");
  } finally {
    if (attemptStarted) {
      let intakeStopped = false;
      while (!clean) {
        if (!intakeStopped) {
          try {
            await d.stopIntake();
            intakeStopped = true;
          } catch {
            d.status("INTAKE_STOP_PENDING_CLEANUP_STILL_REQUIRED");
          }
        }
        try {
          const result = await d.verifyCleanup();
          clean =
            intakeStopped &&
            result.result === "PASS" &&
            result.cleanupCredentialsAbsent === true;
        } catch {
          /* Preserve key and backends; no raw error text. */
        }
        if (!clean) {
          d.status("CLEANUP_PENDING_KEEP_TERMINAL_OPEN_KEY_RETAINED");
          try {
            await d.waitCleanupRetry();
          } catch {
            /* Keep the key and retry the safety boundary. */
          }
        }
      }
      d.status(
        d.storage === "aws"
          ? "PHYSICAL_AWS_CLEANUP_CONFIRMED"
          : "PHYSICAL_LOCAL_CLEANUP_CONFIRMED",
      );
    } else clean = true; // This coordinator has not initiated any media operation.
    if (clean) {
      let stopped = false;
      while (!stopped) {
        try {
          await d.stopOwned();
          stopped = true;
        } catch {
          d.status("OWNED_PROCESS_STOP_PENDING_KEY_RETAINED");
          try {
            await d.waitCleanupRetry();
          } catch {
            /* Keep the key and retry the safety boundary. */
          }
        }
      }
      d.discardSecrets();
      d.status("OWNED_PROCESSES_STOPPED_SECRETS_DISCARDED");
    } else if (!backendsStarted) await d.stopOwned();
  }
  return { result: failed ? "BLOCKED" : "COMPLETED", cleanupConfirmed: clean };
}
