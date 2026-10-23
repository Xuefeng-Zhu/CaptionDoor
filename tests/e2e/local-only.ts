import {
  assertReplayModes,
  assertReplayTarget,
} from "../../scripts/judge-replay";
export default async function localOnly() {
  const origin = assertReplayTarget(
    process.env.E2E_BASE_URL || "http://127.0.0.1:3410",
    process.env.NODE_ENV,
  );
  const get = async (url: string) => {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok)
      throw new Error("Local browser test health precondition failed.");
    return response.json();
  };
  const [web, worker] = await Promise.all([
    get(`${origin}/api/health`),
    get("http://127.0.0.1:3411/health"),
  ]);
  assertReplayModes(web, worker);
}
