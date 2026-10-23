import type {
  Reporter,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";

function scrub(error?: TestError): void {
  if (!error) return;
  for (const key of ["message", "stack", "value", "snippet"] as const)
    if (typeof error[key] === "string")
      error[key] = "Provider smoke failed; consult sanitized result.json.";
  if (error.cause) scrub(error.cause);
}
function scrubStep(step: TestStep): void {
  scrub(step.error);
  for (const child of step.steps) scrubStep(child);
}
/** No console/HTML reporter and no error contents, provider payloads or attachments. */
export default class SanitizedReporter implements Reporter {
  printsToStdio() {
    return true;
  }
  onTestEnd(_test: TestCase, result: TestResult): void {
    scrub(result.error);
    for (const error of result.errors) scrub(error);
    for (const step of result.steps) scrubStep(step);
    result.attachments.length = 0;
    result.stdout.length = 0;
    result.stderr.length = 0;
  }
}
