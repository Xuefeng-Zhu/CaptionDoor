import { readFile, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { remoteProviderSmokeConfig } from "@captiondoor/domain";
import {
  runProviderSessionCoordinator,
  type OwnedSessionCommand,
} from "./provider-session";
import {
  parseRemoteSessionArgs,
  parseRemoteSessionBaseline,
  buildRemoteSessionBaseEnvironment,
  buildRemoteSessionEnvironment,
  RemoteSessionError,
} from "./provider-session-remote-config";
const root = fileURLToPath(new URL("../", import.meta.url));

async function prepareStorage(
  env: NodeJS.ProcessEnv,
  run: OwnedSessionCommand,
): Promise<void> {
  const result = await run(
    process.execPath,
    ["--import", "tsx", "scripts/provider-session-remote-storage.ts", "setup"],
    env,
    60000,
  );
  if (result.code !== 0)
    throw new RemoteSessionError("REMOTE_READINESS_OR_SEED_NOT_VERIFIED");
}

export async function mainRemoteSession(
  args = process.argv.slice(2),
): Promise<number> {
  const options = parseRemoteSessionArgs(args);
  if (!options.start) {
    console.log(
      "Usage: corepack pnpm provider:session:remote --start --approved-aws-writes --approved-cloud-storage --approved-cleanup [--approved-root] --profile APPROVED_PROFILE --baseline /absolute/reviewed-receipt.json\nPrepared remote provider path; cloud provisioning/access/storage approvals are separate human decisions. Hidden user-terminal token intake only. No Docker, deployment, IAM creation, token generation or zero-baseline assumption. --help makes no requests.",
    );
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new RemoteSessionError("INTERACTIVE_USER_TERMINAL_REQUIRED");
  let baseline;
  try {
    baseline = parseRemoteSessionBaseline(
      await readFile(options.baselinePath, "utf8"),
    );
  } catch {
    throw new RemoteSessionError("REVIEWED_CARRY_FORWARD_RECEIPT_REQUIRED");
  }
  const inherited = { ...process.env };
  const base = buildRemoteSessionBaseEnvironment(
    inherited,
    options.profile,
    baseline,
    options.allowRoot,
  );
  return runProviderSessionCoordinator(base, inherited, {
    scope: remoteProviderSmokeConfig.scope,
    tablePrefix: remoteProviderSmokeConfig.tablePrefix,
    storageHelper: "scripts/provider-session-remote-storage.ts",
    buildEnvironment: (secrets) => buildRemoteSessionEnvironment(base, secrets),
    prepare: async (run) => {
      // Retire the old local launcher before creating another budget authority. Never remove this
      // marker automatically; a failed preparation does not reset previous reservations.
      await mkdir(resolve(root, "output/provider-smoke"), { recursive: true });
      const marker = resolve(
        root,
        "output/provider-smoke/local-scope-retired.json",
      );
      try {
        const handle = await open(marker, "wx", 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({
              scope: remoteProviderSmokeConfig.scope,
              baselineSha256: baseline.baselineSha256,
            }),
          );
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          throw new RemoteSessionError("LOCAL_SCOPE_RETIREMENT_UNCONFIRMED");
        try {
          const existing = JSON.parse(await readFile(marker, "utf8"));
          if (
            existing.scope !== remoteProviderSmokeConfig.scope ||
            existing.baselineSha256 !== baseline.baselineSha256
          )
            throw new Error();
        } catch {
          throw new RemoteSessionError("LOCAL_SCOPE_BASELINE_CONFLICT");
        }
      }
      await prepareStorage(base, run);
    },
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  mainRemoteSession()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        error instanceof RemoteSessionError
          ? error.category
          : "REMOTE_SESSION_BLOCKED_CHECK_SAFE_PREREQUISITES",
      );
      process.exitCode = 2;
    });
