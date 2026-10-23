import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "@captiondoor/domain";

/** Server-only fixed repository marker. Never resolve it against a caller's cwd. */
export const localRootRetirementMarkerPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../output/provider-smoke/local-scope-retired.json",
);

/** Any marker, even malformed or a dangling symlink, retires the old paid budget. */
export function assertLocalRootScopeAvailable(
  inspect: (path: string) => unknown = lstatSync,
): void {
  try {
    inspect(localRootRetirementMarkerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
  }
  throw new AppError(
    "ROOT_SMOKE_SCOPE_RETIRED",
    403,
    "The Local paid-test scope is retired. Use its approved carried-forward remote budget.",
  );
}
