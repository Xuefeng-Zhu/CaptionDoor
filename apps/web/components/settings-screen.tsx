"use client";
import Link from "next/link";
import { RingDoorPicker } from "./ring-door-picker";
import { useEffect, useState } from "react";
import type { Settings } from "@captiondoor/domain";
import { api, errorText } from "./api";
import { useLive, useResident } from "./hooks";
import { AccessGate, Arrow, ErrorNotice, Loading, Pill, Shell } from "./ui";
function keyBytes(key: string) {
  const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
export function SettingsScreen() {
  const { data, error, loading, reload, setData } = useResident();
  const [draft, setDraft] = useState<Settings | null>(null),
    [busy, setBusy] = useState(""),
    [actionError, setActionError] = useState(""),
    [notice, setNotice] = useState(""),
    [inviteName, setInviteName] = useState(""),
    [invite, setInvite] = useState("");
  const connection = useLive({
    url: data?.wsUrl,
    onChange: () => {
      void reload();
    },
  });
  useEffect(() => {
    if (data && !draft) setDraft(data.settings);
  }, [data, draft]);
  if (loading)
    return (
      <Shell>
        <Loading label="Opening your settings…" />
      </Shell>
    );
  if (!data || !draft) return <AccessGate error={error} />;
  async function action(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setActionError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy("");
    }
  }
  async function save() {
    await action("save", async () => {
      await api("/settings", { body: draft, csrf: data!.csrf });
      setData({ ...data!, settings: draft! });
      setNotice("Your choices have been saved.");
    });
  }
  async function notifications() {
    await action("push", async () => {
      if (
        !("Notification" in window) ||
        !("serviceWorker" in navigator) ||
        !("PushManager" in window)
      )
        throw new Error(
          "Web Push is unavailable in this browser. In-app alerts remain available while connected.",
        );
      const { publicKey } = await api<{ publicKey: string }>(
        "/push/public-key",
      );
      const permission = await Notification.requestPermission();
      if (permission !== "granted")
        throw new Error(
          "Notification permission was not granted. You can continue using visible in-app alerts.",
        );
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey),
      });
      await api("/push/subscribe", {
        body: { subscription: subscription.toJSON() },
        csrf: data!.csrf,
      });
      setNotice("This browser is subscribed. Send a test to check delivery.");
    });
  }
  return (
    <Shell data={data} connection={connection}>
      <div className="page-heading compact">
        <div>
          <p className="eyebrow">MAKE THIS WORK FOR YOU</p>
          <h1>Your choices.</h1>
        </div>
        <Link href="/home" className="text-link">
          Back to your door <Arrow />
        </Link>
      </div>
      <ErrorNotice message={actionError || error} />
      {notice ? (
        <div className="notice success" role="status">
          {notice}
        </div>
      ) : null}
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <a href="#communication">Communication</a>
          <a href="#privacy">Privacy & retention</a>
          <a href="#household">Household</a>
          <a href="#integration">Ring connection</a>
          <a href="#notifications">Notifications</a>
        </nav>
        <div className="settings-sections">
          <section id="communication" className="settings-section">
            <p className="eyebrow">WORDS THAT WORK FOR YOU</p>
            <h2>Communication</h2>
            <label className="field-label" htmlFor="caption-size">
              Caption size <output>{draft.captionSize}px</output>
            </label>
            <input
              id="caption-size"
              type="range"
              min="28"
              max="36"
              step="2"
              value={draft.captionSize}
              onChange={(e) =>
                setDraft({ ...draft, captionSize: Number(e.target.value) })
              }
            />
            <p
              className="caption-preview"
              style={{ fontSize: draft.captionSize }}
            >
              “Please type your request here.”
            </p>
            <h3>Your quick replies</h3>
            <p className="muted">
              Editable starting points. Every reply still needs you to choose
              Send.
            </p>
            <div className="preset-fields">
              {draft.presets.map((text, index) => (
                <label className="field" key={index}>
                  <span>Quick reply {index + 1}</span>
                  <textarea
                    rows={2}
                    maxLength={1000}
                    value={text}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        presets: draft.presets.map((p, i) =>
                          i === index ? e.target.value : p,
                        ),
                      })
                    }
                  />
                </label>
              ))}
            </div>
          </section>
          <section id="privacy" className="settings-section">
            <p className="eyebrow">YOUR HOUSEHOLD, YOUR BOUNDARIES</p>
            <h2>Privacy & retention</h2>
            <div className="check-list">
              <label>
                <input
                  type="checkbox"
                  checked={draft.consent.ring}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      consent: { ...draft.consent, ring: e.target.checked },
                    })
                  }
                />
                <span>Allow incoming Ring media when I open it.</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={draft.consent.transcription}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      consent: {
                        ...draft.consent,
                        transcription: e.target.checked,
                      },
                    })
                  }
                />
                <span>
                  Allow AWS Transcribe to process selected incoming audio when I
                  start captions.
                </span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={draft.consent.sharing}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      consent: { ...draft.consent, sharing: e.target.checked },
                    })
                  }
                />
                <span>
                  Share visitor text and finalized captions with authorized
                  household members.
                </span>
              </label>
            </div>
            <label className="field retention-field">
              <span>Content access retention</span>
              <select
                value={draft.retentionHours}
                onChange={(e) =>
                  setDraft({ ...draft, retentionHours: Number(e.target.value) })
                }
              >
                <option value={1}>1 hour</option>
                <option value={24}>24 hours (default)</option>
                <option value={72}>3 days</option>
                <option value={168}>7 days</option>
              </select>
            </label>
            <p className="small muted">
              Expired content is immediately denied by the app. A durable
              deletion job removes stored content; DynamoDB TTL is a delayed
              backstop. Database backups and third-party provider records follow
              their own documented retention. This app makes no instant-erasure
              claim for those copies.
            </p>
            <div className="principles">
              <span>No audio or video recording</span>
              <span>No visitor identification</span>
              <span>No automatic replies</span>
              <span>No door unlocking</span>
            </div>
            <p className="small muted">
              Open a visit to request deletion of its retained conversation.
              Corrections are new messages; there is no deceptive “unsend”.
            </p>
          </section>
          <div className="save-bar">
            <span>These choices apply to the household.</span>
            <button
              className="button primary"
              disabled={!!busy}
              onClick={() => void save()}
            >
              {busy === "save" ? "Saving…" : "Save choices"} <Arrow />
            </button>
          </div>
          <section id="household" className="settings-section">
            <p className="eyebrow">RESPONSIBILITY CAN BE SHARED</p>
            <h2>Your household</h2>
            <p className="muted">
              Camera, captions, visitor text, and membership are separate
              grants. Access is checked again on active connections.
            </p>
            <div className="member-list">
              {data.members.map((member) => (
                <div className="member-row" key={member.userId}>
                  <span className="avatar" aria-hidden="true">
                    {member.name.slice(0, 1)}
                  </span>
                  <div>
                    <strong>
                      {member.name}
                      {member.userId === data.user.id ? " (you)" : ""}
                    </strong>
                    <span>
                      {member.role}
                      {member.revoked ? " · Access revoked" : ""}
                    </span>
                    <small>
                      {Object.entries(member.grants)
                        .filter(([, allowed]) => allowed)
                        .map(([grant]) =>
                          grant === "visitorText"
                            ? "Visitor text"
                            : grant.charAt(0).toUpperCase() + grant.slice(1),
                        )
                        .join(" · ")}
                    </small>
                  </div>
                  {member.userId !== data.user.id && !member.revoked ? (
                    <button
                      className="text-button danger"
                      disabled={!!busy}
                      onClick={() =>
                        void action("revoke", async () => {
                          await api(`/members/${member.userId}/revoke`, {
                            body: {},
                            csrf: data.csrf,
                          });
                          await reload();
                          setNotice(
                            `${member.name}’s access has been revoked.`,
                          );
                        })
                      }
                    >
                      Revoke access
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            <h3>Invite a household member</h3>
            <p className="small muted">
              Create a short-lived invitation to share manually. No email is
              sent.
            </p>
            <div className="inline-form">
              <label className="field">
                <span>Name</span>
                <input
                  maxLength={80}
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  placeholder="Household member’s name"
                />
              </label>
              <button
                className="button secondary"
                disabled={!!busy || !inviteName.trim()}
                onClick={() =>
                  void action("invite", async () => {
                    const result = await api<{ inviteCode: string }>(
                      "/members/invite",
                      { body: { name: inviteName.trim() }, csrf: data.csrf },
                    );
                    setInvite(result.inviteCode);
                    setNotice("Invitation created. Share the code privately.");
                  })
                }
              >
                Create invitation
              </button>
            </div>
            {invite ? (
              <div className="notice">
                <strong>Private invitation code</strong>
                <code className="invite-code">{invite}</code>
                <span className="small">
                  Share privately. This is not proof of visitor identity.
                </span>
              </div>
            ) : null}
          </section>
          <section id="integration" className="settings-section">
            <div className="section-top">
              <p className="eyebrow">SEPARATE FROM APP SIGN-IN</p>
              <Pill tone="amber">
                {data.mode.ring === "demo" ? "Local simulator" : data.mode.ring}
              </Pill>
            </div>
            <h2>Ring connection</h2>
            <RingDoorPicker
              key={notice}
              mode={data.mode.ring}
              csrf={data.csrf}
              owner={data.members.some(
                (member) =>
                  member.userId === data.user.id && member.role === "owner",
              )}
              onSelected={() => {
                void reload();
              }}
            />
            <p>
              {data.mode.ring === "demo"
                ? "Doorbell events are generated locally. No Ring account or real device has been connected."
                : "Ring mode is configured. Availability depends on authorized account, device, encryption, subscription, and network access."}
            </p>
            <p className="small muted">
              Optional receive-only media has short lifetimes. Battery-powered
              devices may allow 30 seconds; line-powered devices 60 seconds.
              Media ending never proves that someone has left. Replies are
              delivered only to the visitor web page.
            </p>
            <div className="button-row">
              <a className="button secondary" href="/api/ring/connect">
                Connect Ring <Arrow />
              </a>
              <button
                className="text-button danger"
                disabled={!!busy}
                onClick={() =>
                  void action("unlink", async () => {
                    await api("/settings/unlink", {
                      body: {},
                      csrf: data.csrf,
                    });
                    setNotice(
                      "Integration access revoked. Media and capture access have stopped.",
                    );
                    await reload();
                  })
                }
              >
                Unlink & revoke access
              </button>
            </div>
            <p className="small muted">
              Encrypted or unsupported devices may be unavailable. CaptionDoor
              never asks you to disable device encryption.
            </p>
          </section>
          <section id="notifications" className="settings-section">
            <p className="eyebrow">VISIBLE FIRST</p>
            <h2>Notifications</h2>
            <p>
              In-app alerts appear while you’re connected. Offline means no live
              alerts. Web Push is an optional additional channel.
            </p>
            <p className="small muted">
              On iPhone and iPad, add this app to the Home Screen before
              enabling Web Push. Browser and operating system settings can
              affect delivery. A provider accepting a push is not an
              acknowledgement from you.
            </p>
            <div className="button-row">
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() => void notifications()}
              >
                Enable Web Push
              </button>
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() =>
                  void action("test", async () => {
                    await api("/push/test", { body: {}, csrf: data.csrf });
                    setNotice(
                      "Test notification queued. Check your browser or device; queued is not proof of delivery.",
                    );
                  })
                }
              >
                Send notification test
              </button>
            </div>
          </section>
          <section className="settings-section">
            <h2>A visitor sign, in plain words.</h2>
            <p>
              “Prefer to communicate by text? Scan here to message this
              household.”
            </p>
            <p className="small muted">
              Visitors need no account or installation. A phone-less visitor can
              provide incoming speech for captions, but cannot receive a web
              reply. The QR entrance reveals no household identity, occupancy,
              captions, or video.
            </p>
            <a
              className="button secondary"
              target="_blank"
              rel="noreferrer"
              href={`/api/sign/${data.doors[0]?.publicDoorId || "front-demo"}`}
            >
              Open printable sign <Arrow />
            </a>
          </section>
          <section className="settings-section session-settings">
            <h2>App session</h2>
            <p className="small muted">
              Signed in as {data.user.name}. App sign-in and Ring linking are
              separate.
            </p>
            <button
              className="button secondary"
              onClick={() =>
                void action("logout", async () => {
                  await api("/auth/logout", { body: {}, csrf: data.csrf });
                  window.location.assign("/onboarding");
                })
              }
            >
              Sign out
            </button>
          </section>
        </div>
      </div>
    </Shell>
  );
}
