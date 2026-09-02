import type { NextConfig } from "next";
import os from "os";

function localNetworkHosts(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a!.address);
}

const nextConfig: NextConfig = {
  allowedDevOrigins: localNetworkHosts(),
  async headers() {
    return [
      {
        source: "/manifest.json",
        headers: [{ key: "Content-Type", value: "application/manifest+json" }],
      },
      {
        // Service worker needs to run from root scope
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
  // Transpile BlockNote client packages so Turbopack deduplicates Yjs.
  // @blocknote/xl-ai is NOT here — it's in serverExternalPackages so that
  // Node.js loads it natively (its server bundle requires ESM-only peer deps
  // that can't be bundled via CJS require).
  transpilePackages: [
    "@blocknote/core",
    "@blocknote/react",
    "@blocknote/mantine",
    "@handlewithcare/prosemirror-inputrules",
    "@handlewithcare/prosemirror-suggest-changes",
  ],
  // Let Node.js load @blocknote/xl-ai as a native ESM module for API routes.
  serverExternalPackages: ["@blocknote/xl-ai"],
  turbopack: {},
};

export default nextConfig;
