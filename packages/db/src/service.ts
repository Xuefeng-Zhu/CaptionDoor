import {
  authenticate,
  sessionFromId,
  createResidentSession,
  demoLogin,
  createGuest,
  revokeSession,
  refresh as refreshActor,
  rateLimit,
} from "./auth";
import { getItem, tables } from "./repository";
import { bootstrap, getVisit, guestView } from "./read";
import { command } from "./commands";
import { guestMessage, delivery } from "./messages";
import { settings, unlink, revoke, invite, acceptInvite } from "./privacy";
import {
  authorizeCapture,
  releaseCapture,
  persistCaption,
  enqueueDemoCaptions,
  completeMedia,
  expireMedia,
  simulateMediaUnavailable,
} from "./capture";
import { press, revokeRingAccount, ringDeviceOffline } from "./ring";
export type { CaptionInput } from "./capture";
async function health() {
  await getItem(tables.config, "HEALTH", "HEALTH");
  return {
    ok: true,
    store: "dynamodb",
    ringMode: process.env.RING_MODE || "demo",
    transcribeMode: process.env.TRANSCRIBE_MODE || "fixture",
  };
}
export const coreService = {
  authenticate,
  sessionFromId,
  createResidentSession,
  demoLogin,
  createGuest,
  revokeSession,
  refreshActor,
  rateLimit,
  bootstrap,
  getVisit,
  guestView,
  command,
  guestMessage,
  delivery,
  settings,
  unlink,
  revoke,
  invite,
  acceptInvite,
  authorizeCapture,
  releaseCapture,
  persistCaption,
  enqueueDemoCaptions,
  completeMedia,
  expireMedia,
  simulateMediaUnavailable,
  press,
  revokeRingAccount,
  ringDeviceOffline,
  health,
};
