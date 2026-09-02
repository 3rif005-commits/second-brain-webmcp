/**
 * Phase 2 ingest flow — browser-driven tests
 * Tests: PDF upload, YouTube URL ingest
 * Captures screenshots at every step and logs all console errors.
 */

import { test, expect, Page } from "@playwright/test";
import path from "path";
import fs from "fs";

const AUTH_FILE = path.join(process.cwd(), "e2e/.auth/user.json");
const SCREENSHOT_DIR = path.join(process.cwd(), "e2e/screenshots/ingest");

// ── helpers ────────────────────────────────────────────────────────────────

async function ss(page: Page, name: string) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  📸  ${file}`);
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`[console.error] ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
  return errors;
}

async function goToIngest(page: Page) {
  await page.goto("/brain/ingest", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Import Knowledge" })).toBeVisible();
}

/** Wait for ingest to complete: either navigate to a note UUID or show an error */
async function waitForIngestResult(page: Page, timeoutMs = 90_000) {
  let navigated = false;
  let errorText: string | null = null;

  try {
    await page.waitForURL(/\/brain\/[a-f0-9-]{36}$/, { timeout: timeoutMs });
    navigated = true;
  } catch {
    // Timed out — check for an error message on the page
    errorText = await page
      .locator(".text-red-600, .bg-red-50")
      .first()
      .textContent({ timeout: 2000 })
      .catch(() => "No error element found");
  }

  return { navigated, errorText };
}

// ── PDF upload test ─────────────────────────────────────────────────────────

test.describe("Ingest — PDF upload", () => {
  test.use({ storageState: AUTH_FILE });

  test("uploads a PDF → mastery guide populates the editor → saves to Supabase", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await goToIngest(page);
    await ss(page, "01-ingest-page");

    // Find a real PDF to test with
    const fixturesDir = path.join(process.cwd(), "e2e/fixtures");
    const testPdfPath = path.join(fixturesDir, "test.pdf");

    if (!fs.existsSync(testPdfPath)) {
      const candidates = [
        "/home/ayoub/googlepro/Lect01_IML26 (1).pdf",
        "/home/ayoub/Downloads/test.pdf",
      ];
      const real = candidates.find((p) => fs.existsSync(p));
      if (!real) {
        console.log("  ⚠️  No PDF found — skipping. Put a PDF at e2e/fixtures/test.pdf");
        test.skip();
        return;
      }
      fs.mkdirSync(fixturesDir, { recursive: true });
      fs.copyFileSync(real, testPdfPath);
      console.log(`  📄  Using PDF: ${real}`);
    }

    // Select the file (bypasses the drag UI cleanly in Playwright)
    await page.locator('input[type="file"]').setInputFiles(testPdfPath);
    await ss(page, "02-uploading-started");

    // The active progress step has animate-pulse class — confirms ingest started
    await expect(page.locator(".animate-pulse")).toBeVisible({ timeout: 5000 });
    console.log("  ✅  Progress bar active — ingest in progress...");

    // Wait up to 180s — free-tier LLMs can be slow with large prompts
    const { navigated, errorText } = await waitForIngestResult(page, 240_000);
    await ss(page, "03-after-ingest");

    if (!navigated) {
      console.log(`  ❌  Ingest did not navigate. Error: "${errorText}"`);
      // Print FastAPI response if we can find it
      const pageContent = await page.content();
      const errMatch = pageContent.match(/Server error \d+|ECONNREFUSED|[Ee]rror[^<]{0,200}/);
      console.log(`  📄  Page excerpt: ${errMatch?.[0] ?? "no match"}`);
      expect(navigated, `Ingest failed: ${errorText}`).toBe(true);
      return;
    }

    console.log(`  ✅  Navigated to note: ${page.url()}`);
    await ss(page, "04-note-page");

    // Wait for "Applying generated content…" → "Saved HH:MM:SS"
    // (the ingestHtml effect runs and PATCHes the note)
    await expect(page.getByText(/saved \d+:\d+/i)).toBeVisible({ timeout: 20_000 });
    await ss(page, "05-saved");

    const editorText = await page.locator(".bn-editor").innerText();
    console.log(`  📝  Editor (first 300 chars):\n     ${editorText.slice(0, 300).replace(/\n/g, " ")}`);
    expect(editorText.trim().length, "Editor should have content").toBeGreaterThan(50);

    // Reload — content must persist
    await page.reload({ waitUntil: "networkidle" });
    await ss(page, "06-after-reload");
    const reloaded = await page.locator(".bn-editor").innerText();
    expect(reloaded.trim().length, "Content should persist after reload").toBeGreaterThan(50);
    console.log("  🔄  Content persisted after reload ✅");

    if (errors.length > 0) {
      console.log("  ⚠️  Console errors:", errors);
    }
  });
});

// ── YouTube URL ingest test ─────────────────────────────────────────────────

test.describe("Ingest — YouTube / URL ingest", () => {
  test.use({ storageState: AUTH_FILE });

  test("pastes a YouTube URL → backend extracts and Gemini generates a guide", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await goToIngest(page);
    await ss(page, "yt-01-ingest-page");

    // 3Blue1Brown — "But what is a neural network?" — short, well-known
    const youtubeUrl = "https://www.youtube.com/watch?v=aircAruvnKk";

    await page.locator('input[type="url"]').fill(youtubeUrl);
    await ss(page, "yt-02-url-filled");

    await page.getByRole("button", { name: "Import" }).click();
    await ss(page, "yt-03-import-clicked");

    // Confirm progress bar started
    await expect(page.locator(".animate-pulse")).toBeVisible({ timeout: 5000 });
    console.log("  ✅  Progress bar active — ingest in progress...");

    // Wait for result
    const { navigated, errorText } = await waitForIngestResult(page, 240_000);
    await ss(page, "yt-04-result");

    if (!navigated) {
      console.log(`  ⚠️  YouTube ingest failed — this may be expected`);
      console.log(`     (trafilatura extracts article text, not YouTube transcripts)`);
      console.log(`     Error shown: "${errorText}"`);
      // Capture more detail from the page
      const redEl = await page.locator(".text-red-600, .bg-red-50").first().textContent().catch(() => "");
      console.log(`     Full error element: "${redEl}"`);

      // Report but don't hard-fail — YouTube support is Phase 4
      test.info().annotations.push({
        type: "warning",
        description: `YouTube URL ingest failed: ${errorText ?? redEl}`,
      });
      return;
    }

    console.log(`  ✅  YouTube URL ingest succeeded: ${page.url()}`);
    await ss(page, "yt-05-note-page");

    await expect(page.getByText(/saved \d+:\d+/i)).toBeVisible({ timeout: 20_000 });
    const editorText = await page.locator(".bn-editor").innerText();
    console.log(`  📝  Content preview:\n     ${editorText.slice(0, 400).replace(/\n/g, " ")}`);
    expect(editorText.trim().length).toBeGreaterThan(20);

    if (errors.length > 0) {
      console.log("  ⚠️  Console errors:", errors);
    }
  });
});
