import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({
  useToast: () => ({ showToast }),
}));

// AutomationEditor is a large form (trigger/action sub-forms, cross-data-
// source fetches) unrelated to what this file tests (the list/create/
// delete surface, not the editor itself — AutomationEditor.test.tsx owns
// that), same reasoning TemplateManager.test.tsx already uses to stub
// TemplateEditor.
vi.mock("./AutomationEditor", () => ({
  AutomationEditor: ({ automation }: { automation: { name: string } }) => (
    <div data-testid="automation-editor">{automation.name}</div>
  ),
}));

import { AutomationManager } from "./AutomationManager";
import type { AutomationResponse } from "@/lib/database/types";

afterEach(() => {
  showToast.mockClear();
});

function automation(overrides: Partial<AutomationResponse>): AutomationResponse {
  return {
    id: "a1",
    data_source_id: "ds-1",
    user_id: "user-1",
    name: "Weekly digest",
    is_active: true,
    last_error: null,
    trigger_combinator: "any",
    triggers: [],
    view_id: null,
    actions: [],
    next_run_at: null,
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const NOOP = {
  onCreateAutomation: vi.fn(),
  onUpdateAutomation: vi.fn(),
  onDeleteAutomation: vi.fn(),
};

describe("AutomationManager", () => {
  it("lists automations, showing Inactive/Failed badges where relevant", () => {
    const automations = [
      automation({ id: "a1", name: "Plain" }),
      automation({ id: "a2", name: "Off", is_active: false }),
      automation({ id: "a3", name: "Broken", last_error: "unknown property_key 'foo'" }),
    ];
    render(
      <AutomationManager
        open
        onClose={vi.fn()}
        automations={automations}
        properties={[]}
        dataSourceId="ds-1"
        {...NOOP}
      />
    );

    expect(screen.getByText("Plain")).toBeInTheDocument();
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();
    expect(screen.getByText("Broken")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(
      <AutomationManager open={false} onClose={vi.fn()} automations={[automation({})]} properties={[]} dataSourceId="ds-1" {...NOOP} />
    );
    expect(screen.queryByRole("dialog", { name: "Automations" })).not.toBeInTheDocument();
  });

  it("'New automation' creates immediately and opens the editor on the created id", async () => {
    const user = userEvent.setup();
    const created = automation({ id: "new-id", name: "Untitled automation" });
    const onCreateAutomation = vi.fn().mockResolvedValue(created);

    const { rerender } = render(
      <AutomationManager
        open
        onClose={vi.fn()}
        automations={[]}
        properties={[]}
        dataSourceId="ds-1"
        onCreateAutomation={onCreateAutomation}
        onUpdateAutomation={vi.fn()}
        onDeleteAutomation={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "+ New automation" }));

    expect(onCreateAutomation).toHaveBeenCalledWith("Untitled automation");

    rerender(
      <AutomationManager
        open
        onClose={vi.fn()}
        automations={[created]}
        properties={[]}
        dataSourceId="ds-1"
        onCreateAutomation={onCreateAutomation}
        onUpdateAutomation={vi.fn()}
        onDeleteAutomation={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByTestId("automation-editor")).toBeInTheDocument());
    expect(screen.getByTestId("automation-editor")).toHaveTextContent("Untitled automation");
  });

  it("Delete goes through ConfirmDialog, not a native confirm — confirming calls onDeleteAutomation", async () => {
    const user = userEvent.setup();
    const onDeleteAutomation = vi.fn().mockResolvedValue(undefined);
    const a = automation({ id: "a1", name: "Weekly digest" });

    render(
      <AutomationManager
        open
        onClose={vi.fn()}
        automations={[a]}
        properties={[]}
        dataSourceId="ds-1"
        onCreateAutomation={vi.fn()}
        onUpdateAutomation={vi.fn()}
        onDeleteAutomation={onDeleteAutomation}
      />
    );

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDeleteAutomation).not.toHaveBeenCalled();
    const confirmDialog = screen.getByRole("dialog", { name: "Delete this automation?" });
    expect(within(confirmDialog).getByText(/weekly digest/i)).toBeInTheDocument();

    await user.click(within(confirmDialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onDeleteAutomation).toHaveBeenCalledWith("a1"));
  });

  it("Cancel on the delete confirmation does not call onDeleteAutomation", async () => {
    const user = userEvent.setup();
    const onDeleteAutomation = vi.fn();
    render(
      <AutomationManager
        open
        onClose={vi.fn()}
        automations={[automation({ id: "a1" })]}
        properties={[]}
        dataSourceId="ds-1"
        onCreateAutomation={vi.fn()}
        onUpdateAutomation={vi.fn()}
        onDeleteAutomation={onDeleteAutomation}
      />
    );

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onDeleteAutomation).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete this automation?")).not.toBeInTheDocument();
  });

  it("clicking Edit opens AutomationEditor for that automation", async () => {
    const user = userEvent.setup();
    render(
      <AutomationManager
        open
        onClose={vi.fn()}
        automations={[automation({ id: "a1", name: "Weekly digest" })]}
        properties={[]}
        dataSourceId="ds-1"
        {...NOOP}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("automation-editor")).toHaveTextContent("Weekly digest");
  });
});
