import { constants, open, rename, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  AppError,
  assertRemoteProviderSmokeEnvironment,
  assertRootSmokeEnvironment,
} from "@captiondoor/domain";

type Env = Record<string, string | undefined>;
type Category =
  | "PROVIDER_MEDIA_CHECKPOINT_SCOPE_INVALID"
  | "PROVIDER_MEDIA_CHECKPOINT_INVALID"
  | "PROVIDER_MEDIA_CHECKPOINT_READ_FAILED"
  | "PROVIDER_MEDIA_CHECKPOINT_WRITE_FAILED"
  | "PROVIDER_MEDIA_CHECKPOINT_ALREADY_EXISTS";
export class ProviderMediaCheckpointError extends AppError {
  constructor(readonly category: Category) {
    super(
      category,
      503,
      "Provider test media checkpoint could not be verified.",
    );
  }
}
type BaseCheckpoint = {
  runId: string;
  householdId: "h1";
  visitId: string;
};
export type ProviderMediaCheckpoint = BaseCheckpoint &
  (
    | { phase: "BEFORE_MEDIA_ALLOCATION" }
    | { phase: "MEDIA_BOUND"; mediaSessionId: string }
  );
export type ProviderMediaScope = {
  householdId: "h1";
  visitId?: string;
  mediaSessionId?: string;
  mediaAttempted: boolean;
};
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function checkpointPath(
  runId: string,
  filename: string,
  repositoryRoot: string,
): string {
  if (!uuid.test(runId))
    throw new ProviderMediaCheckpointError("PROVIDER_MEDIA_CHECKPOINT_INVALID");
  return resolve(repositoryRoot, "output/provider-smoke", runId, filename);
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Credential-free evidence schema only; do not accept additional provider/content fields. */
export function validateProviderMediaCheckpoint(
  value: unknown,
  runId: string,
  visitId: string,
): ProviderMediaCheckpoint {
  const keys = ["runId", "householdId", "visitId", "phase"];
  if (object(value) && value.phase === "MEDIA_BOUND")
    keys.push("mediaSessionId");
  if (
    !uuid.test(runId) ||
    !uuid.test(visitId) ||
    !object(value) ||
    value.runId !== runId ||
    value.householdId !== "h1" ||
    value.visitId !== visitId ||
    !["BEFORE_MEDIA_ALLOCATION", "MEDIA_BOUND"].includes(String(value.phase)) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    (value.phase === "MEDIA_BOUND" &&
      (typeof value.mediaSessionId !== "string" ||
        !uuid.test(value.mediaSessionId)))
  )
    throw new ProviderMediaCheckpointError("PROVIDER_MEDIA_CHECKPOINT_INVALID");
  return value as ProviderMediaCheckpoint;
}

/** No markers means ordinary app media. Partial or conflicting coordinator markers fail closed. */
export function providerMediaCheckpointContext(
  visitId: string,
  env: Env,
): { runId: string; repositoryRoot: string } | undefined {
  const runId = env.CAPTIONDOOR_PROVIDER_SESSION_ID;
  const protocol = env.CAPTIONDOOR_PROVIDER_CHECKPOINT_PROTOCOL;
  if (runId === undefined && protocol === undefined) return undefined;
  try {
    const repositoryRoot = env.CAPTIONDOOR_PROVIDER_EVIDENCE_ROOT;
    if (
      !runId ||
      !uuid.test(runId) ||
      !uuid.test(visitId) ||
      protocol !== "v1" ||
      !repositoryRoot ||
      !isAbsolute(repositoryRoot) ||
      resolve(repositoryRoot) !== repositoryRoot.replace(/\/$/, "")
    )
      throw new Error();
    if (env.CAPTIONDOOR_ENV === "remote-provider")
      assertRemoteProviderSmokeEnvironment(env);
    else assertRootSmokeEnvironment(env);
    return { runId, repositoryRoot: resolve(repositoryRoot) };
  } catch {
    throw new ProviderMediaCheckpointError(
      "PROVIDER_MEDIA_CHECKPOINT_SCOPE_INVALID",
    );
  }
}

/** Missing/unbound evidence proves no provider creation only after owned web termination. */
export function resolveCheckpointMediaScope(
  scope: ProviderMediaScope,
  checkpoint: ProviderMediaCheckpoint | undefined,
  intakeStopped: boolean,
): { mediaSessionId?: string; providerMediaCreationNotReached: boolean } {
  if (
    scope.householdId !== "h1" ||
    typeof scope.mediaAttempted !== "boolean" ||
    (scope.visitId !== undefined && !uuid.test(scope.visitId)) ||
    (scope.mediaSessionId !== undefined &&
      (!uuid.test(scope.mediaSessionId) ||
        !scope.visitId ||
        !scope.mediaAttempted)) ||
    (scope.mediaAttempted && !scope.visitId)
  )
    throw new ProviderMediaCheckpointError(
      "PROVIDER_MEDIA_CHECKPOINT_SCOPE_INVALID",
    );
  if (checkpoint) {
    if (!scope.visitId || !scope.mediaAttempted)
      throw new ProviderMediaCheckpointError(
        "PROVIDER_MEDIA_CHECKPOINT_SCOPE_INVALID",
      );
    const valid = validateProviderMediaCheckpoint(
      checkpoint,
      checkpoint.runId,
      scope.visitId,
    );
    if (valid.phase === "MEDIA_BOUND") {
      if (scope.mediaSessionId && scope.mediaSessionId !== valid.mediaSessionId)
        throw new ProviderMediaCheckpointError(
          "PROVIDER_MEDIA_CHECKPOINT_SCOPE_INVALID",
        );
      return {
        mediaSessionId: valid.mediaSessionId,
        providerMediaCreationNotReached: false,
      };
    }
  }
  return {
    ...(scope.mediaSessionId ? { mediaSessionId: scope.mediaSessionId } : {}),
    providerMediaCreationNotReached:
      intakeStopped && scope.mediaAttempted && !scope.mediaSessionId,
  };
}

export type ProviderMediaCheckpointIo = {
  canonicalRoot(path: string): Promise<string>;
  readJson(path: string): Promise<unknown | undefined>;
  createJson(path: string, value: ProviderMediaCheckpoint): Promise<void>;
  replaceJson(path: string, value: ProviderMediaCheckpoint): Promise<void>;
};
async function createJson(path: string, value: ProviderMediaCheckpoint) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
}
const filesystemIo: ProviderMediaCheckpointIo = {
  canonicalRoot: realpath,
  async readJson(path) {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096) throw new Error();
      return JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new ProviderMediaCheckpointError(
        "PROVIDER_MEDIA_CHECKPOINT_READ_FAILED",
      );
    } finally {
      await handle?.close();
    }
  },
  createJson,
  async replaceJson(path, value) {
    const temporary = `${path}.tmp`;
    await createJson(temporary, value);
    await rename(temporary, path);
  },
};

