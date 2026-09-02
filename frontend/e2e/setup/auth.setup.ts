/**
 * Playwright auth setup — logs in once, saves session to e2e/.auth/user.json.
 * All tests that depend on this project reuse the cookie without re-logging in.
 */
import { test as setup, expect } from "@playwright/test";
import path from "path";

export const AUTH_FILE = path.join(process.cwd(), "e2e/.auth/user.json");

setup("authenticate", async ({ page }) => {
  await page.goto("/login");
  await page.waitForSelector('button[type="submit"]');

  await page.fill('[placeholder="you@example.com"]', "aubrif005@gmail.com");
  await page.fill('[placeholder="••••••••"]', "SecondBrain2026!");
  await page.click('button[type="submit"]');

  // Wait for redirect to /brain — confirms login succeeded
  await page.waitForURL("**/brain", { timeout: 15000 });
  expect(page.url()).toContain("/brain");

  // Save auth cookies + localStorage
  await page.context().storageState({ path: AUTH_FILE });
});
