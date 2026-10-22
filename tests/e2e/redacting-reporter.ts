import type {
  Reporter,
  TestCase,
  TestResult,
  TestError,
  TestStep,
} from "@playwright/test/reporter";
import { readFileSync, writeFileSync } from "node:fs";

export function redactDiagnostic(text: string): string {
  return text
    .replace(/((?:set-)?cookie:\s*)[^\r\n]*/gi, "$1[redacted]")
    .replace(/((?:x-csrf-token|authorization):\s*)[^\r\n]*/gi, "$1[redacted]")
    .replace(/\b(cd_session|cd_guest)=[A-Za-z0-9_%.-]+/g, "$1=[redacted]");
}
export function redactTestError(error?: TestError): void {
  if (!error) return;
  for (const key of ["message", "stack", "value", "snippet"] as const) {
    if (typeof error[key] === "string")
      error[key] = redactDiagnostic(error[key]!);
  }
  if (error.cause) redactTestError(error.cause);
}
function redactStep(step: TestStep): void {
  redactTestError(step.error);
  for (const nested of step.steps) redactStep(nested);
}

/** Runs before console/HTML reporters; keeps failure causes while stripping credentials. */
export default class RedactingReporter implements Reporter {
  printsToStdio() {
    return false;
  }
  onTestEnd(_test: TestCase, result: TestResult): void {
    for (const error of result.errors) redactTestError(error);
    redactTestError(result.error);
    for (const step of result.steps) redactStep(step);
    for (const attachment of result.attachments) {
      if (attachment.body && /(?:text|json)/i.test(attachment.contentType)) {
        attachment.body = Buffer.from(
          redactDiagnostic(attachment.body.toString("utf8")),
        );
      }
      if (attachment.path && /\.(md|txt|json)$/.test(attachment.path)) {
        const text = readFileSync(attachment.path, "utf8");
        const safe = redactDiagnostic(text);
        if (safe !== text) writeFileSync(attachment.path, safe);
      }
    }
  }
}
