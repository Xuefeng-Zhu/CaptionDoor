import {
  test,
  type APIRequestContext,
  type BrowserContext,
  type APIResponse,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertActiveProviderSmokeEnvironment,
  assertRootSmokeEnvironment,
  type Bootstrap,
  type Visit,
  type VisitView,
} from "@captiondoor/domain";
import {
  PCM_BYTES,
  PCM_HEADER_BYTES,
} from "@captiondoor/integrations/audio/protocol";
import {
  assertProviderSmokeHealth,
  smokeOrigin,
  smokeWorkerOrigin,
  summarizeProviderCaptions,
  rootSmokeBudgetEvidence,
  rootSmokeReceiptEvidence,
  type RootSmokeReceiptEvidence,
  type RootSmokeBudgetEvidence,
  type SmokeStage,
} from "../../scripts/provider-smoke-config";

import {
  remoteProviderBudgetEvidence,
  remoteProviderReceiptEvidence,
} from "../../scripts/remote-provider-evidence";
import {
  classifyProviderMediaWaitFailure,
  sanitizeMediaHttpEvidence,
  type ProviderMediaHttpDiagnostics,
} from "../../scripts/provider-media-diagnostics";

type Outcome = "PASS" | "FAIL" | "SKIP" | "BLOCKED";
class SmokeFailure extends Error {
  constructor(
    readonly category: string,
    readonly outcome: Outcome = "FAIL",
  ) {
    super(category);
  }
}
function requireCondition(
  condition: unknown,
  category: string,
): asserts condition {
  if (!condition) throw new SmokeFailure(category);
}
function headers(csrf: string) {
  return {
    Origin: smokeOrigin,
    "X-CSRF-Token": csrf,
    "Idempotency-Key": randomUUID(),
  };
}
/** Transport exceptions can include request cookies; never propagate their text. */
function protectRequests(context: BrowserContext): void {
  const request = context.request as unknown as Record<
    string,
    (...args: any[]) => Promise<unknown>
  >;
  for (const method of [
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "head",
    "fetch",
  ]) {
    const original = request[method].bind(context.request);
    request[method] = async (...args: any[]) => {
      try {
        return await original(...args);
      } catch {
        throw new SmokeFailure("LOCAL_API_TRANSPORT_FAILED");
      }
    };
  }
}
async function json<T>(response: APIResponse, category: string): Promise<T> {
  requireCondition(response.ok(), category);
  try {
    return (await response.json()) as T;
  } catch {
    throw new SmokeFailure("LOCAL_API_RESPONSE_INVALID");
  }
}
async function getView(
  request: APIRequestContext,
  id: string,
  timeout = 4000,
): Promise<VisitView> {
  return json<VisitView>(
    await request.get(`/api/visits/${id}`, { timeout }),
    "OWN_VISIT_READ_FAILED",
  );
}
async function completeHistory(
  request: APIRequestContext,
  first: VisitView,
  deadline: number,
): Promise<VisitView> {
  const items = [...first.items];
  let cursor = first.nextCursor;
  const cursors = new Set<string>();
  for (let page = 0; cursor; page++) {
    requireCondition(
      page < 10 && !cursors.has(cursor),
      "HISTORY_PAGINATION_BOUND_EXCEEDED",
    );
    requireCondition(
      Date.now() < deadline - 500,
      "HISTORY_NOT_COMPLETE_WITHIN_MEDIA_BOUND",
    );
    cursors.add(cursor);
    const next = await json<VisitView>(
      await request.get(
        `/api/visits/${first.visit.id}?cursor=${encodeURIComponent(cursor)}`,
        { timeout: Math.max(1, Math.min(2000, deadline - Date.now())) },
      ),
      "OWN_HISTORY_PAGE_READ_FAILED",
    );
    requireCondition(
      next.visit.id === first.visit.id,
      "HISTORY_VISIT_MISMATCH",
    );
    items.push(...next.items);
    cursor = next.nextCursor;
  }
  return { ...first, items };
}
async function command(
  request: APIRequestContext,
  id: string,
  csrf: string,
  body: unknown,
): Promise<Visit> {
  const result = await json<{ visit: Visit }>(
    await request.post(`/api/visits/${id}/commands`, {
      data: body,
      headers: headers(csrf),
      timeout: 5000,
    }),
    "OWN_VISIT_COMMAND_FAILED",
  );
  return result.visit;
}

