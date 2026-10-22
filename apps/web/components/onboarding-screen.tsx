"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { Bootstrap } from "@captiondoor/domain";
import { api, errorText } from "./api";
import { Arrow, DoorMark, ErrorNotice, Pill } from "./ui";
export function OnboardingScreen() {
  const [data, setData] = useState<Bootstrap | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [authMode, setAuthMode] = useState<string | null>(null),
    [pendingCsrf, setPendingCsrf] = useState(""),
    [inviteCode, setInviteCode] = useState(""),
    [consent, setConsent] = useState({
      ring: false,
      transcription: false,
      sharing: false,
    });
  useEffect(() => {
    api<{ authMode: string }>("/health")
      .then((h) => setAuthMode(h.authMode))
      .catch(() => {});
    api<{ pending: boolean; csrf: string }>("/auth/pending")
      .then((p) => {
        if (p.pending) setPendingCsrf(p.csrf);
      })
      .catch(() => {});
    api<Bootstrap>("/me")
      .then((d) => {
        setData(d);
        setAuthMode(d.mode.auth);
        setConsent(d.settings.consent);
      })
      .catch(() => {});
  }, []);
  async function login(identity: string) {
    setBusy(true);
    setError("");
    try {
      await api("/auth/demo", { body: { identity } });
      const d = await api<Bootstrap>("/me");
      setData(d);
      setConsent(d.settings.consent);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function join(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingCsrf) return;
    setBusy(true);
    setError("");
    try {
      await api("/members/accept", {
        body: { inviteCode: inviteCode.trim() },
        csrf: pendingCsrf,
      });
      setInviteCode("");
      window.location.assign("/home");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!data) return;
    setBusy(true);
    setError("");
    try {
      await api("/settings", {
        body: { ...data.settings, consent },
        csrf: data.csrf,
      });
      setSaved(true);
      setData({ ...data, settings: { ...data.settings, consent } });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="onboarding-frame">
      <header className="site-header">
        <Link href="/onboarding" className="brand">
          <DoorMark />
          <span>
            CaptionDoor<span className="brand-dot">.</span>
          </span>
        </Link>
        <span className="eyebrow">COMMUNICATION, ON YOUR TERMS</span>
      </header>
      <main id="main" className="onboarding-main">
        <section className="onboarding-intro">
          <p className="eyebrow">WELCOME HOME</p>
          <h1>
            Your doorstep.
            <br />
            <em>In words.</em>
          </h1>
          <p className="intro-copy">
            Understand what’s happening at your door without relying on sound.
          </p>
          <div className="welcome-art" aria-hidden="true">
            <div className="welcome-arch" />
            <div className="welcome-door">
              <span className="welcome-window">
                <i />
                <i />
                <i />
              </span>
              <span className="welcome-knob" />
            </div>
            <span className="art-word one">Hello.</span>
            <span className="art-word two">I’m coming.</span>
            <span className="art-line" />
          </div>
          <p className="intro-footnote">
            You stay in control. We never answer, unlock a door, or reply for
            you.
          </p>
        </section>
        <section className="setup-panel" aria-labelledby="setup-title">
          <div className="section-top">
            <p className="eyebrow">A GOOD PLACE TO START</p>
            <Pill tone={authMode === "demo" ? "amber" : "neutral"}>
              {authMode === "demo" ? "Local demo" : "Household setup"}
            </Pill>
          </div>
          <h2 id="setup-title">Make it your door.</h2>
          <p>
            Set up a shared household space, then choose how you communicate.
          </p>
          <ErrorNotice message={error} />
          <ol className="setup-steps">
            <li>
              <span className="step-number">01</span>
              <div>
                <h3>
                  {data
                    ? `You’re signed in as ${data.user.name}`
                    : "Open your household"}
                </h3>
                {data ? (
                  <p>App sign-in is separate from Ring account linking.</p>
                ) : (
                  <>
                    {authMode === "demo" ? (
                      <>
                        <p>
                          This credential-free local demo uses explicit seeded
                          identities. Choose a resident.
                        </p>
                        <div className="button-row">
                          <button
                            disabled={busy}
                            className="button primary"
                            onClick={() => void login("alex")}
                          >
                            Continue as Alex <Arrow />
                          </button>
                          <button
                            disabled={busy}
                            className="button secondary"
                            onClick={() => void login("sam")}
                          >
                            Sam
                          </button>
                        </div>
                        <details className="identity-details">
                          <summary>Isolated household test</summary>
                          <p>
                            Jordan belongs to a separate household for access
                            testing.
                          </p>
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() => void login("jordan")}
                          >
                            Continue as Jordan
                          </button>
                        </details>
                      </>
                    ) : authMode === null ? (
                      <p>Checking available sign-in…</p>
                    ) : (
                      <>
                        <p>
                          Sign in with your household account. App sign-in is
                          separate from your Ring account.
                        </p>
                        <a className="button primary" href="/api/auth/login">
                          Sign in with Cognito <Arrow />
                        </a>
                      </>
                    )}
                    <details className="invitation-join" open={!!pendingCsrf}>
                      <summary>Have a household invitation?</summary>
                      {pendingCsrf ? (
                        <p>
                          Your account is verified. Enter the private invitation
                          code shared by a household owner.
                        </p>
                      ) : (
                        <p>
                          First sign in with Cognito to verify your account,
                          then enter the invitation code. Seeded local demo
                          identities already belong to their households.
                        </p>
                      )}
                      {!pendingCsrf ? (
                        <a className="text-link" href="/api/auth/login">
                          Verify your account <Arrow />
                        </a>
                      ) : null}
                      <form onSubmit={(e) => void join(e)}>
                        <label className="field">
                          <span>Private invitation code</span>
                          <input
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={256}
                            value={inviteCode}
                            onChange={(e) => setInviteCode(e.target.value)}
                            disabled={!pendingCsrf || busy}
                          />
                        </label>
                        <button
                          className="button secondary"
                          disabled={busy || !pendingCsrf || !inviteCode.trim()}
                          type="submit"
                        >
                          Join household <Arrow />
                        </button>
                      </form>
                    </details>
                  </>
                )}
              </div>
            </li>
            <li>
              <span className="step-number">02</span>
              <div>
                <h3>Choose one door</h3>
                <p>
                  {data
                    ? `${data.doors[0]?.name || "Front door"} is selected for this household.`
                    : "A single front door keeps the conversation focused."}
                </p>
                {data ? (
                  <label className="door-choice">
                    <input type="radio" checked readOnly name="door" />
                    {data.doors[0]?.name || "Front door"}
                    <span>Selected</span>
                  </label>
                ) : null}
                <details>
                  <summary>Connect a Ring account instead</summary>
                  <p>
                    Requires invited partner credentials or a Playground token.
                    These are separate from this local simulator. Connection
                    failures never switch silently to demo.
                  </p>
                  <a className="button secondary" href="/api/ring/connect">
                    Connect Ring <Arrow />
                  </a>
                </details>
              </div>
            </li>
            <li>
              <span className="step-number">03</span>
              <div>
                <h3>Choose what you share</h3>
                <p>
                  Separate choices. No audio or video is recorded by this app.
                </p>
                <div className="check-list">
                  <label>
                    <input
                      type="checkbox"
                      disabled={!data || busy}
                      checked={consent.ring}
                      onChange={(e) => {
                        setConsent({ ...consent, ring: e.target.checked });
                        setSaved(false);
                      }}
                    />
                    <span>
                      Allow incoming Ring media when I explicitly open it.
                    </span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      disabled={!data || busy}
                      checked={consent.transcription}
                      onChange={(e) => {
                        setConsent({
                          ...consent,
                          transcription: e.target.checked,
                        });
                        setSaved(false);
                      }}
                    />
                    <span>
                      Allow incoming audio to be processed by AWS Transcribe
                      when I start captions. Local demo transcripts are
                      fixtures.
                    </span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      disabled={!data || busy}
                      checked={consent.sharing}
                      onChange={(e) => {
                        setConsent({ ...consent, sharing: e.target.checked });
                        setSaved(false);
                      }}
                    />
                    <span>
                      Share visit text and finalized captions with authorized
                      household members.
                    </span>
                  </label>
                </div>
                <p className="small muted">
                  Default content access retention: 24 hours. Expiry blocks
                  access; physical deletion follows in a background job.
                  Provider and backup limits are explained in Settings.
                </p>
                {data ? (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void save()}
                  >
                    {saved ? "Choices saved ✓" : "Save my choices"}
                  </button>
                ) : null}
              </div>
            </li>
            <li>
              <span className="step-number">04</span>
              <div>
                <h3>Make it a shared routine</h3>
                <p>
                  {data
                    ? data.members.map((m) => m.name).join(" and ")
                    : authMode === "demo"
                      ? "Two seeded household members"
                      : "Household members"}{" "}
                  can claim and hand over responsibility. Claiming never sends a
                  message.
                </p>
                <div className="setup-links">
                  <Link href="/settings">
                    Invite & permissions <Arrow />
                  </Link>
                  <Link href="/settings#notifications">
                    Test notifications <Arrow />
                  </Link>
                  {data?.doors[0] ? (
                    <a
                      href={`/api/sign/${data.doors[0].publicDoorId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Print a visitor sign <Arrow />
                    </a>
                  ) : null}
                </div>
              </div>
            </li>
          </ol>
          <div className="setup-finish">
            <Link
              className={`button primary ${!data ? "is-disabled" : ""}`}
              aria-disabled={!data}
              tabIndex={data ? 0 : -1}
              href={data ? "/home" : "#setup-title"}
            >
              Go to your door <Arrow />
            </Link>
            {authMode === "demo" ? (
              <p>
                Try the complete text journey in{" "}
                <Link href="/demo">Local demo</Link>.
              </p>
            ) : (
              <p>
                You choose when to open media, start captions, and send a reply.
              </p>
            )}
          </div>
        </section>
      </main>
      <footer className="onboarding-footer">
        CaptionDoor supports communication. It does not identify visitors or
        make safety decisions.
      </footer>
    </div>
  );
}
