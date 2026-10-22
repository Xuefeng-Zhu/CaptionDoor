"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Bootstrap } from "@captiondoor/domain";
import { modeLabel } from "./api";
export function DoorMark({ large = false }: { large?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={large ? "door-mark large" : "door-mark"}
      viewBox="0 0 40 48"
      fill="none"
    >
      <path
        d="M7 42V5h25v37M7 42h30"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M14 15h12M14 21h9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="26" cy="29" r="1.8" fill="currentColor" />
    </svg>
  );
}
export function Arrow() {
  return <span aria-hidden="true">↗</span>;
}
export function Shell({
  children,
  data,
  connection = "connecting",
}: {
  children: React.ReactNode;
  data?: Bootstrap | null;
  connection?: string;
}) {
  const path = usePathname();
  return (
    <div className="app-frame">
      <header className="site-header">
        <Link href="/home" className="brand" aria-label="CaptionDoor home">
          <DoorMark />
          <span>
            CaptionDoor<span className="brand-dot">.</span>
          </span>
        </Link>
        <nav aria-label="Main navigation">
          <Link
            aria-current={path === "/home" ? "page" : undefined}
            href="/home"
          >
            Your door
          </Link>
          <Link
            aria-current={path === "/demo" ? "page" : undefined}
            href="/demo"
          >
            Local demo
          </Link>
          <Link
            aria-current={path === "/settings" ? "page" : undefined}
            href="/settings"
          >
            Settings
          </Link>
        </nav>
        <div className="account-label">
          {data?.user.name || "Welcome"}
          <span className="avatar" aria-hidden="true">
            {data?.user.name?.slice(0, 1) || "C"}
          </span>
        </div>
      </header>
      <div className="utility-bar">
        <span className="eyebrow">
          {data ? modeLabel(data) : "YOUR DOORSTEP, IN WORDS"}
        </span>
        <span className={`connection ${connection}`} role="status">
          <i aria-hidden="true" />
          {connection === "live"
            ? "Connected"
            : connection === "offline"
              ? "Offline · No live alerts"
              : connection === "reconnecting"
                ? "Reconnecting · Checking for updates"
                : "Connecting to your door"}
        </span>
      </div>
      <main id="main" className="main-content">
        {children}
      </main>
      <footer className="site-footer">
        <span>Understand your doorstep without relying on sound.</span>
        <span>Text is always your choice.</span>
      </footer>
    </div>
  );
}
export function ErrorNotice({ message }: { message: string }) {
  return message ? (
    <div className="notice error" role="alert">
      <strong>We couldn’t complete that.</strong>
      <span>{message}</span>
    </div>
  ) : null;
}
export function Loading({ label = "Opening your door…" }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <DoorMark />
      <p>{label}</p>
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="small-glyph" aria-hidden="true">
        ⌁
      </span>
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}
export function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "green" | "amber";
}) {
  return <span className={`pill ${tone}`}>{children}</span>;
}
export function AccessGate({ error }: { error?: string }) {
  return (
    <Shell>
      <div className="narrow page-block">
        <p className="eyebrow">YOUR SPACE</p>
        <h1>Let’s open your door.</h1>
        <p>Sign in to your household to see visits and messages.</p>
        {error ? <ErrorNotice message={error} /> : null}
        <Link className="button primary" href="/onboarding">
          Open setup <Arrow />
        </Link>
      </div>
    </Shell>
  );
}
