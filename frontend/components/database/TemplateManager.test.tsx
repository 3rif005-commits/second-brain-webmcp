import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({
  useToast: () => ({ showToast }),
}));

// TemplateEditor mounts a real BlockEditor (BlockNote), which is unrelated
// to what this file tests (the list/create/delete surface, not the editor
// itself — TemplateEditor.test.tsx owns that) and is far too heavy to
// exercise here. Stubbed to a bare marker so "Edit" -> TemplateEditor
// mounting can still be asserted without paying for a real editor.
vi.mock("./TemplateEditor", () => ({
  TemplateEditor: ({ template }: { template: { name: string } }) => (
    <div data-testid="template-editor">{template.name}</div>
  ),
}));

import { TemplateManager } from "./TemplateManager";
import type { RowTemplateResponse } from "@/lib/database/types";

afterEach(() => {
  showToast.mockClear();
});

function template(overrides: Partial<RowTemplateResponse>): RowTemplateResponse {
  return {
    id: "t1",
    data_source_id: "ds-1",
    user_id: "user-1",
    name: "Weekly review",
    icon: null,
    properties: {},
    content: [],
    is_default: false,
    repeat_config: null,
    next_run_at: null,
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("TemplateManager", () => {
  it("lists templates with a Default badge and a repeat indicator", () => {
    const templates = [
      template({ id: "t1", name: "Plain", is_default: true }),
      template({
        id: "t2",
        name: "Standup",
        repeat_config: { frequency: "daily", interval: 1, start_date: "2026-01-01", time_of_day: "09:00" },
      }),
    ];
    render(
      <TemplateManager
        open
        onClose={vi.fn()}
        templates={templates}
        properties={[]}
        onCreateTemplate={vi.fn()}
        onUpdateTemplate={vi.fn()}
        onDeleteTemplate={vi.fn()}
      />
    );

    expect(screen.getByText("Plain")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByText("Standup")).toBeInTheDocument();
    expect(screen.getByText("Every day at 09:00")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(
      <TemplateManager
        open={false}
        onClose={vi.fn()}
        templates={[template({})]}
        properties={[]}
        onCreateTemplate={vi.fn()}
        onUpdateTemplate={vi.fn()}
        onDeleteTemplate={vi.fn()}
      />
    );
    expect(screen.queryByRole("dialog", { name: "Templates" })).not.toBeInTheDocument();
  });

  it("'New template' creates immediately (POSTs just a name) and opens the editor on the created id", async () => {
    const user = userEvent.setup();
    const created = template({ id: "new-id", name: "Untitled template" });
    const onCreateTemplate = vi.fn().mockResolvedValue(created);

    const { rerender } = render(
      <TemplateManager
        open
        onClose={vi.fn()}
        templates={[]}
        properties={[]}
        onCreateTemplate={onCreateTemplate}
        onUpdateTemplate={vi.fn()}
        onDeleteTemplate={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "+ New template" }));

    expect(onCreateTemplate).toHaveBeenCalledWith("Untitled template");
    // The real hook (useDatabaseView) would append `created` to `templates`
    // and re-render this component with the new template included — mirror
    // that here so the editor has something to find by id.
    rerender(
      <TemplateManager
        open
        onClose={vi.fn()}
        templates={[created]}
        properties={[]}
        onCreateTemplate={onCreateTemplate}
        onUpdateTemplate={vi.fn()}
        onDeleteTemplate={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByTestId("template-editor")).toBeInTheDocument());
    expect(screen.getByTestId("template-editor")).toHaveTextContent("Untitled template");
  });

  it("Delete goes through ConfirmDialog, not a native confirm — confirming calls onDeleteTemplate", async () => {
    const user = userEvent.setup();
    const onDeleteTemplate = vi.fn().mockResolvedValue(undefined);
    const t = template({ id: "t1", name: "Weekly review" });

    render(
      <TemplateManager
        open
        onClose={vi.fn()}
        templates={[t]}
        properties={[]}
        onCreateTemplate={vi.fn()}
        onUpdateTemplate={vi.fn()}
        onDeleteTemplate={onDeleteTemplate}
      />
    );

    await user.click(screen.getByRole("button", { name: "Delete" }));
    // ConfirmDialog, not window.confirm — a real dialog with its own Confirm
    // button must appear before anything is deleted.
    expect(onDeleteTemplate).not.toHaveBeenCalled();
    const confirmDialog = screen.getByRole("dialog", { name: "Delete this template?" });
    expect(within(confirmDialog).getByText(/weekly review/i)).toBeInTheDocument();

    await user.click(within(confirmDialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onDeleteTemplate).toHaveBeenCalledWith("t1"));
  });

  it("Cancel on the delete confirmation does not call onDeleteTemplate", async () => {
    const user = userEvent.setup();
    const onDeleteTemplate = vi.fn();
    render(
      <TemplateManager
        open
        onClose={vi.fn()}
        templates={[template({ id: "t1" })]}
        properties={[]}
        onCreateTemplate={vi.fn()}
        onUpdateTemplate={vi.fn()}
        onDeleteTemplate={onDeleteTemplate}
      />
    );

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onDeleteTemplate).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete this template?")).not.toBeInTheDocument();
  });

  it("clicking Edit opens TemplateEditor for that template", async () => {
    const user = userEvent.setup();
    render(
      <TemplateManager
        open
        onClose={vi.fn()}
        templates={[template({ id: "t1", name: "Weekly review" })]}
        properties={[]}
        onCreateTemplate={vi.fn()}
        onUpdateTemplate={vi.fn()}
        onDeleteTemplate={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("template-editor")).toHaveTextContent("Weekly review");
  });
});
