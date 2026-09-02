import { chromium } from "@playwright/test";
import path from "path";

const BASE = "http://localhost:3000";
const OUT = path.join(process.cwd(), "e2e/screenshots");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  async function shot(name: string, url: string) {
    await page.goto(url, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
    console.log(`✓ ${name} → e2e/screenshots/${name}.png  (${page.url()})`);
  }

  await page.goto(BASE, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
  await shot("01-root-redirect", page.url());

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
  await shot("02-login-page", page.url());

  await page.goto(`${BASE}/signup`, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
  await shot("03-signup-page", page.url());

  await page.goto(`${BASE}/brain`, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
  await shot("04-brain-unauthed", page.url());

  await browser.close();
  console.log("\nDone. Open e2e/screenshots/*.png to review.");
})();
