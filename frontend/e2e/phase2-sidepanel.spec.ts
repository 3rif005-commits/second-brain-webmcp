import { test, expect } from "@playwright/test";

test.describe("AI SidePanel", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', process.env.TEST_USER_EMAIL ?? "aubrif005@gmail.com");
    await page.fill('input[type="password"]', process.env.TEST_USER_PASSWORD ?? "SecondBrain2026!");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/brain**");
  });

  test("opens AI panel via toggle button", async ({ page }) => {
    const toggleBtn = page.getByRole("button", { name: "Open AI panel" });
    await expect(toggleBtn).toBeVisible();
    await toggleBtn.click();
    await expect(page.getByRole("complementary", { name: "AI assistant panel" })).toBeVisible();
  });

  test("opens via ?ai=open URL param", async ({ page }) => {
    await page.goto("/brain?ai=open");
    await expect(page.getByRole("complementary", { name: "AI assistant panel" })).toBeVisible();
    // param should be stripped from URL
    await expect(page).not.toHaveURL(/ai=open/);
  });

  test("closes with X button", async ({ page }) => {
    await page.goto("/brain?ai=open");
    await page.getByRole("button", { name: "Close AI panel" }).click();
    await expect(page.getByRole("complementary", { name: "AI assistant panel" })).not.toBeVisible();
  });

  test("⌘P opens search modal", async ({ page }) => {
    await page.goto("/brain");
    await page.keyboard.press("Meta+p");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("/brain/chat redirects to ?ai=open", async ({ page }) => {
    await page.goto("/brain/chat");
    await page.waitForURL("**/brain**");
    await expect(page).not.toHaveURL("/brain/chat");
    await expect(page.getByRole("complementary", { name: "AI assistant panel" })).toBeVisible();
  });
});
