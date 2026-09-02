/**
 * Test: full note lifecycle — create, type content, auto-save, persist across reload,
 * title edit, delete, sidebar reflection.
 *
 * Runs with saved auth session (user is logged in).
 */
import { test, expect } from "@playwright/test";

test.describe("note CRUD", () => {
  test("/ redirects authenticated user to /brain", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL("**/brain");
    expect(page.url()).toContain("/brain");
  });

  test("/login redirects authenticated user to /brain", async ({ page }) => {
    await page.goto("/login");
    await page.waitForURL("**/brain");
    expect(page.url()).toContain("/brain");
  });

  test("brain page shows sidebar and empty state", async ({ page }) => {
    await page.goto("/brain");
    // Use exact/role selectors to avoid matching text in the welcome paragraph
    await expect(page.getByText("Second Brain", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "+ New Note" })).toBeVisible();
  });

  test("create new note — editor opens", async ({ page }) => {
    await page.goto("/brain");
    await page.waitForSelector("text=+ New Note");
    await page.click("text=+ New Note");

    // Should navigate to /brain/<uuid>
    await page.waitForURL(/\/brain\/[0-9a-f-]{36}/, { timeout: 10000 });
    expect(page.url()).toMatch(/\/brain\/[0-9a-f-]{36}/);

    // BlockNote editor should be present (loaded via dynamic import)
    await expect(page.locator(".bn-editor")).toBeVisible({ timeout: 15000 });
  });

  test("type content → auto-saves → content persists after reload", async ({ page }) => {
    // Create a new note
    await page.goto("/brain");
    await page.click("text=+ New Note");
    await page.waitForURL(/\/brain\/[0-9a-f-]{36}/, { timeout: 10000 });
    const noteUrl = page.url();

    // Wait for editor
    await page.waitForSelector(".bn-editor", { timeout: 15000 });

    // Click inside the editor and type
    await page.locator(".bn-editor").click();
    const testContent = `Test content ${Date.now()}`;
    await page.keyboard.type(testContent);

    // Wait for the 2s debounce then save to complete.
    // "Saved HH:MM:SS" appears after the PATCH succeeds.
    await expect(page.locator("text=Saved")).toBeVisible({ timeout: 10000 });

    // Reload and verify content is still there
    await page.goto(noteUrl);
    await page.waitForSelector(".bn-editor", { timeout: 15000 });
    await expect(page.locator(".bn-editor")).toContainText(testContent, { timeout: 8000 });
  });

  test("edit title → saved on blur → persists after reload", async ({ page }) => {
    await page.goto("/brain");
    await page.click("text=+ New Note");
    await page.waitForURL(/\/brain\/[0-9a-f-]{36}/, { timeout: 10000 });
    const noteUrl = page.url();

    const titleInput = page.locator('input[placeholder="Untitled"]');
    await expect(titleInput).toBeVisible({ timeout: 10000 });

    const newTitle = `My Note ${Date.now()}`;
    await titleInput.fill(newTitle);
    await titleInput.blur(); // triggers PATCH

    await page.waitForTimeout(1000); // allow PATCH to complete

    // Reload — title should persist
    await page.goto(noteUrl);
    await expect(page.locator('input[placeholder="Untitled"]')).toHaveValue(newTitle, { timeout: 5000 });
  });

  test("delete note from editor — removed from sidebar", async ({ page }) => {
    // Create note
    await page.goto("/brain");
    await page.click("text=+ New Note");
    await page.waitForURL(/\/brain\/[0-9a-f-]{36}/, { timeout: 10000 });

    const uniqueTitle = `Delete Me ${Date.now()}`;
    const titleInput = page.locator('input[placeholder="Untitled"]');
    await expect(titleInput).toBeVisible({ timeout: 10000 });
    await titleInput.fill(uniqueTitle);
    await titleInput.blur();
    await page.waitForTimeout(500);

    // Register dialog handler BEFORE clicking delete
    page.on("dialog", (dialog) => dialog.accept());
    await page.locator("button", { hasText: "Delete" }).click();

    // Should redirect back to /brain
    await page.waitForURL("**/brain", { timeout: 8000 });

    // Note should no longer appear in sidebar
    await expect(page.locator(`text=${uniqueTitle}`)).not.toBeVisible({ timeout: 5000 });
  });

  test("sidebar delete button removes note", async ({ page }) => {
    // Create note
    await page.goto("/brain");
    await page.click("text=+ New Note");
    await page.waitForURL(/\/brain\/[0-9a-f-]{36}/, { timeout: 10000 });

    const uniqueTitle = `Sidebar Delete ${Date.now()}`;
    const titleInput = page.locator('input[placeholder="Untitled"]');
    await expect(titleInput).toBeVisible({ timeout: 10000 });
    await titleInput.fill(uniqueTitle);
    await titleInput.blur();
    await page.waitForTimeout(500);

    // Navigate to brain index
    await page.goto("/brain");
    await expect(page.locator(`text=${uniqueTitle}`)).toBeVisible({ timeout: 5000 });

    // Hover over the note item to reveal the ✕ delete button
    const noteLink = page.locator(`a`, { hasText: uniqueTitle });
    await noteLink.hover();
    // The delete button is the sibling button inside the same group div
    const deleteBtn = noteLink.locator("..").locator("button[title='Delete note']");

    // Register dialog handler BEFORE clicking
    page.on("dialog", (dialog) => dialog.accept());
    await deleteBtn.click();

    await expect(page.locator(`text=${uniqueTitle}`)).not.toBeVisible({ timeout: 5000 });
  });

  test("sign out — redirected to /login", async ({ page }) => {
    await page.goto("/brain");
    await page.locator("button[title='Sign out']").click();
    await page.waitForURL("**/login", { timeout: 8000 });
    expect(page.url()).toContain("/login");
  });
});
