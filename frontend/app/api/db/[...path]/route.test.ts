// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getSession },
  })),
}));

import { GET, POST, PATCH, DELETE } from "./route";

function ctxFor(path: string[]) {
  return { params: Promise.resolve({ path }) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET/POST/PATCH/DELETE /api/db/[...path]", () => {
  it("returns 401 without forwarding when there is no session", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    const fetchSpy = vi.spyOn(global, "fetch");

    const res = await GET(new Request("http://localhost/api/db/databases"), ctxFor(["databases"]));

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards GET to ${FASTAPI_URL}/db/<path> with the JWT and query string, prepending db/", async () => {
    vi.stubEnv("FASTAPI_URL", "http://backend:9000");
    getSession.mockResolvedValue({ data: { session: { access_token: "tok-123" } } });
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const res = await GET(
      new Request("http://localhost/api/db/data-sources/all-notes/rows?foo=bar"),
      ctxFor(["data-sources", "all-notes", "rows"])
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [target, init] = fetchSpy.mock.calls[0];
    expect(target).toBe("http://backend:9000/db/data-sources/all-notes/rows?foo=bar");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok-123" });
    expect(res.status).toBe(200);
  });

  it("forwards POST with a JSON body and Content-Type", async () => {
    vi.stubEnv("FASTAPI_URL", "http://backend:9000");
    getSession.mockResolvedValue({ data: { session: { access_token: "tok-abc" } } });
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 201 }));

    const req = new Request("http://localhost/api/db/databases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New DB" }),
    });
    const res = await POST(req, ctxFor(["databases"]));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [target, init] = fetchSpy.mock.calls[0];
    expect(target).toBe("http://backend:9000/db/databases");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as any).headers["Content-Type"]).toBe("application/json");
    expect(res.status).toBe(201);
  });

  it("forwards PATCH to the right target", async () => {
    vi.stubEnv("FASTAPI_URL", "http://backend:9000");
    getSession.mockResolvedValue({ data: { session: { access_token: "tok-abc" } } });
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await PATCH(
      new Request("http://localhost/api/db/properties/prop-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      }),
      ctxFor(["properties", "prop-1"])
    );

    expect(fetchSpy.mock.calls[0][0]).toBe("http://backend:9000/db/properties/prop-1");
  });

  it("forwards DELETE to the right target", async () => {
    vi.stubEnv("FASTAPI_URL", "http://backend:9000");
    getSession.mockResolvedValue({ data: { session: { access_token: "tok-abc" } } });
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    await DELETE(
      new Request("http://localhost/api/db/properties/prop-1", { method: "DELETE" }),
      ctxFor(["properties", "prop-1"])
    );

    expect(fetchSpy.mock.calls[0][0]).toBe("http://backend:9000/db/properties/prop-1");
  });

  it("forwards the X-Export-Truncated header when the backend sets it (task-51 Fix 5)", async () => {
    vi.stubEnv("FASTAPI_URL", "http://backend:9000");
    getSession.mockResolvedValue({ data: { session: { access_token: "tok-123" } } });
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("id,Title\n", {
        status: 200,
        headers: { "Content-Type": "text/csv", "X-Export-Truncated": "true" },
      })
    );

    const res = await GET(
      new Request("http://localhost/api/db/data-sources/ds-1/export?view_id=v1"),
      ctxFor(["data-sources", "ds-1", "export"])
    );

    expect(res.headers.get("X-Export-Truncated")).toBe("true");
  });

  it("does not set X-Export-Truncated when the backend response has no such header", async () => {
    vi.stubEnv("FASTAPI_URL", "http://backend:9000");
    getSession.mockResolvedValue({ data: { session: { access_token: "tok-123" } } });
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("id,Title\n", { status: 200, headers: { "Content-Type": "text/csv" } })
    );

    const res = await GET(
      new Request("http://localhost/api/db/data-sources/ds-1/export?view_id=v1"),
      ctxFor(["data-sources", "ds-1", "export"])
    );

    expect(res.headers.get("X-Export-Truncated")).toBeNull();
  });

  it("returns 503 with a helpful message when the backend refuses the connection", async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: "tok-abc" } } });
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8000"));

    const res = await GET(new Request("http://localhost/api/db/databases"), ctxFor(["databases"]));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/backend not running/i);
  });
});
