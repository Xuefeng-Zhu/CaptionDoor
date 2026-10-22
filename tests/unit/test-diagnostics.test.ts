import { describe, it, expect } from "vitest";
import { redactDiagnostic, redactTestError } from "../e2e/redacting-reporter";
describe("test transport diagnostics protect sessions without hiding failures", () => {
  it("removes request credentials while retaining the transport failure and subsequent details", () => {
    const raw =
      "socket hang up (ECONNRESET)\n- cookie: cd_session=synthetic-session; cd_guest=synthetic-guest\n- x-csrf-token: synthetic-csrf\n- authorization: Bearer synthetic-access\nExpected state was not observed.";
    const safe = redactDiagnostic(raw);
    expect(safe).toContain("ECONNRESET");
    expect(safe).toContain("Expected state was not observed.");
    for (const secret of [
      "synthetic-session",
      "synthetic-guest",
      "synthetic-csrf",
      "synthetic-access",
    ])
      expect(safe).not.toContain(secret);
  });
  it("redacts nested framework step errors and leaves the cause description intact", () => {
    const error = {
      message: "Request failed (ETIMEDOUT)",
      stack: "cd_guest=synthetic-guest",
      cause: {
        message: "- cookie: cd_session=synthetic-session\nConnection closed.",
      },
    };
    redactTestError(error);
    expect(error.message).toContain("ETIMEDOUT");
    expect(error.stack).not.toContain("synthetic-guest");
    expect(error.cause.message).toContain("Connection closed.");
    expect(error.cause.message).not.toContain("synthetic-session");
  });
});
