/**
 * Test: auth guards — unauthenticated users cannot access /brain,
 * authenticated users are redirected away from /login and /signup.
 *
 * These tests run WITHOUT the auth storageState (no login).
 */
import { test, expect } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } }); // explicitly unauthenticated

test.describe("unauthenticated guards", () => {
  test("/brain redirects to /login", async ({ page }) => {
    await page.goto("/brain");
    await page.waitForURL("**/login");
    expect(page.url()).toContain("/login");
  });

  test("/brain/some-uuid redirects to /login", async ({ page }) => {
    await page.goto("/brain/00000000-0000-0000-0000-000000000000");
    await page.waitForURL("**/login");
    expect(page.url()).toContain("/login");
  });

  test("/login renders the login form", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator('button[type="submit"]')).toBeVisible();
    await expect(page.locator('[placeholder="you@example.com"]')).toBeVisible();
    await expect(page.locator('[placeholder="••••••••"]')).toBeVisible();
  });

  test("/signup renders the signup form", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.locator('button[type="submit"]')).toBeVisible();
    await expect(page.locator('[placeholder="Ada Lovelace"]')).toBeVisible();
    await expect(page.locator('[placeholder="you@example.com"]')).toBeVisible();
    await expect(page.locator('[placeholder="Min. 8 characters"]')).toBeVisible();
  });

  test("login with wrong password shows error", async ({ page }) => {
    await page.goto("/login");
    await page.waitForSelector('button[type="submit"]');
    await page.fill('[placeholder="you@example.com"]', "aubrif005@gmail.com");
    await page.fill('[placeholder="••••••••"]', "wrong-password-xyz");
    await page.click('button[type="submit"]');
    await expect(page.locator("text=Invalid login credentials")).toBeVisible({ timeout: 10000 });
  });

  test("/ redirects to /login when unauthenticated", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL("**/login");
    expect(page.url()).toContain("/login");
  });
});
