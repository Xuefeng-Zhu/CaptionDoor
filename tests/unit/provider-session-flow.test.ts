import { describe, expect, it, vi } from "vitest";
import {
  runProviderSessionFlow,
  type SessionCleanup,
  type SessionFlowDependencies,
} from "../../scripts/provider-session-flow";

const fictionalToken = "fictional-prompt-token-not-a-credential";
const fictionalKey = "fictional-key-no-generation";
const rawErrorText = "FICTIONAL_RAW_ERROR_WITH_TOKEN_AND_PRIVATE_CONTENT";
const pass = (): SessionCleanup => ({
  result: "PASS",
  cleanupCredentialsAbsent: true,
  category: "OWN_SCOPED_CLEANUP_CONFIRMED",
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const events: string[] = [];
  const deps = {
    prepare: vi.fn(async () => {
      events.push("prepare");
    }),
    promptToken: vi.fn(async () => {
      events.push("promptToken");
      return fictionalToken;
    }),
    generateKey: vi.fn(() => {
      events.push("generateKey");
      return fictionalKey;
    }),
    startBackends: vi.fn(
      async (_secrets: { token: string; keyBase64: string }) => {
        events.push("startBackends");
      },
    ),
    discover: vi.fn(async () => {
      events.push("discover");
      return [{ id: "fictional-selected-device" }];
    }),
    selectDevice: vi.fn(async (_devices: { id: string }[]) => {
      events.push("selectDevice");
      return "fictional-selected-device";
    }),
    confirmAttempt: vi.fn(async () => {
      events.push("confirmAttempt");
    }),
    runAttempt: vi.fn(async (_deviceId: string) => {
      events.push("runAttempt");
    }),
    stopIntake: vi.fn(async () => {
      events.push("stopIntake");
    }),
    verifyCleanup: vi.fn(async (): Promise<SessionCleanup> => {
      events.push("verifyCleanup");
      return pass();
    }),
    waitCleanupRetry: vi.fn(async () => {
      events.push("waitCleanupRetry");
    }),
    stopOwned: vi.fn(async () => {
      events.push("stopOwned");
    }),
    discardSecrets: vi.fn(() => {
      events.push("discardSecrets");
    }),
    status: vi.fn((_category: string) => {}),
  } satisfies SessionFlowDependencies;
  return { deps, events };
}
function expectNoAttempt(deps: ReturnType<typeof fixture>["deps"]) {
  expect(deps.runAttempt).not.toHaveBeenCalled();
  expect(deps.stopIntake).not.toHaveBeenCalled();
  expect(deps.verifyCleanup).not.toHaveBeenCalled();
  expect(deps.status).not.toHaveBeenCalledWith(
    "PHYSICAL_LOCAL_CLEANUP_CONFIRMED",
  );
}

// Every dependency is fictional. No service, provider, file, credential or key generation.
describe("provider intake orchestration with fictional dependencies only", () => {
  it("labels a verified AWS cleanup separately from Local cleanup", async () => {
    const { deps } = fixture();
    await runProviderSessionFlow({ ...deps, storage: "aws" });
    expect(deps.status).toHaveBeenCalledWith("PHYSICAL_AWS_CLEANUP_CONFIRMED");
    expect(deps.status).not.toHaveBeenCalledWith(
      "PHYSICAL_LOCAL_CLEANUP_CONFIRMED",
    );
  });
  it("runs one explicitly confirmed selected-device attempt and cleans before disposal", async () => {
    const { deps, events } = fixture();
    expect(await runProviderSessionFlow(deps)).toEqual({
      result: "COMPLETED",
      cleanupConfirmed: true,
    });
    expect(events).toEqual([
      "prepare",
      "promptToken",
      "generateKey",
      "startBackends",
      "discover",
      "selectDevice",
      "confirmAttempt",
      "runAttempt",
      "stopIntake",
      "verifyCleanup",
      "stopOwned",
      "discardSecrets",
    ]);
    expect(deps.startBackends).toHaveBeenCalledExactlyOnceWith({
      token: fictionalToken,
      keyBase64: fictionalKey,
    });
    expect(deps.runAttempt).toHaveBeenCalledExactlyOnceWith(
      "fictional-selected-device",
    );
  });

  it.each(["", " ", "token\nvalue", "token\u0000value"])(
    "refuses empty or invalid token input before key/backends/provider (%#)",
    async (token) => {
      const { deps } = fixture();
      deps.promptToken.mockResolvedValue(token);
      expect(await runProviderSessionFlow(deps)).toEqual({
        result: "BLOCKED",
        cleanupConfirmed: true,
      });
      expect(deps.generateKey).not.toHaveBeenCalled();
      expect(deps.startBackends).not.toHaveBeenCalled();
      expect(deps.discover).not.toHaveBeenCalled();
      expectNoAttempt(deps);
      expect(deps.stopOwned).toHaveBeenCalledOnce();
    },
  );

  it("a cancelled hidden prompt creates no key and starts no backends or provider", async () => {
    const { deps } = fixture();
    deps.promptToken.mockRejectedValue(new Error(rawErrorText));
    expect((await runProviderSessionFlow(deps)).result).toBe("BLOCKED");
    expect(deps.generateKey).not.toHaveBeenCalled();
    expect(deps.startBackends).not.toHaveBeenCalled();
    expect(deps.discover).not.toHaveBeenCalled();
    expectNoAttempt(deps);
    expect(deps.stopOwned).toHaveBeenCalledOnce();
  });

  it("cleans up owned preparation after a partial preparation failure", async () => {
    const { deps, events } = fixture();
    deps.prepare.mockImplementation(async () => {
      events.push("prepare-partial-owned-start");
      throw new Error(rawErrorText);
    });
    expect((await runProviderSessionFlow(deps)).result).toBe("BLOCKED");
    expect(deps.promptToken).not.toHaveBeenCalled();
    expect(deps.generateKey).not.toHaveBeenCalled();
    expect(deps.startBackends).not.toHaveBeenCalled();
    expectNoAttempt(deps);
    expect(events).toEqual([
      "prepare-partial-owned-start",
      "stopOwned",
      "discardSecrets",
    ]);
  });

  it("a failed key dependency never starts backends or a provider", async () => {
    const { deps } = fixture();
    deps.generateKey.mockImplementation(() => {
      throw new Error(rawErrorText);
    });
    expect((await runProviderSessionFlow(deps)).result).toBe("BLOCKED");
    expect(deps.startBackends).not.toHaveBeenCalled();
    expectNoAttempt(deps);
    expect(deps.stopOwned).toHaveBeenCalledOnce();
  });

  it("stops partially started owned backends before discarding secrets", async () => {
    const { deps, events } = fixture();
    deps.startBackends.mockImplementation(async () => {
      events.push("one-backend-started");
      throw new Error(rawErrorText);
    });
    expect((await runProviderSessionFlow(deps)).result).toBe("BLOCKED");
    expect(deps.discover).not.toHaveBeenCalled();
    expectNoAttempt(deps);
    expect(events.slice(-3)).toEqual([
      "one-backend-started",
      "stopOwned",
      "discardSecrets",
    ]);
  });

  it("an empty authorized discovery list prevents selection and provider capture", async () => {
    const { deps } = fixture();
    deps.discover.mockResolvedValue([]);
    expect((await runProviderSessionFlow(deps)).result).toBe("BLOCKED");
    expect(deps.selectDevice).not.toHaveBeenCalled();
    expect(deps.confirmAttempt).not.toHaveBeenCalled();
    expectNoAttempt(deps);
    expect(deps.stopOwned).toHaveBeenCalledOnce();
  });

  it("refuses a selected ID that was not in authorized discovery", async () => {
    const { deps } = fixture();
    deps.selectDevice.mockResolvedValue("fictional-guessed-device");
    expect((await runProviderSessionFlow(deps)).result).toBe("BLOCKED");
    expect(deps.confirmAttempt).not.toHaveBeenCalled();
    expectNoAttempt(deps);
  });

  it("waits for explicit confirmation before starting any attempt", async () => {
    const { deps } = fixture();
    const confirmation = deferred();
    deps.confirmAttempt.mockReturnValue(confirmation.promise);
    const running = runProviderSessionFlow(deps);
    await vi.waitFor(() => expect(deps.confirmAttempt).toHaveBeenCalledOnce());
    expectNoAttempt(deps);
    expect(deps.stopOwned).not.toHaveBeenCalled();
    confirmation.resolve();
    expect((await running).result).toBe("COMPLETED");
    expect(deps.runAttempt).toHaveBeenCalledOnce();
  });

  it("cancelling explicit confirmation never starts an attempt", async () => {
    const { deps } = fixture();
    deps.confirmAttempt.mockRejectedValue(new Error(rawErrorText));
    expect((await runProviderSessionFlow(deps)).result).toBe("BLOCKED");
    expectNoAttempt(deps);
    expect(deps.stopOwned).toHaveBeenCalledOnce();
  });

  it("an attempt failure still stops intake and verifies cleanup before disposal", async () => {
    const { deps, events } = fixture();
    deps.runAttempt.mockImplementation(async () => {
      events.push("attempt-failed-after-possible-media");
      throw new Error(rawErrorText);
    });
    expect(await runProviderSessionFlow(deps)).toEqual({
      result: "BLOCKED",
      cleanupConfirmed: true,
    });
    expect(events.slice(-5)).toEqual([
      "attempt-failed-after-possible-media",
      "stopIntake",
      "verifyCleanup",
      "stopOwned",
      "discardSecrets",
    ]);
  });

  it.each([
    {
      label: "pending even with reported absence",
      report: { result: "PENDING", cleanupCredentialsAbsent: true },
    },
    {
      label: "PASS with false absence",
      report: { result: "PASS", cleanupCredentialsAbsent: false },
    },
    {
      label: "PASS without absence",
      report: { result: "PASS" },
    },
    {
      label: "PASS with string false",
      report: { result: "PASS", cleanupCredentialsAbsent: "false" },
    },
    {
      label: "PASS with numeric truthy absence",
      report: { result: "PASS", cleanupCredentialsAbsent: 1 },
    },
    {
      label: "absence without PASS",
      report: { cleanupCredentialsAbsent: true },
    },
    { label: "null report", report: null },
  ])(
    "retains worker/key for $label until a strict later PASS",
    async ({ report }) => {
      const { deps } = fixture();
      const retry = deferred();
      deps.verifyCleanup
        .mockResolvedValueOnce(report as SessionCleanup)
        .mockResolvedValue(pass());
      deps.waitCleanupRetry.mockReturnValueOnce(retry.promise);
      const running = runProviderSessionFlow(deps);
      await vi.waitFor(() =>
        expect(deps.waitCleanupRetry).toHaveBeenCalledOnce(),
      );
      expect(deps.stopIntake).toHaveBeenCalledOnce();
      expect(deps.stopOwned).not.toHaveBeenCalled();
      expect(deps.discardSecrets).not.toHaveBeenCalled();
      expect(deps.status).toHaveBeenCalledWith(
        "CLEANUP_PENDING_KEEP_TERMINAL_OPEN_KEY_RETAINED",
      );
      expect(deps.status).not.toHaveBeenCalledWith(
        "PHYSICAL_LOCAL_CLEANUP_CONFIRMED",
      );
      retry.resolve();
      expect(await running).toEqual({
        result: "COMPLETED",
        cleanupConfirmed: true,
      });
      expect(deps.verifyCleanup).toHaveBeenCalledTimes(2);
      expect(deps.stopOwned).toHaveBeenCalledOnce();
      expect(deps.discardSecrets).toHaveBeenCalledOnce();
    },
  );

  it("a thrown cleanup check retains key/backends until a later strong result", async () => {
    const { deps } = fixture();
    const retry = deferred();
    deps.verifyCleanup
      .mockRejectedValueOnce(new Error(rawErrorText))
      .mockResolvedValue(pass());
    deps.waitCleanupRetry.mockReturnValueOnce(retry.promise);
    const running = runProviderSessionFlow(deps);
    await vi.waitFor(() =>
      expect(deps.waitCleanupRetry).toHaveBeenCalledOnce(),
    );
    expect(deps.stopOwned).not.toHaveBeenCalled();
    expect(deps.discardSecrets).not.toHaveBeenCalled();
    retry.resolve();
    expect((await running).cleanupConfirmed).toBe(true);
    expect(deps.verifyCleanup).toHaveBeenCalledTimes(2);
  });

  it("stopIntake failure cannot skip the cleanup check or leak its error", async () => {
    const { deps } = fixture();
    deps.stopIntake
      .mockRejectedValueOnce(new Error(rawErrorText))
      .mockResolvedValue();
    expect(await runProviderSessionFlow(deps)).toEqual({
      result: "COMPLETED",
      cleanupConfirmed: true,
    });
    expect(deps.verifyCleanup).toHaveBeenCalled();
    expect(deps.stopIntake).toHaveBeenCalledTimes(2);
    expect(deps.verifyCleanup.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      deps.stopIntake.mock.invocationCallOrder.at(-1)!,
    );
    expect(deps.stopOwned).toHaveBeenCalledOnce();
    expect(deps.status).toHaveBeenCalledWith(
      "INTAKE_STOP_PENDING_CLEANUP_STILL_REQUIRED",
    );
    expect(JSON.stringify(deps.status.mock.calls)).not.toContain(rawErrorText);
  });

  it("cannot use an absence PASS from open intake instead of a fresh post-stop check", async () => {
    const { deps, events } = fixture();
    const retry = deferred();
    const freshCheck = deferred();
    let intakeOpen = true;
    let closedIntakeReadStarted = false;
    deps.stopIntake
      .mockImplementationOnce(async () => {
        events.push("intake-stop-failed-still-open");
        throw new Error(rawErrorText);
      })
      .mockImplementation(async () => {
        events.push("intake-stop-confirmed");
        intakeOpen = false;
      });
    deps.verifyCleanup.mockImplementation(async () => {
      if (intakeOpen) {
        events.push("untrusted-pass-while-intake-open");
        return pass();
      }
      events.push("fresh-absence-read-after-intake-stop");
      closedIntakeReadStarted = true;
      await freshCheck.promise;
      events.push("fresh-absence-confirmed");
      return pass();
    });
    deps.waitCleanupRetry.mockReturnValueOnce(retry.promise);
    const running = runProviderSessionFlow(deps);
    await vi.waitFor(() =>
      expect(deps.waitCleanupRetry).toHaveBeenCalledOnce(),
    );
    expect(intakeOpen).toBe(true);
    expect(deps.stopOwned).not.toHaveBeenCalled();
    expect(deps.discardSecrets).not.toHaveBeenCalled();
    expect(deps.status).not.toHaveBeenCalledWith(
      "PHYSICAL_LOCAL_CLEANUP_CONFIRMED",
    );
    retry.resolve();
    await vi.waitFor(() => expect(closedIntakeReadStarted).toBe(true));
    expect(intakeOpen).toBe(false);
    expect(deps.stopIntake).toHaveBeenCalledTimes(2);
    expect(deps.stopOwned).not.toHaveBeenCalled();
    expect(deps.discardSecrets).not.toHaveBeenCalled();
    freshCheck.resolve();
    expect((await running).cleanupConfirmed).toBe(true);
    expect(
      events.indexOf("fresh-absence-read-after-intake-stop"),
    ).toBeGreaterThan(events.indexOf("intake-stop-confirmed"));
    expect(events.indexOf("stopOwned")).toBeGreaterThan(
      events.indexOf("fresh-absence-confirmed"),
    );
    expect(events.indexOf("discardSecrets")).toBeGreaterThan(
      events.indexOf("stopOwned"),
    );
  });

  it("a failed cleanup retry delay cannot exit while the key and worker are required", async () => {
    const { deps } = fixture();
    const retry = deferred();
    const pending: SessionCleanup = {
      result: "PENDING",
      cleanupCredentialsAbsent: false,
      category: "FICTIONAL_COPY_STILL_PRESENT",
    };
    deps.verifyCleanup
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(pass());
    deps.waitCleanupRetry
      .mockRejectedValueOnce(new Error(rawErrorText))
      .mockReturnValueOnce(retry.promise);
    const running = runProviderSessionFlow(deps);
    await vi.waitFor(() =>
      expect(deps.waitCleanupRetry).toHaveBeenCalledTimes(2),
    );
    expect(deps.stopOwned).not.toHaveBeenCalled();
    expect(deps.discardSecrets).not.toHaveBeenCalled();
    expect(deps.status).not.toHaveBeenCalledWith(
      "PHYSICAL_LOCAL_CLEANUP_CONFIRMED",
    );
    retry.resolve();
    expect((await running).cleanupConfirmed).toBe(true);
    expect(deps.verifyCleanup).toHaveBeenCalledTimes(3);
    expect(deps.discardSecrets).toHaveBeenCalledOnce();
    expect(JSON.stringify(deps.status.mock.calls)).not.toContain(rawErrorText);
  });

  it("retries failed owned-process shutdown without discarding the key early", async () => {
    const { deps, events } = fixture();
    const retry = deferred();
    deps.stopOwned
      .mockImplementationOnce(async () => {
        events.push("stopOwned-pending");
        throw new Error(rawErrorText);
      })
      .mockImplementation(async () => {
        events.push("stopOwned-confirmed");
      });
    deps.waitCleanupRetry.mockReturnValueOnce(retry.promise);
    const running = runProviderSessionFlow(deps);
    await vi.waitFor(() =>
      expect(deps.waitCleanupRetry).toHaveBeenCalledOnce(),
    );
    expect(deps.verifyCleanup).toHaveBeenCalledOnce();
    expect(deps.discardSecrets).not.toHaveBeenCalled();
    expect(deps.status).toHaveBeenCalledWith(
      "OWNED_PROCESS_STOP_PENDING_KEY_RETAINED",
    );
    retry.resolve();
    expect((await running).cleanupConfirmed).toBe(true);
    expect(deps.stopOwned).toHaveBeenCalledTimes(2);
    expect(events.slice(-3)).toEqual([
      "stopOwned-pending",
      "stopOwned-confirmed",
      "discardSecrets",
    ]);
  });

  it("reports only fixed categories through status and never prints raw errors or secrets", async () => {
    const { deps } = fixture();
    const printed = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
    ];
    deps.runAttempt.mockRejectedValue(new Error(rawErrorText));
    deps.stopIntake
      .mockRejectedValueOnce(new Error(rawErrorText))
      .mockResolvedValue();
    deps.verifyCleanup
      .mockRejectedValueOnce(new Error(rawErrorText))
      .mockResolvedValue(pass());
    deps.stopOwned
      .mockRejectedValueOnce(new Error(rawErrorText))
      .mockResolvedValue();
    try {
      expect((await runProviderSessionFlow(deps)).result).toBe("BLOCKED");
      const messages = deps.status.mock.calls.map(([message]) => message);
      expect(messages.every((message) => /^[A-Z_]+$/.test(message))).toBe(true);
      for (const value of [rawErrorText, fictionalToken, fictionalKey])
        expect(JSON.stringify(messages)).not.toContain(value);
      for (const logger of printed) expect(logger).not.toHaveBeenCalled();
    } finally {
      for (const logger of printed) logger.mockRestore();
    }
  });
});
