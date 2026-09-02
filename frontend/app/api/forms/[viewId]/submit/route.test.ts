// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ rpc })),
}));

import { POST } from "./route";

function ctxFor(viewId: string) {
  return { params: Promise.resolve({ viewId }) };
}

function postWith(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/forms/view-1/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  // `rpc` is a plain `vi.fn()`, not a `vi.spyOn()` spy — `restoreAllMocks()`
  // only restores spies to their original implementation, so it does NOT
  // clear a plain mock's accumulated call history. `clearAllMocks()` is the
  // one that resets `.mock.calls` between tests; without it, `rpc.mock.
  // calls[0]` in a later test can silently be a call left over from an
  // earlier one.
  vi.clearAllMocks();
});

describe("POST /api/forms/[viewId]/submit", () => {
  it("returns 400 for a missing/invalid body", async () => {
    const res = await POST(
      new Request("http://localhost/api/forms/view-1/submit", { method: "POST" }),
      ctxFor("view-1")
    );
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns 400 when properties is missing", async () => {
    const res = await POST(postWith({}), ctxFor("view-1"));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("hashes the caller's IP and calls submit_form_response via RPC, returning 201 + id on success", async () => {
    rpc.mockResolvedValue({ data: "new-row-id", error: null });

    const res = await POST(
      postWith(
        { properties: { ttl00001: { type: "title", title: "Hello" } } },
        { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }
      ),
      ctxFor("view-1")
    );

    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0];
    expect(fn).toBe("submit_form_response");
    expect(args.p_view_id).toBe("view-1");
    expect(args.p_properties).toEqual({ ttl00001: { type: "title", title: "Hello" } });
    // The raw IP never appears verbatim in the RPC call — only its hash.
    expect(args.p_ip_hash).not.toBe("203.0.113.7");
    expect(typeof args.p_ip_hash).toBe("string");
    expect(args.p_ip_hash.length).toBeGreaterThan(0);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ id: "new-row-id" });
  });

  it("hashes the same IP to the same value across requests (stable per-deploy salt)", async () => {
    rpc.mockResolvedValue({ data: "id-1", error: null });
    await POST(postWith({ properties: {} }, { "x-forwarded-for": "198.51.100.9" }), ctxFor("view-1"));
    const firstHash = rpc.mock.calls[0][1].p_ip_hash;

    rpc.mockClear();
    rpc.mockResolvedValue({ data: "id-2", error: null });
    await POST(postWith({ properties: {} }, { "x-forwarded-for": "198.51.100.9" }), ctxFor("view-1"));
    const secondHash = rpc.mock.calls[0][1].p_ip_hash;

    expect(firstHash).toBe(secondHash);
  });

  it("maps a form_not_found/form_closed RPC error to 400", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "form_closed" } });
    const res = await POST(postWith({ properties: {} }), ctxFor("view-1"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("maps a rate_limited RPC error to 429", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "rate_limited" } });
    const res = await POST(postWith({ properties: {} }), ctxFor("view-1"));
    expect(res.status).toBe(429);
  });

  it("maps a missing_required_property RPC error to 422", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "missing_required_property" } });
    const res = await POST(postWith({ properties: {} }), ctxFor("view-1"));
    expect(res.status).toBe(422);
  });

  it("never leaks a raw/unrecognised RPC error — falls back to a generic 500", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "relation db_row_props does not exist: internal detail" },
    });
    const res = await POST(postWith({ properties: {} }), ctxFor("view-1"));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).not.toContain("relation");
    expect(json.error).not.toContain("db_row_props");
  });
});
