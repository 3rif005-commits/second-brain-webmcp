import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({
  useToast: () => ({ showToast }),
}));

// Real BlockEditor mounts BlockNote (heavy, and not what this file tests —
// the page-body wiring is just `onSave` -> `updateTemplate(id, {content})`,
// per task-40-brief.md's reference facts, not re-tested block-by-block
// here). Stubbed so TemplateEditor's own logic (property cells, is_default,
// repeat schedule) can be tested without paying for a real editor mount.
vi.mock("@/components/editor/BlockEditor", () => ({
  BlockEditor: () => <div data-testid="block-editor-stub" />,
}));

import { TemplateEditor } from "./TemplateEditor";
import type { PropertyResponse, RowTemplateResponse } from "@/lib/database/types";

afterEach(() => {
  showToast.mockClear();
});

function prop(overrides: Partial<PropertyResponse>): PropertyResponse {
  return {
    id: overrides.key ?? "id",
    data_source_id: "ds-1",
    user_id: "user-1",
    key: "key",
    name: "Name",
    type: "rich_text",
    config: {},
    description: null,
    storage: "jsonb",
    column_name: null,
    result_type: null,
    is_volatile: false,
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function template(overrides: Partial<RowTemplateResponse>): RowTemplateResponse {
  return {
    id: "t1",
    data_source_id: "ds-1",
    user_id: "user-1",
    name: "Weekly review",
    icon: "📝",
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

const DONE_PROP = prop({ key: "done", name: "Done", type: "checkbox", position: 0 });
const NOTES_PROP = prop({ key: "notes", name: "Notes", type: "rich_text", position: 1 });
const RELATION_PROP = prop({ key: "related", name: "Related", type: "relation", position: 2 });
const FORMULA_PROP = prop({ key: "calc", name: "Calc", type: "formula", position: 3 });

describe("TemplateEditor", () => {
  it("only offers the known, writable property types — relation/formula (and any other non-KNOWN_PROPERTY_TYPES type) are skipped entirely", () => {
    render(
      <TemplateEditor
        template={template({})}
        properties={[DONE_PROP, NOTES_PROP, RELATION_PROP, FORMULA_PROP]}
        onUpdateTemplate={vi.fn()}
      />
    );

    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.queryByText("Related")).not.toBeInTheDocument();
    expect(screen.queryByText("Calc")).not.toBeInTheDocument();
  });

  it("a property cell change updates the local draft and calls updateTemplate with the whole properties draft, debounced", async () => {
    const user = userEvent.setup();
    const onUpdateTemplate = vi.fn().mockResolvedValue(template({}));

    render(
      <TemplateEditor
        template={template({ properties: {} })}
        properties={[DONE_PROP]}
        onUpdateTemplate={onUpdateTemplate}
      />
    );

    await user.click(screen.getByLabelText("Checkbox"));

    // Debounced (600ms, matching NoteEditorPage.tsx's title-save precedent)
    // — not called synchronously.
    expect(onUpdateTemplate).not.toHaveBeenCalled();

    await waitFor(
      () =>
        expect(onUpdateTemplate).toHaveBeenCalledWith("t1", {
          properties: { done: { type: "checkbox", checkbox: true } },
        }),
      { timeout: 2000 }
    );
  });

  it("setting is_default calls updateTemplate immediately, and reverts the checkbox on a rejected 400", async () => {
    const user = userEvent.setup();
    // A manually-controlled (never auto-settling) promise so the optimistic
    // `true` is deterministically observable before the revert, regardless
    // of real-clock timing under a loaded test run — a plain
    // `mockRejectedValue` (or even a short real setTimeout) can let the
    // whole apply-then-catch-then-revert chain settle before
    // `await user.click()` returns, making the intermediate state
    // unobservable/flaky.
    let rejectUpdate!: (e: Error) => void;
    const onUpdateTemplate = vi.fn(
      () =>
        new Promise<RowTemplateResponse>((_resolve, reject) => {
          rejectUpdate = reject;
        })
    );

    render(
      <TemplateEditor
        template={template({ is_default: false })}
        properties={[]}
        onUpdateTemplate={onUpdateTemplate}
      />
    );

    const checkbox = screen.getByLabelText("Default template for new rows") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    await user.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(true)); // optimistic

    rejectUpdate(new Error("another default already exists"));
    await waitFor(() => expect(checkbox.checked).toBe(false)); // reverted
    expect(onUpdateTemplate).toHaveBeenCalledWith("t1", { is_default: true });
    expect(showToast).toHaveBeenCalledWith("another default already exists", "error");
  });

  it("setting is_default stays checked on success", async () => {
    const user = userEvent.setup();
    const onUpdateTemplate = vi.fn().mockResolvedValue(template({ is_default: true }));

    render(
      <TemplateEditor
        template={template({ is_default: false })}
        properties={[]}
        onUpdateTemplate={onUpdateTemplate}
      />
    );

    const checkbox = screen.getByLabelText("Default template for new rows") as HTMLInputElement;
    await user.click(checkbox);

    await waitFor(() => expect(onUpdateTemplate).toHaveBeenCalledWith("t1", { is_default: true }));
    expect(checkbox.checked).toBe(true);
  });

  it("repeat toggle off: PATCHes repeat_config: null immediately", async () => {
    const user = userEvent.setup();
    const onUpdateTemplate = vi.fn().mockResolvedValue(
      template({
        repeat_config: null,
        next_run_at: null,
      })
    );

    render(
      <TemplateEditor
        template={template({
          repeat_config: { frequency: "daily", interval: 1, start_date: "2026-01-01", time_of_day: "09:00" },
          next_run_at: "2026-01-02T09:00:00Z",
        })}
        properties={[]}
        onUpdateTemplate={onUpdateTemplate}
      />
    );

    const repeatToggle = screen.getByRole("checkbox", { name: "Repeat" });
    expect((repeatToggle as HTMLInputElement).checked).toBe(true);

    await user.click(repeatToggle);

    await waitFor(() => expect(onUpdateTemplate).toHaveBeenCalledWith("t1", { repeat_config: null }));
  });

  it("repeat toggle on: seeds a default weekly-less draft and only sends repeat_config once 'Save schedule' is clicked", async () => {
    const user = userEvent.setup();
    const onUpdateTemplate = vi.fn().mockResolvedValue(template({ next_run_at: "2026-01-02T09:00:00Z" }));

    render(
      <TemplateEditor template={template({ repeat_config: null })} properties={[]} onUpdateTemplate={onUpdateTemplate} />
    );

    const repeatToggle = screen.getByRole("checkbox", { name: "Repeat" });
    await user.click(repeatToggle);

    // Turning it on alone must not PATCH anything yet (decision 4: whole
    // object together, not per field/keystroke).
    expect(onUpdateTemplate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save schedule" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() =>
      expect(onUpdateTemplate).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          repeat_config: expect.objectContaining({ frequency: "daily", interval: 1, timezone: "UTC" }),
        })
      )
    );
  });

  it("weekday checkboxes only render when frequency is 'weekly'", async () => {
    const user = userEvent.setup();
    render(
      <TemplateEditor
        template={template({
          repeat_config: { frequency: "daily", interval: 1, start_date: "2026-01-01", time_of_day: "09:00" },
        })}
        properties={[]}
        onUpdateTemplate={vi.fn()}
      />
    );

    expect(screen.queryByRole("group", { name: "Repeat on weekdays" })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Repeat frequency"), "weekly");

    expect(screen.getByRole("group", { name: "Repeat on weekdays" })).toBeInTheDocument();
    expect(screen.getByText("Mon")).toBeInTheDocument();
    expect(screen.getByText("Sun")).toBeInTheDocument();
  });

  it("shows the server-computed next_run_at once a schedule is saved", async () => {
    const user = userEvent.setup();
    const onUpdateTemplate = vi.fn().mockResolvedValue(template({ next_run_at: "2026-01-15T09:00:00.000Z" }));

    render(
      <TemplateEditor
        template={template({
          repeat_config: { frequency: "daily", interval: 1, start_date: "2026-01-01", time_of_day: "09:00" },
          next_run_at: null,
        })}
        properties={[]}
        onUpdateTemplate={onUpdateTemplate}
      />
    );

    await user.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() => expect(screen.getByText(/^Next:/)).toBeInTheDocument());
  });
});