/** Injected I/O is for pure fictional tests; runtime uses only the anchored evidence directory. */
export function createProviderMediaCheckpointStore(
  io: ProviderMediaCheckpointIo = filesystemIo,
) {
  const canonicalRoot = async (root: string) => {
    try {
      if (!isAbsolute(root) || resolve(root) !== root.replace(/\/$/, ""))
        throw new Error();
      const canonical = await io.canonicalRoot(root);
      if (canonical !== resolve(root)) throw new Error();
      return canonical;
    } catch {
      throw new ProviderMediaCheckpointError(
        "PROVIDER_MEDIA_CHECKPOINT_SCOPE_INVALID",
      );
    }
  };
  return {
    async begin(
      visitId: string,
      env: Env = process.env,
    ): Promise<ProviderMediaCheckpoint | undefined> {
      const context = providerMediaCheckpointContext(visitId, env);
      if (!context) return undefined;
      const { runId } = context;
      const root = await canonicalRoot(context.repositoryRoot);
      const scope = await io.readJson(
        checkpointPath(runId, "scope.json", root),
      );
      if (
        !object(scope) ||
        scope.householdId !== "h1" ||
        scope.visitId !== visitId ||
        scope.mediaAttempted !== true ||
        scope.mediaSessionId !== undefined ||
        Object.keys(scope).some(
          (key) =>
            ![
              "householdId",
              "visitId",
              "mediaAttempted",
              "mediaSessionId",
            ].includes(key),
        )
      )
        throw new ProviderMediaCheckpointError(
          "PROVIDER_MEDIA_CHECKPOINT_SCOPE_INVALID",
        );
      const checkpoint: ProviderMediaCheckpoint = {
        runId,
        householdId: "h1",
        visitId,
        phase: "BEFORE_MEDIA_ALLOCATION",
      };
      try {
        await io.createJson(
          checkpointPath(runId, "media-attempt.json", root),
          checkpoint,
        );
      } catch (error) {
        throw new ProviderMediaCheckpointError(
          (error as NodeJS.ErrnoException).code === "EEXIST"
            ? "PROVIDER_MEDIA_CHECKPOINT_ALREADY_EXISTS"
            : "PROVIDER_MEDIA_CHECKPOINT_WRITE_FAILED",
        );
      }
      return checkpoint;
    },
    async bind(
      checkpoint: ProviderMediaCheckpoint,
      mediaSessionId: string,
      env: Env = process.env,
    ): Promise<ProviderMediaCheckpoint> {
      const valid = validateProviderMediaCheckpoint(
        checkpoint,
        checkpoint.runId,
        checkpoint.visitId,
      );
      if (
        valid.phase !== "BEFORE_MEDIA_ALLOCATION" ||
        !uuid.test(mediaSessionId)
      )
        throw new ProviderMediaCheckpointError(
          "PROVIDER_MEDIA_CHECKPOINT_INVALID",
        );
      const context = providerMediaCheckpointContext(valid.visitId, env);
      if (!context || context.runId !== valid.runId)
        throw new ProviderMediaCheckpointError(
          "PROVIDER_MEDIA_CHECKPOINT_SCOPE_INVALID",
        );
      const root = await canonicalRoot(context.repositoryRoot);
      const path = checkpointPath(valid.runId, "media-attempt.json", root);
      const current = validateProviderMediaCheckpoint(
        await io.readJson(path),
        valid.runId,
        valid.visitId,
      );
      if (current.phase !== "BEFORE_MEDIA_ALLOCATION")
        throw new ProviderMediaCheckpointError(
          "PROVIDER_MEDIA_CHECKPOINT_ALREADY_EXISTS",
        );
      const bound: ProviderMediaCheckpoint = {
        ...valid,
        phase: "MEDIA_BOUND",
        mediaSessionId,
      };
      try {
        await io.replaceJson(path, bound);
      } catch {
        throw new ProviderMediaCheckpointError(
          "PROVIDER_MEDIA_CHECKPOINT_WRITE_FAILED",
        );
      }
      return bound;
    },
    async read(
      runId: string,
      visitId: string,
      repositoryRoot: string,
    ): Promise<ProviderMediaCheckpoint | undefined> {
      if (!uuid.test(visitId))
        throw new ProviderMediaCheckpointError(
          "PROVIDER_MEDIA_CHECKPOINT_INVALID",
        );
      const root = await canonicalRoot(repositoryRoot);
      const value = await io.readJson(
        checkpointPath(runId, "media-attempt.json", root),
      );
      return value === undefined
        ? undefined
        : validateProviderMediaCheckpoint(value, runId, visitId);
    },
  };
}
const store = createProviderMediaCheckpointStore();
export const beginProviderMediaCheckpoint = store.begin;
export const bindProviderMediaCheckpoint = store.bind;
export const readProviderMediaCheckpoint = store.read;
