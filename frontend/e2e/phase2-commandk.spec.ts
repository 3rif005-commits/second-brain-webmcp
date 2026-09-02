import { test, expect } from "@playwright/test";

test.describe("CommandK launcher", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', process.env.TEST_USER_EMAIL ?? "aubrif005@gmail.com");
    await page.fill('input[type="password"]', process.env.TEST_USER_PASSWORD ?? "SecondBrain2026!");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/brain**");
  });

  test("⌘K opens compact modal", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("dialog", { name: "AI assistant" })).toBeVisible();
    await expect(page.getByLabel("AI query")).toBeFocused();
  });

  test("Esc closes compact modal", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("submit expands to full chat", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    await page.getByLabel("AI query").fill("Hello");
    await page.keyboard.press("Enter");
    // After expansion, Chat component renders with its Send button
    await expect(page.getByLabel("Message input")).toBeVisible({ timeout: 3000 });
  });

  test("Esc in expanded goes back to compact", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    await page.getByLabel("AI query").fill("Hello");
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Message input")).toBeVisible({ timeout: 3000 });
    await page.keyboard.press("Escape");
    // Back to compact — Message input is gone, AI query input is back
    await expect(page.getByLabel("AI query")).toBeVisible();
    await expect(page.getByLabel("Message input")).not.toBeVisible();
  });

  test("⌘K again closes compact modal", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("dialog", { name: "AI assistant" })).toBeVisible();
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("dialog", { name: "AI assistant" })).not.toBeVisible();
  });
});
