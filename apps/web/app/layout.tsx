import type { Metadata, Viewport } from "next";
import "./globals.css";
import { BrowserSetup } from "../components/browser-setup";
export const metadata: Metadata = {
  title: {
    default: "CaptionDoor · Your doorstep, in words",
    template: "%s · CaptionDoor",
  },
  description: "Understand your doorstep without relying on sound.",
  manifest: "/manifest.webmanifest",
  robots: { index: false, follow: false },
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f5f3ed",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <BrowserSetup />
        {children}
      </body>
    </html>
  );
}
