import { describe, it, expect, beforeEach } from "vitest";
import { webmcp } from "./registry";
import { text, type WebMcpToolDef } from "./types";

function tool(name: string): WebMcpToolDef {
  return { name, description: name, execute: () => text("ok") };
}

describe("registry snapshots", () => {
  beforeEach(() => {
    for (const t of [...webmcp.list()]) {
      const scope = webmcp.scopeOf(t.name);
      if (scope) webmcp.register(scope, [])();
    }
  });

  // Regression: `list()` used to build a new array on every call. That is fine
  // for ordinary callers and fatal for `useSyncExternalStore`, which compares
  // snapshots by identity — a fresh array per render means React never converges
  // and the subtree dies with "The result of getSnapshot should be cached".
  // This shipped and took down the whole /brain layout, because AgentPanel is
  // mounted there.
  it("returns the identical array reference until something changes", () => {
    const a = webmcp.list();
    const b = webmcp.list();
    expect(a).toBe(b);
  });

  it("returns a new reference once tools change", () => {
    const before = webmcp.list();
    const dispose = webmcp.register("test:one", [tool("t.one")]);
    const after = webmcp.list();
    expect(after).not.toBe(before);
    expect(after.map((t) => t.name)).toContain("t.one");
    dispose();
  });

  it("settles back to a stable reference after unregistering", () => {
    const dispose = webmcp.register("test:two", [tool("t.two")]);
    dispose();
    const a = webmcp.list();
    const b = webmcp.list();
    expect(a).toBe(b);
    expect(a.map((t) => t.name)).not.toContain("t.two");
  });

  it("reports the tools it holds and runs them", async () => {
    const dispose = webmcp.register("test:three", [tool("t.three")]);
    expect(webmcp.scopeOf("t.three")).toBe("test:three");
    const result = await webmcp.execute("t.three", {});
    expect(result.content[0].text).toBe("ok");
    dispose();
  });

  it("names the available tools when asked for one that does not exist", async () => {
    const dispose = webmcp.register("test:four", [tool("t.four")]);
    const result = await webmcp.execute("t.nope", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("t.four");
    dispose();
  });
});
