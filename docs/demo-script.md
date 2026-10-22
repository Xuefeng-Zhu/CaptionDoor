# CaptionDoor English demo script — under three minutes

Prepare before starting the clock: follow [judging-replay.md](judging-replay.md), check both health endpoints, and open independent Alex, Sam and guest browser contexts. Review the three separate local consent settings. Manually close any previous active demo visit with an honest outcome. The guest URL is `http://127.0.0.1:3410/door/front-demo`; a second ordinary tab sharing cookies does not demonstrate isolation. No new passing replay is claimed while the runtime blocker in [test-results.md](test-results.md) remains.

Use only synthetic demo material and keep all credentials/session material out of the recording. This is a narration plan, not authorization to publish video or submit an entry.

**0:00–0:20 — Introduce the local setting.** Show the home screen and Local demo label.

> “CaptionDoor helps a resident understand their doorstep without relying on sound. This demonstration runs real local APIs, WebSockets and DynamoDB. Its doorbell event and transcript are clearly labeled fixtures. It is not footage from a real Ring session.”

**0:20–0:45 — Alert and claim.** In `/demo`, start **A visitor rings**. Open the visible visit and deliberately select **I’ll handle this.** Show Alex’s handler status in Sam’s context.

> “A visible alert arrives. I choose to take responsibility. Claiming sends no message. Sam can see who is handling the visit, and losing a connection does not give up that responsibility.”

**0:45–1:10 — Understand the words.** Choose **Start Demo transcript**. Show its revision to **Do not leave it.**, the **Demo transcript** label and **Finalized** status.

> “Captions are the primary view. Updating words may change; finalized means the segment is complete, not verified. These words are a synthetic fixture. Real captions require available incoming audio, separate consent and an explicit action. Text remains available when media fails.”

**1:10–1:55 — Visitor text and approved reply.** In the guest context, choose **Delivery** and send a synthetic request. Alex chooses **Associate thread**, selects or edits a preset, and clicks **Send to visitor page**. Show ACCEPTED, then DISPLAYED while the guest page is visible. The guest selects **Got it**.

> “The visitor needs no account or installation. Each browser has a private thread. I associate it explicitly; a QR scan and timing do not establish identity. Selecting a preset only edits the draft. I approve the send. Accepted, displayed and the visitor’s deliberate acknowledgement are separate stages.”

**1:55–2:20 — Explain the limits and reconnect.** Briefly show the visitor page’s keep-open guidance; reconnect it if demonstrating the automated replay’s offline-send step.

> “The page must stay open for replies. Offline means no live alerts. A phone-less visitor cannot receive a web reply. CaptionDoor never speaks through Ring, unlocks a door or answers automatically. Reconnecting recovers persisted state; it does not prove that someone read a message.”

**2:20–2:50 — Close deliberately and identify the evidence gap.** Select a closure outcome and **Close visit**. Show closed state after reload and the separate retention choices.

> “I explicitly close this session. Closure does not prove departure. Content access expires under the household’s retention setting, with durable deletion work afterward. This LOCAL replay demonstrates the communication journey. Substantial actual Ring runtime use and real AWS transcription remain separate, unobserved evidence gates.”

For a handoff-focused variation, replace the reconnect explanation with a request to Sam and explicit acceptance: Alex remains responsible until acceptance, and the old handler’s replies/audio lease are fenced. Do not add this variation on top of the timed script if it would exceed three minutes.

The [organizer clarification](submission-checklist.md#ring-simulator-interpretation-and-provenance) allows a participant-built simulator combined with substantial actual Ring technology; physical hardware is optional. This fixture-only demonstration has not established that actual Ring component. A future mixed demonstration must attribute LOCAL events, actual Playground/device media and any FIXTURE transcript separately. Do not call this local judge replay a prior real Ring replay or count missing provider/hardware observations as passes.

Actual commands, pass/fail/skips and the current runtime blocker are recorded in [test-results.md](test-results.md).
