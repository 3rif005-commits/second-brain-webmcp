// Grep-based regression guard (task-22-brief.md's own instruction: "this
// has regressed before"). Native `window.confirm`/`window.prompt`/
// `window.alert` — and bare `confirm(`/`prompt(`/`alert(` — freeze the tab
// for browser automation; every interactive control in this feature must
// use `components/ui/ConfirmDialog`/`PromptDialog`/`useToast()` instead.
// Scoped to the directories this task (and the Milestone 2-7 database
// feature generally) touches, not the whole repo — `components/ui/
// ConfirmDialog.tsx`'s own header comment *mentions* "window.confirm()" in
// prose, which would be a false positive for a repo-wide scan; scoping
// avoids needing to special-case that file's comments instead.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const SCAN_ROOTS = [join(__dirname, "..", "..", "components", "database"), __dirname];

// window.confirm(/window.prompt(/window.alert( as a real call, or the bare
// form (confirm(/prompt(/alert() — but not inside an identifier like
// "PromptDialog" or "ConfirmDialog" (negative lookbehind for a word
// character or ".").
const FORBIDDEN = /(?<![\w.])(window\.)?(confirm|prompt|alert)\s*\(/;

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listFiles(full));
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("no native window.confirm/prompt/alert", () => {
  const files = SCAN_ROOTS.flatMap(listFiles);

  it("scanned at least the files this task touched (sanity check the scan itself isn't vacuous)", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)("%s has no native confirm/prompt/alert call", (file) => {
    const source = readFileSync(file, "utf-8");
    const match = source.match(FORBIDDEN);
    expect(match, `found "${match?.[0]}" in ${file}`).toBeNull();
  });
});
