import { test, expect } from "@playwright/test";

test.describe("Agent Chat — Phase 1", () => {
  test("sends a question and streams a response with skill badge", async ({ page }) => {
    // Uses the auth session from playwright.config.ts (storageState: AUTH_FILE)
    await page.goto("/brain/chat");
    await expect(page.getByRole("heading", { name: /what do you want to know/i }))
      .toBeVisible();

    const input = page.getByRole("textbox", { name: /message input/i });
    await input.fill("Cite some notes from my brain about anything");
    await page.getByRole("button", { name: /^send$/i }).click();

    // User bubble appears
    await expect(page.getByText("Cite some notes from my brain about anything"))
      .toBeVisible();

    // Skill badge appears (cite-everything matches by "cite" and "notes")
    await expect(page.locator("text=/Loaded skill:.*cite-everything/"))
      .toBeVisible({ timeout: 30000 });

    // Wait for streaming to complete — assistant message visible
    await expect(page.locator("[role=log] >> text=AI").first())
      .toBeVisible({ timeout: 60000 });
  });

  test("can switch model mode", async ({ page }) => {
    await page.goto("/brain/chat");
    const toggle = page.getByRole("button", { name: /AI mode/i });
    await expect(toggle).toBeVisible();
    const before = await toggle.textContent();
    await toggle.click();
    const after = await toggle.textContent();
    expect(after).not.toBe(before);
  });
});
