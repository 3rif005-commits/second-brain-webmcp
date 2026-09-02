import { defineConfig } from "@playwright/test";
import path from "path";

const AUTH_FILE = path.join(process.cwd(), "e2e/.auth/user.json");

export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  retries: 1,

  use: {
    baseURL: "http://localhost:3000",
    headless: true,
    viewport: { width: 1280, height: 800 },
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  reporter: [["list"]],

  projects: [
    // 1. Auth setup — runs first, saves session to e2e/.auth/user.json
    {
      name: "auth-setup",
      testMatch: "**/setup/auth.setup.ts",
    },

    // 2. Protected-route tests — run WITHOUT auth (tests explicitly clear state)
    {
      name: "protected-routes",
      testMatch: "**/01-protected-routes.spec.ts",
    },

    // 3. Note CRUD tests — run WITH the saved auth session
    {
      name: "notes-crud",
      testMatch: "**/02-notes-crud.spec.ts",
      dependencies: ["auth-setup"],
      use: { storageState: AUTH_FILE },
    },

    // 4. Phase 2 ingest tests — PDF + YouTube URL
    {
      name: "ingest",
      testMatch: "**/03-ingest.spec.ts",
      dependencies: ["auth-setup"],
      use: { storageState: AUTH_FILE },
      timeout: 360_000, // LLM generation can be slow on free-tier models
    },
  ],
});
