import path from "path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirrors tsconfig.json's "@/*" -> "./*" path mapping. Previously
    // absent — every prior test used relative imports, so nothing exercised
    // "@/..." resolution; the database feature's tests need it (they mock
    // "@/app/providers" and "@/lib/supabase/server", which requires the
    // specifier to resolve to a real module for Vitest to intercept).
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "jsdom",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/.next/**", "**/e2e/**"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
