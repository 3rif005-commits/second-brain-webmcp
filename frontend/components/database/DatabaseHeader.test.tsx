import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { DatabaseHeader } from "./DatabaseHeader";
import type { DatabaseResponse, DataSourceResponse } from "@/lib/database/types";

function db(overrides: Partial<DatabaseResponse> = {}): DatabaseResponse {
  return {
    id: "db-1",
    user_id: "user-1",
    title: "My Database",
    description: [],
    icon: null,
    cover_url: null,
    is_inline: false,
    parent_note_id: null,
    is_locked: false,
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

const DATA_SOURCE: DataSourceResponse = {
  id: "ds-1",
  database_id: "db-1",
  user_id: "user-1",
  name: "Default",
  system_kind: null,
  position: 0,
  created_at: "2026-01-01T00:00:00Z",
  is_virtual: false,
};

describe("DatabaseHeader", () => {
  it("renders the title as an always-editable input, not a static heading", () => {
    render(
      <DatabaseHeader database={db()} dataSource={DATA_SOURCE} editable onUpdate={vi.fn()} onDelete={vi.fn()} />
    );
    expect(screen.getByLabelText("Database title")).toHaveValue("My Database");
  });

  it("renaming the title commits on blur", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(
      <DatabaseHeader database={db()} dataSource={DATA_SOURCE} editable onUpdate={onUpdate} onDelete={vi.fn()} />
    );
    const input = screen.getByLabelText("Database title");
    await user.clear(input);
    await user.type(input, "Renamed");
    await user.tab();
    expect(onUpdate).toHaveBeenCalledWith({ title: "Renamed" });
  });

  it("clicking 'Add icon' assigns a random emoji immediately", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(
      <DatabaseHeader database={db()} dataSource={DATA_SOURCE} editable onUpdate={onUpdate} onDelete={vi.fn()} />
    );
    await user.click(screen.getByText("Add icon"));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const [patch] = onUpdate.mock.calls[0];
    expect(typeof patch.icon).toBe("string");
    expect(patch.icon.length).toBeGreaterThan(0);
  });

  it("once an icon is set, the hover row no longer offers 'Add icon' — the icon itself is the trigger", () => {
    render(
      <DatabaseHeader database={db({ icon: "🚋" })} dataSource={DATA_SOURCE} editable onUpdate={vi.fn()} onDelete={vi.fn()} />
    );
    expect(screen.queryByText("Add icon")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change icon" })).toHaveTextContent("🚋");
  });

  it("'Add description' toggles a field on, which commits on blur, and the button becomes 'Hide description'", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(
      <DatabaseHeader database={db()} dataSource={DATA_SOURCE} editable onUpdate={onUpdate} onDelete={vi.fn()} />
    );
    await user.click(screen.getByText("Add description"));
    expect(screen.getByText("Hide description")).toBeInTheDocument();

    const field = screen.getByLabelText("Database description");
    await user.type(field, "What this tracks");
    await user.tab();
    expect(onUpdate).toHaveBeenCalledWith({ description: [{ text: "What this tracks" }] });
  });

  it("All Notes (is_virtual) suppresses icon/description/rename entirely, showing a static title and a Read only badge", () => {
    render(
      <DatabaseHeader
        database={db()}
        dataSource={{ ...DATA_SOURCE, is_virtual: true }}
        editable={false}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.queryByLabelText("Database title")).not.toBeInTheDocument();
    expect(screen.getByText("My Database")).toBeInTheDocument();
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.queryByText("Add icon")).not.toBeInTheDocument();
  });

  it("the page menu's Move to Trash confirms, then deletes", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <DatabaseHeader database={db()} dataSource={DATA_SOURCE} editable onUpdate={vi.fn()} onDelete={onDelete} />
    );
    await user.click(screen.getByRole("button", { name: "Database options" }));
    await user.click(screen.getByText("Move to Trash"));
    await user.click(screen.getByRole("button", { name: /^move to trash$/i }));
    expect(onDelete).toHaveBeenCalled();
  });
});
