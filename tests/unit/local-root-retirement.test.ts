import { describe, expect, it, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLocalRootScopeAvailable,
  localRootRetirementMarkerPath,
} from "../../packages/db/src/local-root-retirement";

describe("server-only Local paid scope retirement marker", () => {
  it("checks the canonical repository marker independent of launch cwd", () => {
    expect(localRootRetirementMarkerPath).toBe(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../output/provider-smoke/local-scope-retired.json",
      ),
    );
    const inspect = vi.fn(() => {
      throw Object.assign(new Error(), { code: "ENOENT" });
    });
    expect(() => assertLocalRootScopeAvailable(inspect)).not.toThrow();
    expect(inspect).toHaveBeenCalledExactlyOnceWith(
      localRootRetirementMarkerPath,
    );
  });
  it.each([{}, { isSymbolicLink: () => true }, undefined, "malformed JSON"])(
    "refuses any existing marker without trusting its contents %j",
    (entry) => {
      expect(() => assertLocalRootScopeAvailable(() => entry)).toThrowError(
        expect.objectContaining({ code: "ROOT_SMOKE_SCOPE_RETIRED" }),
      );
    },
  );
  it.each(["EACCES", "EPERM", "ENOTDIR", "EIO", undefined])(
    "fails closed on an unavailable marker inspection %s",
    (code) => {
      expect(() =>
        assertLocalRootScopeAvailable(() => {
          throw Object.assign(new Error(), { code });
        }),
      ).toThrowError(
        expect.objectContaining({ code: "ROOT_SMOKE_SCOPE_RETIRED" }),
      );
    },
  );
});
