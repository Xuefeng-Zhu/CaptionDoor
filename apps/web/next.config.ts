import type { NextConfig } from "next";
import path from "node:path";
const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  outputFileTracingExcludes: {
    "/*": ["../../.env", "../../.env.*", ".env", ".env.*"],
  },
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  devIndicators: false,
  poweredByHeader: false,
  logging: {
    incomingRequests: false,
    serverFunctions: false,
    browserToTerminal: false,
    fetches: { fullUrl: false },
  },
  transpilePackages: ["@captiondoor/domain", "@captiondoor/contracts"],
  experimental: { externalDir: true },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "microphone=(), geolocation=()" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      {
        source: "/api/(.*)",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};
export default config;
