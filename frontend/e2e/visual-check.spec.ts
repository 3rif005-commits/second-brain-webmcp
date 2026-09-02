import { test, expect } from "@playwright/test";
import path from "path";
import fs from "fs";

const OUT = path.join(process.cwd(), "e2e/screenshots");
fs.mkdirSync(OUT, { recursive: true });

test("root redirects to /login when unauthenticated", async ({ page }) => {
  await page.goto("/");
  await page.waitForURL("**/login", { timeout: 10000 });
  await page.screenshot({ path: `${OUT}/01-login-redirect.png` });
  expect(page.url()).toContain("/login");
});

test("login page renders correctly", async ({ page }) => {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${OUT}/02-login-page.png` });
  await expect(page.getByText("Second Brain")).toBeVisible();
  await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
  await expect(page.getByPlaceholder("••••••••")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("signup page renders correctly", async ({ page }) => {
  await page.goto("/signup");
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${OUT}/03-signup-page.png` });
  await expect(page.getByText("Create your knowledge OS")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
});

test("/brain redirects to /login when unauthenticated", async ({ page }) => {
  await page.goto("/brain");
  await page.waitForURL("**/login", { timeout: 10000 });
  await page.screenshot({ path: `${OUT}/04-brain-redirects.png` });
  expect(page.url()).toContain("/login");
});

test("login form shows error on bad credentials", async ({ page }) => {
  await page.goto("/login");
  await page.fill('[placeholder="you@example.com"]', "bad@example.com");
  await page.fill('[placeholder="••••••••"]', "wrongpassword");
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/05-login-error.png` });
});
