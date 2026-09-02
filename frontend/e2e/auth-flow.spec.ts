import { test, expect } from "@playwright/test";
import path from "path";
import fs from "fs";

const OUT = path.join(process.cwd(), "e2e/screenshots");
fs.mkdirSync(OUT, { recursive: true });

test.setTimeout(60000);

test("signup with real email", async ({ page }) => {
  await page.goto("/signup");
  await page.waitForSelector('button[type="submit"]');

  await page.fill('[placeholder="Ada Lovelace"]', "Ayoub");
  await page.fill('[placeholder="you@example.com"]', "aubrif005@gmail.com");
  await page.fill('[placeholder="Min. 8 characters"]', "SecondBrain2026!");
  await page.screenshot({ path: `${OUT}/auth-01-signup-filled.png` });

  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/auth-02-signup-result.png` });
});

test("login with real credentials", async ({ page }) => {
  await page.goto("/login");
  await page.waitForSelector('button[type="submit"]');

  await page.fill('[placeholder="you@example.com"]', "aubrif005@gmail.com");
  await page.fill('[placeholder="••••••••"]', "SecondBrain2026!");
  await page.screenshot({ path: `${OUT}/auth-03-login-filled.png` });

  await page.click('button[type="submit"]');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUT}/auth-04-login-result.png` });
  console.log("Final URL:", page.url());
});
