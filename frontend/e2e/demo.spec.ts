import { test } from "@playwright/test";
import path from "path";
import fs from "fs";

const OUT = path.join(process.cwd(), "e2e/screenshots");
fs.mkdirSync(OUT, { recursive: true });

test.setTimeout(60000);

test("full UI walkthrough", async ({ page }) => {
  // 1. Login page — empty
  await page.goto("/login");
  await page.waitForSelector('button[type="submit"]');
  await page.screenshot({ path: `${OUT}/01-login-empty.png` });

  // 2. Fill login form
  await page.fill('[placeholder="you@example.com"]', "ayoub@example.com");
  await page.fill('[placeholder="••••••••"]', "mypassword123");
  await page.screenshot({ path: `${OUT}/02-login-filled.png` });

  // 3. Submit — loading state
  await page.click('button[type="submit"]');
  await page.screenshot({ path: `${OUT}/03-login-loading.png` });

  // 4. After Supabase responds
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/04-login-after-attempt.png` });

  // 5. Signup page — empty
  await page.goto("/signup");
  await page.waitForSelector('button[type="submit"]');
  await page.screenshot({ path: `${OUT}/05-signup-empty.png` });

  // 6. Fill signup form
  await page.fill('[placeholder="Ada Lovelace"]', "Ayoub");
  await page.fill('[placeholder="you@example.com"]', "ayoub@example.com");
  await page.fill('[placeholder="Min. 8 characters"]', "mypassword123");
  await page.screenshot({ path: `${OUT}/06-signup-filled.png` });

  // 7. Submit signup
  await page.click('button[type="submit"]');
  await page.screenshot({ path: `${OUT}/07-signup-loading.png` });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/08-signup-after-attempt.png` });

  // 8. Navigate between pages via links
  await page.goto("/login");
  await page.waitForSelector('text=Sign up');
  await page.click('text=Sign up');
  await page.waitForSelector('button[type="submit"]');
  await page.screenshot({ path: `${OUT}/09-nav-to-signup.png` });

  await page.click('text=Sign in');
  await page.waitForSelector('button[type="submit"]');
  await page.screenshot({ path: `${OUT}/10-nav-back-to-login.png` });
});
