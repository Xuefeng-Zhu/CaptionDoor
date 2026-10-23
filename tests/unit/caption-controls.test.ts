import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bootstrap, Visit } from "@captiondoor/domain";
import { CaptionPanel } from "../../apps/web/components/caption-panel";
import { IncomingCaptionControls } from "../../apps/web/components/visit-media-panel";
import type { VisitMediaController } from "../../apps/web/components/use-visit-media";

const data: Bootstrap = {
  user: { id: "resident-alex", name: "Alex" },
  household: { id: "fictional-household", name: "Fictional household" },
  doors: [],
  members: [],
  visits: [],
  threads: [],
  settings: {
    retentionHours: 24,
    captionSize: 32,
    consent: { ring: true, transcription: true, sharing: true },
    presets: [],
  },
  // Rendering only: no token, connection, provider or database is used.
  mode: { ring: "playground", transcribe: "aws", auth: "oidc" },
  csrf: "unused-render-fixture",
  wsUrl: "ws://127.0.0.1:3411/ws",
};
const visit: Visit = {
  id: "fictional-visit",
  householdId: data.household.id,
  doorId: "fictional-door",
  doorName: "Front door",
  status: "CLAIMED",
  version: 1,
  handlerId: data.user.id,
  handlerName: data.user.name,
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 5000,
  mediaStatus: "LIVE",
  mediaSource: "RING",
  eventSource: "PLAYGROUND",
  transcriptSource: "AWS",
};
const privateCaption = "Private caption that must not be rendered.";

function renderRevokedCaptionAccess(hasMedia: boolean, currentVisit = visit) {
  const media: VisitMediaController = {
    videoRef: createRef<HTMLVideoElement>(),
    includeAudio: true,
    setIncludeAudio: vi.fn(),
    mediaNote: "",
    captureNote: "",
    mediaReady: hasMedia,
    hasRemoteAudio: hasMedia,
    hasMedia,
    startMedia: vi.fn(async () => undefined),
    startCapture: vi.fn(async () => undefined),
    stopMedia: vi.fn(),
  };
  const controls = createElement(IncomingCaptionControls, {
    data,
    visit: currentVisit,
    access: { captions: false, visitorText: false, camera: true },
    busy: false,
    media,
  });
  const html = renderToStaticMarkup(
    createElement(CaptionPanel, {
      visit: currentVisit,
      captions: [
        {
          id: "private-final",
          kind: "caption",
          text: privateCaption,
          createdAt: 1,
          expiresAt: 5000,
          source: "AWS",
          isPartial: false,
        },
      ],
      hasCaptionAccess: false,
      initialSize: 32,
      allowFixture: false,
      busy: false,
      demoCaptions: vi.fn(async () => undefined),
      isHandler: currentVisit.handlerId === data.user.id,
      controls,
    }),
  );
  expect(media.startMedia).not.toHaveBeenCalled();
  expect(media.startCapture).not.toHaveBeenCalled();
  expect(media.stopMedia).not.toHaveBeenCalled();
  return html;
}
function buttonAttributes(html: string, label: string) {
  const button = html.match(new RegExp(`<button([^>]*)>${label}</button>`));
  expect(button, `Expected rendered button: ${label}`).not.toBeNull();
  return button![1];
}

describe("independent camera and caption permissions in the rendered UI", () => {
  it("keeps camera opening available while revoked caption access hides retained text and disables capture", () => {
    const html = renderRevokedCaptionAccess(false);
    expect(buttonAttributes(html, "Open incoming media")).not.toContain(
      "disabled",
    );
    expect(buttonAttributes(html, "Start incoming audio captions")).toContain(
      "disabled",
    );
    expect(html).not.toContain("End media");
    expect(html).toContain("Caption access is unavailable");
    expect(html).not.toContain(privateCaption);
    expect(html).not.toContain("caption-line");
  });

  it("keeps End media available for authorized video after caption access is withdrawn", () => {
    const html = renderRevokedCaptionAccess(true);
    expect(buttonAttributes(html, "Open incoming media")).toContain("disabled");
    expect(buttonAttributes(html, "End media")).not.toContain("disabled");
    expect(buttonAttributes(html, "Start incoming audio captions")).toContain(
      "disabled",
    );
    expect(html).not.toContain(privateCaption);
    expect(html).toContain("Starting captions sends it to AWS Transcribe");
  });

  it("does not expose media operations or private captions to a non-handler", () => {
    const html = renderRevokedCaptionAccess(true, {
      ...visit,
      handlerId: "resident-sam",
      handlerName: "Sam",
    });
    expect(html).not.toContain("Open incoming media");
    expect(html).not.toContain("End media");
    expect(html).not.toContain("Start incoming audio captions");
    expect(html).not.toContain(privateCaption);
    expect(html).toContain("Caption access is unavailable");
  });
});
