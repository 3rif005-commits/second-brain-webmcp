import { createHash } from "node:crypto";

/**
 * Hashes a caller's IP address for `db_form_submissions.ip_hash` — the raw
 * IP is never sent to Postgres at all (migration 018_forms.sql's
 * `submit_form_response` only ever receives the hash), matching the
 * migration's "never store a raw IP" requirement one layer earlier.
 *
 * `FORM_IP_SALT` is a per-deploy secret (server-only env var, never
 * `NEXT_PUBLIC_*`). Falls back to a fixed dev-only string so local
 * development / tests don't require setting it — production deploys should
 * set `FORM_IP_SALT` to a real secret; without it, the hash is still salted
 * (so it's not a bare unsalted sha256(ip)), just with a value anyone reading
 * this file could reproduce.
 */
export function hashIp(ip: string): string {
  const salt = process.env.FORM_IP_SALT || "dev-only-insecure-salt-set-FORM_IP_SALT-in-production";
  return createHash("sha256").update(`${ip}:${salt}`).digest("hex");
}

/**
 * Extracts the caller's IP from a Route Handler's `Request`. This app has
 * no prior IP-reading code anywhere (grepped) and Next.js's own
 * `NextRequest.ip` accessor was removed in recent versions, so this reads
 * the standard reverse-proxy headers directly: `x-forwarded-for` (a
 * comma-separated list; the first entry is the original client) then
 * `x-real-ip`. Neither header is present when hitting the dev server
 * directly (no proxy in front) — falls back to a fixed placeholder so the
 * route still works locally rather than 500ing, at the cost of every local
 * request sharing one rate-limit bucket.
 */
export function extractIp(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}
