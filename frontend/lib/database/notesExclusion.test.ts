import { afterEach, describe, expect, it, vi } from "vitest";
import { notesTableName } from "./notesExclusion";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("notesTableName", () => {
  it("returns 'notes' when DATABASE_ROWS_ENABLED is unset (the default)", () => {
    vi.stubEnv("DATABASE_ROWS_ENABLED", "");
    expect(notesTableName()).toBe("notes");
  });

  it("returns 'notes' for any non-'true' value", () => {
    vi.stubEnv("DATABASE_ROWS_ENABLED", "1");
    expect(notesTableName()).toBe("notes");
  });

  it("returns 'notes_excluding_database_rows' when the flag is exactly 'true'", () => {
    vi.stubEnv("DATABASE_ROWS_ENABLED", "true");
    expect(notesTableName()).toBe("notes_excluding_database_rows");
  });
});