// Deliberately outside ordinary test:e2e. No service startup or credential setup here.
test("approved isolated Playground incoming media and optional AWS captions", async ({
  browser,
}) => {
  const stage = process.env.CAPTIONDOOR_SMOKE_STAGE as SmokeStage;
  const runId = process.env.CAPTIONDOOR_SMOKE_RUN_ID || "";
  const rootMarkersPresent =
    process.env.CAPTIONDOOR_ROOT_SMOKE !== undefined ||
    process.env.CAPTIONDOOR_ROOT_SMOKE_APPROVAL !== undefined;
  const rootSmokeRequested = process.env.CAPTIONDOOR_ROOT_SMOKE === "1";
  const remoteSmokeRequested =
    process.env.CAPTIONDOOR_ENV === "remote-provider";
  const reservationRequired = rootSmokeRequested || remoteSmokeRequested;
  const budgetEvidence = remoteSmokeRequested
    ? remoteProviderBudgetEvidence
    : rootSmokeBudgetEvidence;
  const receiptEvidence = remoteSmokeRequested
    ? remoteProviderReceiptEvidence
    : rootSmokeReceiptEvidence;
  if (rootMarkersPresent) {
    try {
      if (stage !== "captions") throw new Error("Invalid root smoke stage");
      assertRootSmokeEnvironment(process.env);
    } catch {
      throw new Error(
        "BLOCKED: explicit fixed-scope root captions approval is required.",
      );
    }
  }
  let prefix = "";
  try {
    prefix = assertActiveProviderSmokeEnvironment(process.env).tablePrefix;
  } catch {
    throw new Error("BLOCKED: isolated smoke configuration is required.");
  }
  if (
    process.env.CAPTIONDOOR_PROVIDER_SMOKE_RUN !== "1" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      runId,
    ) ||
    (stage !== "ring-audio" && stage !== "captions") ||
    process.env.CAPTIONDOOR_SMOKE_APPROVAL !== stage ||
    !process.env.CAPTIONDOOR_SMOKE_DEVICE_ID
  )
    throw new Error(
      "BLOCKED: run the approved launcher after zero-network preflight.",
    );

  const ownedScope: {
    householdId: "h1";
    visitId?: string;
    mediaSessionId?: string;
    mediaAttempted: boolean;
  } = { householdId: "h1", mediaAttempted: false };
  const checkpointScope = async () => {
    const directory = resolve("output/provider-smoke", runId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, "scope.tmp.json"),
      JSON.stringify(ownedScope),
    );
    await rename(
      resolve(directory, "scope.tmp.json"),
      resolve(directory, "scope.json"),
    );
  };
  await checkpointScope(); // Before any local event/media; no secret or content fields.
  const report = {
    ownedScope,
    runId,
    stage,
    startedAt: new Date().toISOString(),
    result: "BLOCKED" as Outcome,
    category: "LOCAL_HEALTH_NOT_CHECKED",
    provenance: {
      event: "UNOBSERVED",
      media: "UNOBSERVED",
      transcript: "UNOBSERVED",
      database: remoteSmokeRequested ? "AWS DynamoDB" : "DynamoDB Local",
    },
    observed: {
      localHealth: false,
      providerMetadata: false,
      incomingAudioTrack: false,
      incomingVideoTrack: false,
      awsFinalPersisted: false,
      residentFinalRendered: false,
    },
    mediaHttp: {
      start: null,
      ready: null,
    } as ProviderMediaHttpDiagnostics,
    counts: {
      mediaAttempts: 0,
      incomingVideoTracks: 0,
      outgoingBinaryChunks: 0,
      outgoingBinaryBytes: 0,
      expectedSizedPcmFrames: 0,
      awsFinals: 0,
      uniqueAwsFinals: 0,
      fixtureCaptions: 0,
      residentMicrophoneRequests: 0,
    },
    cleanup: {
      mediaEndRequested: false,
      visitClosed: false,
      contentDeletionRequested: false,
      contentAccessDenied: false,
      physicalDeletionObserved: false,
      providerDeleteObserved: false,
    },
    rootSmoke: {
      requested: rootSmokeRequested,
      rootIdentityVerified: false,
      verifiedIdentity: "UNOBSERVED" as "UNOBSERVED" | "ROOT" | "NON_ROOT",
      receipt: null as RootSmokeReceiptEvidence | null,
      durableReservationLedgerObserved: false,
      before: null as RootSmokeBudgetEvidence | null,
      after: null as RootSmokeBudgetEvidence | null,
      actualAwsBillingObserved: false,
    },
    remoteProviderSmoke: {
      requested: remoteSmokeRequested,
      rootIdentityVerified: false,
      verifiedIdentity: "UNOBSERVED" as "UNOBSERVED" | "ROOT" | "NON_ROOT",
      receipt: null as RootSmokeReceiptEvidence | null,
      durableReservationLedgerObserved: false,
      before: null as RootSmokeBudgetEvidence | null,
      after: null as RootSmokeBudgetEvidence | null,
      actualAwsBillingObserved: false,
    },
    limits: {
      maximumMediaSeconds: 30,
      oneAttemptOnly: true,
      totalApprovedAttemptsManuallyTracked: !reservationRequired,
      durableReservationBackstopRequested: reservationRequired,
    },
  };
  const reservationReport = remoteSmokeRequested
    ? report.remoteProviderSmoke
    : report.rootSmoke;
  const evidenceDir = resolve("output/provider-smoke", runId);
  const context = await browser.newContext({
    baseURL: smokeOrigin,
    permissions: [],
  });
  protectRequests(context);
  let ownedVisitId: string | undefined;
  let csrf = "";
  let residentId = "";
  let mediaSessionId: string | undefined;
  let page: Awaited<ReturnType<typeof context.newPage>> | undefined;
  const observeVideoTracks = async () => {
    if (!page) return;
    const count = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll("video")).reduce(
          (total, video) => {
            const stream = video.srcObject;
            return (
              total +
              (stream instanceof MediaStream
                ? stream
                    .getVideoTracks()
                    .filter((track) => track.readyState === "live").length
                : 0)
            );
          },
          0,
        ),
      )
      .catch(() => 0);
    report.counts.incomingVideoTracks = Math.max(
      report.counts.incomingVideoTracks,
      count,
    );
    report.observed.incomingVideoTrack ||= count > 0;
  };
  let currentStage = "LOCAL_HEALTH";
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let boundedMediaStop: Promise<void> | undefined;
  const pendingMediaDiagnostics = new Set<Promise<void>>();
  let rootReceiptInvalid = false;
  try {
    const [web, worker] = await Promise.all([
      context.request
        .get("/api/health", { timeout: 4000 })
        .then((r) => json(r, "WEB_HEALTH_UNAVAILABLE")),
      context.request
        .get(`${smokeWorkerOrigin}/health`, { timeout: 4000 })
        .then((r) => json(r, "WORKER_HEALTH_UNAVAILABLE")),
    ]);
    try {
      assertProviderSmokeHealth(web, worker, stage, prefix);
    } catch {
      throw new SmokeFailure("PROVIDER_SMOKE_HEALTH_MISMATCH", "BLOCKED");
    }
    report.observed.localHealth = true;
    currentStage = "DEMO_IDENTITY_AND_CONSENT";
    const login = await json<{ csrf: string }>(
      await context.request.post("/api/auth/demo", {
        data: { identity: "alex" },
        headers: { Origin: smokeOrigin },
        timeout: 4000,
      }),
      "LOCAL_FICTIONAL_LOGIN_FAILED",
    );
    const boot = await json<Bootstrap>(
      await context.request.get("/api/me", { timeout: 4000 }),
      "LOCAL_BOOTSTRAP_FAILED",
    );
    requireCondition(
      boot.household.id === "h1" && boot.user.id === "alex",
      "FIXED_FICTIONAL_TENANT_REQUIRED",
    );
    csrf = login.csrf || boot.csrf;
    residentId = boot.user.id;
    requireCondition(csrf && residentId, "LOCAL_SESSION_INVALID");
    requireCondition(
      boot.visits.every((v) => v.status === "CLOSED"),
      "EXISTING_ACTIVE_VISIT_REFUSED",
    );
    requireCondition(
      boot.mode.auth === "demo" &&
        boot.mode.ring === "playground" &&
        boot.mode.transcribe === (stage === "captions" ? "aws" : "fixture"),
      "BOOTSTRAP_MODE_MISMATCH",
    );
    if (reservationRequired) {
      currentStage = "PROVIDER_RESERVATION_BUDGET_BEFORE";
      const budget = await json<unknown>(
        await context.request.get("/api/provider-smoke/budget", {
          timeout: 4000,
        }),
        "PROVIDER_RESERVATION_BUDGET_UNAVAILABLE",
      );
      try {
        reservationReport.before = budgetEvidence(budget, process.env, true);
      } catch {
        throw new SmokeFailure(
          "PROVIDER_RESERVATION_BUDGET_INVALID_OR_EXHAUSTED",
          "BLOCKED",
        );
      }
      reservationReport.durableReservationLedgerObserved = true;
    }
    await json(
      await context.request.post("/api/settings", {
        data: {
          ...boot.settings,
          consent: {
            ring: true,
            transcription: stage === "captions",
            sharing: false,
          },
        },
        headers: headers(csrf),
        timeout: 4000,
      }),
      "SMOKE_CONSENT_FAILED",
    );

    currentStage = "PLAYGROUND_METADATA";
    const devices = await json<{ devices: { id: string }[] }>(
      await context.request.get("/api/ring/devices", { timeout: 8000 }),
      "PLAYGROUND_DEVICE_DISCOVERY_FAILED",
    );
    requireCondition(
      Array.isArray(devices.devices) &&
        devices.devices.some(
          (d) => d.id === process.env.CAPTIONDOOR_SMOKE_DEVICE_ID,
        ),
      "APPROVED_DEVICE_NOT_AVAILABLE",
    );
    report.observed.providerMetadata = true;
    await json(
      await context.request.post("/api/ring/select-door", {
        data: { deviceId: process.env.CAPTIONDOOR_SMOKE_DEVICE_ID },
        headers: headers(csrf),
        timeout: 8000,
      }),
      "PLAYGROUND_DEVICE_SELECTION_FAILED",
    );
    currentStage = "LOCAL_EVENT";
    const pressed = await json<{
      visit: Visit;
      duplicate: boolean;
      localSimulation: boolean;
      eventSource: string;
    }>(
      await context.request.post("/api/provider-smoke/press", {
        data: { eventId: randomUUID() },
        headers: headers(csrf),
        timeout: 4000,
      }),
      "LOCAL_SMOKE_EVENT_FAILED",
    );
    // A concurrent active visit must never be taken over or deleted by this harness.
    requireCondition(
      !pressed.duplicate &&
        pressed.localSimulation === true &&
        pressed.eventSource === "LOCAL" &&
        pressed.visit.eventSource === "LOCAL" &&
        pressed.visit.status === "UNCLAIMED" &&
        pressed.visit.version === 1 &&
        !boot.visits.some((v) => v.id === pressed.visit.id),
      "NEW_OWN_LOCAL_VISIT_NOT_ESTABLISHED",
    );
    ownedVisitId = pressed.visit.id;
    ownedScope.visitId = ownedVisitId;
    await checkpointScope();
    report.provenance.event = "LOCAL";
    await command(context.request, ownedVisitId, csrf, {
      type: "claim",
      expectedVersion: pressed.visit.version,
    });
    const claimed = await getView(context.request, ownedVisitId);
    requireCondition(
      claimed.visit.handlerId === residentId &&
        claimed.visit.status === "CLAIMED",
      "OWN_CLAIM_NOT_CONFIRMED",
    );
    requireCondition(
      !claimed.items.some((i) => i.kind === "caption") &&
        claimed.threads.length === 0,
      "SMOKE_VISIT_NOT_EMPTY",
    );

    page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(window, "__captionDoorMicrophoneRequests", {
        value: 0,
        writable: true,
      });
      if (navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = async () => {
          (window as unknown as { __captionDoorMicrophoneRequests: number })
            .__captionDoorMicrophoneRequests++;
          throw new Error("Resident microphone is forbidden in this smoke.");
        };
    });
    page.on("websocket", (socket) => {
      if (socket.url() !== `${smokeWorkerOrigin.replace("http:", "ws:")}/ws`)
        return;
      socket.on("framereceived", (frame) => {
        if (
          !reservationRequired ||
          typeof frame.payload !== "string" ||
          frame.payload.length > 8192 ||
          !reservationReport.before
        )
          return;
        let data;
        try {
          data = JSON.parse(frame.payload);
        } catch {
          return;
        }
        if (
          data.type !== "capture-ready" ||
          data.visitId !== ownedVisitId ||
          data.mediaSessionId !== mediaSessionId
        )
          return;
        try {
          const receipt = receiptEvidence(
            remoteSmokeRequested ? data.remoteProviderSmoke : data.rootSmoke,
            reservationReport.before,
            process.env,
          );
          reservationReport.receipt = receipt;
          reservationReport.verifiedIdentity = receipt.identity;
          reservationReport.rootIdentityVerified = receipt.identity === "ROOT";
        } catch {
          rootReceiptInvalid = true;
        }
      });
      socket.on("framesent", (frame) => {
        if (typeof frame.payload === "string") return;
        report.counts.outgoingBinaryChunks++;
        report.counts.outgoingBinaryBytes += frame.payload.byteLength;
        if (frame.payload.byteLength === PCM_BYTES + PCM_HEADER_BYTES)
          report.counts.expectedSizedPcmFrames++;
      });
    });
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url() === `${smokeOrigin}/api/visits/${ownedVisitId}/media`
      )
        report.counts.mediaAttempts++;
    });
    page.on("response", (response) => {
      if (response.request().method() !== "POST") return;
      const endpoint = response.url();
      const kind =
        endpoint === `${smokeOrigin}/api/visits/${ownedVisitId}/media`
          ? "start"
          : endpoint === `${smokeOrigin}/api/visits/${ownedVisitId}/media/ready`
            ? "ready"
            : undefined;
      if (!kind) return;
      const status = response.status();
      report.mediaHttp[kind] = sanitizeMediaHttpEvidence(status);
      if (status >= 200 && status < 300) return; // Success contains SDP; never inspect its body.
      const task = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const evidence = await Promise.race([
            response
              .json()
              .then((body: unknown) => sanitizeMediaHttpEvidence(status, body)),
            new Promise<ReturnType<typeof sanitizeMediaHttpEvidence>>(
              (resolve) => {
                timer = setTimeout(
                  () => resolve(sanitizeMediaHttpEvidence(status)),
                  500,
                );
              },
            ),
          ]);
          report.mediaHttp[kind] = evidence;
        } catch {
          // Transport/parse errors may contain private response material. Keep only the known status.
        } finally {
          if (timer) clearTimeout(timer);
        }
      })();
      pendingMediaDiagnostics.add(task);
      void task.finally(() => pendingMediaDiagnostics.delete(task));
    });
    await page.goto(`/visits/${ownedVisitId}`, {
      timeout: 8000,
      waitUntil: "domcontentloaded",
    });
    requireCondition(
      (await page
        .getByRole("button", { name: "Start Demo transcript", exact: true })
        .count()) === 0,
      "FIXTURE_CONTROL_PRESENT",
    );
    await page
      .getByRole("checkbox", {
        name: "Select incoming remote audio for captions",
        exact: true,
      })
      .check({ timeout: 4000 });
    currentStage = "INCOMING_RING_MEDIA";
    const deadline = Date.now() + 25_000;
    // Stop at 25 seconds, reserving time for local stop authorization within the 30-second attempt.
    deadlineTimer = setTimeout(() => {
      boundedMediaStop = (async () => {
        if (!ownedVisitId) return;
        const state = await getView(context.request, ownedVisitId, 2000);
        if (state.visit.mediaSessionId) {
          mediaSessionId = state.visit.mediaSessionId;
          const ended = await context.request.delete(
            `/api/visits/${ownedVisitId}/media/${mediaSessionId}`,
            { headers: headers(csrf), timeout: 2500 },
          );
          report.cleanup.mediaEndRequested = ended.ok();
        }
      })().catch(() => {
        /* Finally still attempts close/revoke. */
      });
    }, 25_000);
    ownedScope.mediaAttempted = true;
    await checkpointScope(); // Durable own visit ID precedes the first media POST.
    await page
      .getByRole("button", { name: "Open incoming media", exact: true })
      .click({ timeout: 4000 });
    try {
      await page
        .getByText("Incoming audio available.", { exact: true })
        .waitFor({
          state: "visible",
          timeout: Math.max(1, Math.min(20_000, deadline - Date.now())),
        });
    } catch {
      const absent = await page
        .getByText(
          "Incoming media has no available audio track. Handle the visit in person or use optional visitor text.",
          { exact: true },
        )
        .isVisible()
        .catch(() => false);
      const failure = classifyProviderMediaWaitFailure(
        report.mediaHttp,
        absent,
      );
      throw new SmokeFailure(failure.category, failure.result);
    }
    await observeVideoTracks();
    report.observed.incomingAudioTrack = true;
    const mediaView = await getView(context.request, ownedVisitId);
    mediaSessionId = mediaView.visit.mediaSessionId;
    ownedScope.mediaSessionId = mediaSessionId;
    await checkpointScope();
    requireCondition(
      mediaView.visit.mediaSource === "RING" &&
        mediaView.visit.mediaStatus === "LIVE" &&
        !!mediaSessionId,
      "RING_MEDIA_PROVENANCE_NOT_CONFIRMED",
    );
    report.provenance.media = "RING_PLAYGROUND";
    if (stage === "captions") {
      currentStage = "AWS_CAPTIONS";
      await page
        .getByRole("button", {
          name: "Start incoming audio captions",
          exact: true,
        })
        .click({ timeout: Math.max(1, Math.min(4000, deadline - Date.now())) });
      while (Date.now() < deadline - 500) {
        const state = await getView(
          context.request,
          ownedVisitId,
          Math.max(1, Math.min(2000, deadline - Date.now())),
        );
        const history = await completeHistory(context.request, state, deadline);
        const proof = summarizeProviderCaptions(history.items, mediaSessionId!);
        Object.assign(report.counts, proof);
        requireCondition(
          proof.fixtureCaptions === 0 &&
            state.visit.transcriptSource !== "FIXTURE",
          "FIXTURE_CAPTION_DISQUALIFIES_PROVIDER_PROOF",
        );
        requireCondition(
          proof.uniqueAwsFinals === proof.awsFinals,
          "DUPLICATE_AWS_FINAL_IN_HISTORY",
        );
        if (proof.awsFinals && state.visit.transcriptSource === "AWS") {
          report.observed.awsFinalPersisted = true;
          const finalTexts = history.items
            .filter(
              (item) =>
                item.kind === "caption" &&
                item.source === "AWS" &&
                item.isPartial === false &&
                item.mediaSessionId === mediaSessionId &&
                !!item.resultId &&
                item.text.trim(),
            )
            .map((item) => item.text);
          report.observed.residentFinalRendered = await page
            .locator(".caption-line:not(.partial)")
            .evaluateAll(
              (elements, texts) =>
                elements.some((element) => {
                  const paragraph = element.querySelector("p");
                  return (
                    element.checkVisibility() &&
                    element.querySelector(".caption-meta")?.textContent ===
                      "Finalized" &&
                    !!paragraph &&
                    texts.includes(paragraph.textContent || "")
                  );
                }),
              finalTexts,
            );
          if (report.observed.residentFinalRendered) {
            report.provenance.transcript = "AWS";
            break;
          }
        }
        await page.waitForTimeout(200);
      }
      if (!report.observed.awsFinalPersisted)
        throw new SmokeFailure(
          "NO_NONEMPTY_AWS_FINAL_WITHIN_MEDIA_BOUND",
          "SKIP",
        );
      requireCondition(
        report.observed.residentFinalRendered,
        "AWS_FINAL_NOT_RENDERED_WITHIN_MEDIA_BOUND",
      );
      requireCondition(
        report.counts.outgoingBinaryChunks > 0 &&
          report.counts.outgoingBinaryChunks ===
            report.counts.expectedSizedPcmFrames,
        "EXPECTED_OUTGOING_PCM_CHUNKS_NOT_OBSERVED",
      );
    } else {
      requireCondition(
        mediaView.visit.transcriptSource === "NONE" &&
          !mediaView.items.some((item) => item.kind === "caption"),
        "AUDIO_ONLY_STAGE_UNEXPECTED_TRANSCRIPT",
      );
      requireCondition(
        report.counts.outgoingBinaryChunks === 0,
        "AUDIO_ONLY_STAGE_UNEXPECTED_CAPTURE",
      );
    }
    report.counts.residentMicrophoneRequests = await page.evaluate(
      () =>
        (window as unknown as { __captionDoorMicrophoneRequests: number })
          .__captionDoorMicrophoneRequests || 0,
    );
    requireCondition(
      report.counts.residentMicrophoneRequests === 0,
      "RESIDENT_MICROPHONE_REQUESTED",
    );
    requireCondition(
      report.counts.mediaAttempts === 1,
      "MEDIA_ATTEMPT_COUNT_NOT_ONE",
    );
    report.result = "PASS";
    report.category =
      stage === "captions"
        ? "INCOMING_RING_AUDIO_TO_PERSISTED_AWS_FINAL_OBSERVED"
        : "INCOMING_RING_AUDIO_TRACK_OBSERVED_SPEECH_UNVERIFIED";
  } catch (error) {
    report.result = error instanceof SmokeFailure ? error.outcome : "FAIL";
    report.category =
      error instanceof SmokeFailure ? error.category : `${currentStage}_FAILED`;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    await observeVideoTracks();
    if (boundedMediaStop) await boundedMediaStop;
    if (ownedVisitId) {
      try {
        let state = await getView(context.request, ownedVisitId);
        if (page) {
          report.counts.residentMicrophoneRequests = await page
            .evaluate(
              () =>
                (
                  window as unknown as {
                    __captionDoorMicrophoneRequests: number;
                  }
                ).__captionDoorMicrophoneRequests || 0,
            )
            .catch(() => report.counts.residentMicrophoneRequests);
        }
        state = await getView(context.request, ownedVisitId);
        const mediaId = state.visit.mediaSessionId || mediaSessionId;
        ownedScope.mediaSessionId = mediaId;
        await checkpointScope(); // Retain the exact cleanup key before content deletion.
        if (mediaId) {
          const end = await context.request.delete(
            `/api/visits/${ownedVisitId}/media/${mediaId}`,
            { headers: headers(csrf), timeout: 4000 },
          );
          report.cleanup.mediaEndRequested ||= end.ok();
        }
        state = await getView(context.request, ownedVisitId);
        if (state.visit.status === "UNCLAIMED") {
          await command(context.request, ownedVisitId, csrf, {
            type: "claim",
            expectedVersion: state.visit.version,
          });
          state = await getView(context.request, ownedVisitId);
        }
        requireCondition(
          state.visit.status === "CLOSED" ||
            state.visit.handlerId === residentId,
          "CLEANUP_OTHER_HANDLER_REFUSED",
        );
        if (state.visit.status !== "CLOSED") {
          await command(context.request, ownedVisitId, csrf, {
            type: "close",
            expectedVersion: state.visit.version,
            outcome: "NO_RESPONSE_RECORDED",
          });
          state = await getView(context.request, ownedVisitId);
        }
        report.cleanup.visitClosed = state.visit.status === "CLOSED";
        if (report.cleanup.visitClosed) {
          await command(context.request, ownedVisitId, csrf, {
            type: "delete",
            expectedVersion: state.visit.version,
          });
          report.cleanup.contentDeletionRequested = true;
          const denied = await context.request.get(
            `/api/visits/${ownedVisitId}`,
            { timeout: 4000 },
          );
          report.cleanup.contentAccessDenied = [403, 404, 410].includes(
            denied.status(),
          );
          requireCondition(
            report.cleanup.contentAccessDenied,
            "DELETED_CONTENT_ACCESS_NOT_REVOKED",
          );
        }
      } catch {
        report.result = "FAIL";
        report.category = "OWN_FICTIONAL_VISIT_CLEANUP_INCOMPLETE";
      }
    }
    if (reservationRequired && reservationReport.before) {
      try {
        const budget = await json<unknown>(
          await context.request.get("/api/provider-smoke/budget", {
            timeout: 4000,
          }),
          "PROVIDER_RESERVATION_BUDGET_AFTER_UNAVAILABLE",
        );
        const after = budgetEvidence(budget, process.env, false);
        reservationReport.after = after;
        const delta =
          after.reservedSeconds - reservationReport.before.reservedSeconds;
        requireCondition(
          delta >= 0 && delta <= after.maxAttemptSeconds,
          "PROVIDER_RESERVATION_RESERVATION_DELTA_INVALID",
        );
        if (report.observed.awsFinalPersisted || reservationReport.receipt)
          requireCondition(
            delta === after.maxAttemptSeconds,
            "PROVIDER_RESERVATION_AWS_FINAL_WITHOUT_DURABLE_RESERVATION",
          );
        if (reservationReport.receipt)
          requireCondition(
            after.reservedSeconds ===
              reservationReport.receipt.cumulativeReservedSeconds &&
              after.cumulativeEstimatedMicrousd ===
                reservationReport.receipt.cumulativeEstimatedMicrousd,
            "PROVIDER_RESERVATION_RECEIPT_LEDGER_MISMATCH",
          );
      } catch {
        report.result = "FAIL";
        report.category =
          "PROVIDER_RESERVATION_BUDGET_AFTER_INVALID_OR_UNAVAILABLE";
      }
    }
    if (
      reservationRequired &&
      (rootReceiptInvalid ||
        ((report.counts.outgoingBinaryChunks > 0 ||
          report.observed.awsFinalPersisted) &&
          !reservationReport.receipt))
    ) {
      report.result = "FAIL";
      report.category =
        "PROVIDER_RESERVATION_WORKER_IDENTITY_RECEIPT_INVALID_OR_MISSING";
    }
    if (
      report.counts.mediaAttempts > 1 ||
      report.counts.residentMicrophoneRequests > 0
    ) {
      report.result = "FAIL";
      report.category = "SMOKE_SAFETY_BOUND_VIOLATED";
    }
    await context.close().catch(() => {
      report.result = "FAIL";
      report.category = "LOCAL_BROWSER_CLEANUP_INCOMPLETE";
    });
    await Promise.allSettled([...pendingMediaDiagnostics]);
    if (report.result === "SKIP") {
      const failure = classifyProviderMediaWaitFailure(
        report.mediaHttp,
        report.category === "PLAYGROUND_HAS_NO_INCOMING_AUDIO_TRACK",
      );
      if (failure.result === "FAIL") {
        report.result = failure.result;
        report.category = failure.category;
      }
    }
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      resolve(evidenceDir, "result.json"),
      JSON.stringify(
        {
          ...report,
          endedAt: new Date().toISOString(),
          notes: [
            "Local event, official Playground media and optional AWS transcription have separate provenance.",
            "Audio track presence does not prove intelligible speech. Empty AWS results are not a pass.",
            "Access denial and deletion-job acceptance do not prove physical erasure or observed Ring DELETE.",
            "Only the scoped capture-ready receipt records worker-verified STS identity; budget summaries alone do not. Reservations are estimates, not AWS billing, and are not refunded.",
            "No raw audio/video recording, captions, token, SDP, cookies or provider profile saved by this harness.",
          ],
        },
        null,
        2,
      ),
    );
  }
  if (report.result === "SKIP") test.skip(true, report.category);
  if (report.result !== "PASS")
    throw new Error(
      `Provider smoke ${report.result}: ${report.category}. See sanitized result.json.`,
    );
});
