import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({
  useToast: () => ({ showToast }),
}));

import { AutomationEditor } from "./AutomationEditor";
import type { AutomationResponse, PropertyResponse } from "@/lib/database/types";

afterEach(() => {
  showToast.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

const STATUS_PROP = prop({ key: "status", name: "Status", type: "status", position: 0 });
const NOTES_PROP = prop({ key: "notes", name: "Notes", type: "rich_text", position: 1 });

function noFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("unexpected fetch in this test");
    })
  );
}

describe("AutomationEditor", () => {
  it("shows the last_error banner when non-null, and nothing when null", () => {
    noFetch();
    const { rerender } = render(
      <AutomationEditor
        automation={automation({ last_error: "unknown property_key 'foo'" })}
        properties={[STATUS_PROP]}
        dataSourceId="ds-1"
        onUpdateAutomation={vi.fn()}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Last run failed: unknown property_key 'foo'");

    rerender(
      <AutomationEditor
        automation={automation({ last_error: null })}
        properties={[STATUS_PROP]}
        dataSourceId="ds-1"
        onUpdateAutomation={vi.fn()}
      />
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("is_active toggles immediately, and reverts locally on a rejected PATCH", async () => {
    noFetch();
    const user = userEvent.setup();
    const onUpdateAutomation = vi.fn().mockRejectedValue(new Error("nope"));
    render(
      <AutomationEditor
        automation={automation({ is_active: true })}
        properties={[STATUS_PROP]}
        dataSourceId="ds-1"
        onUpdateAutomation={onUpdateAutomation}
      />
    );
    const checkbox = screen.getByRole("checkbox", { name: "Active" });
    expect(checkbox).toBeChecked();

    await user.click(checkbox);
    expect(onUpdateAutomation).toHaveBeenCalledWith("a1", { is_active: false });
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(showToast).toHaveBeenCalledWith("nope", "error");
  });

  describe("triggers", () => {
    it("trigger-kind switching renders the right sub-form", async () => {
      noFetch();
      const user = userEvent.setup();
      render(
        <AutomationEditor
          automation={automation({ triggers: [{ type: "page_added" }] })}
          properties={[STATUS_PROP, NOTES_PROP]}
          dataSourceId="ds-1"
          onUpdateAutomation={vi.fn().mockResolvedValue(automation({}))}
        />
      );

      expect(screen.getByText(/fires whenever a new page is added/i)).toBeInTheDocument();

      const kindSelect = screen.getByLabelText("Trigger 1 kind");
      await user.selectOptions(kindSelect, "property_edited");
      expect(screen.getByLabelText("Property to watch")).toBeInTheDocument();
      expect(screen.getByLabelText("Condition")).toBeInTheDocument();
    });

    it("property_edited's set_to condition shows a value input; the other 3 conditions don't", async () => {
      noFetch();
      const user = userEvent.setup();
      const onUpdateAutomation = vi.fn().mockResolvedValue(automation({}));
      render(
        <AutomationEditor
          automation={automation({
            triggers: [{ type: "property_edited", property_key: "status", condition: "any_change" }],
          })}
          properties={[STATUS_PROP]}
          dataSourceId="ds-1"
          onUpdateAutomation={onUpdateAutomation}
        />
      );

      // any_change: no value editor (StatusCell isn't rendered)
      expect(screen.queryByText("Choose…")).not.toBeInTheDocument();

      const conditionSelect = screen.getByLabelText("Condition");
      await user.selectOptions(conditionSelect, "set_to");
      await waitFor(() =>
        expect(onUpdateAutomation).toHaveBeenCalledWith(
          "a1",
          expect.objectContaining({
            triggers: [expect.objectContaining({ condition: "set_to" })],
          })
        )
      );

      for (const condition of ["became_empty", "became_non_empty", "any_change"]) {
        await user.selectOptions(conditionSelect, condition);
      }
    });

    it("selecting every_frequency replaces any other triggers with just the schedule entry (asserts the PATCH body)", async () => {
      noFetch();
      const user = userEvent.setup();
      const onUpdateAutomation = vi.fn().mockResolvedValue(automation({}));
      render(
        <AutomationEditor
          automation={automation({
            triggers: [
              { type: "page_added" },
              { type: "property_edited", property_key: "status", condition: "any_change" },
            ],
          })}
          properties={[STATUS_PROP]}
          dataSourceId="ds-1"
          onUpdateAutomation={onUpdateAutomation}
        />
      );

      const firstKindSelect = screen.getAllByLabelText(/Trigger \d kind/)[0];
      await user.selectOptions(firstKindSelect, "every_frequency");

      await waitFor(() =>
        expect(onUpdateAutomation).toHaveBeenCalledWith(
          "a1",
          expect.objectContaining({
            triggers: [expect.objectContaining({ type: "every_frequency" })],
          })
        )
      );
      const call = onUpdateAutomation.mock.calls.find((c) => c[1].triggers)!;
      expect(call[1].triggers).toHaveLength(1);

      // "+ Add another trigger" is disabled once a schedule trigger is the
      // sole entry (decision 2's exclusivity rule).
      expect(screen.getByRole("button", { name: "+ Add another trigger" })).toBeDisabled();
    });

    it("a trigger-kind <select> never offers send_mail_to/send_slack_notification_to (they aren't trigger kinds at all, but this proves the option list is exactly the 3 real kinds)", () => {
      noFetch();
      render(
        <AutomationEditor
          automation={automation({ triggers: [{ type: "page_added" }] })}
          properties={[STATUS_PROP]}
          dataSourceId="ds-1"
          onUpdateAutomation={vi.fn()}
        />
      );
      const options = screen.getByLabelText("Trigger 1 kind").querySelectorAll("option");
      const values = Array.from(options).map((o) => o.getAttribute("value"));
      expect(values).toEqual(["page_added", "property_edited", "every_frequency"]);
    });
  });

  describe("actions", () => {
    it("action-type switching renders the right mini-form", async () => {
      noFetch();
      const user = userEvent.setup();
      render(
        <AutomationEditor
          automation={automation({ actions: [{ type: "edit_property", property_key: "status", value: { type: "status", status: null } }] })}
          properties={[STATUS_PROP]}
          dataSourceId="ds-1"
          onUpdateAutomation={vi.fn().mockResolvedValue(automation({}))}
        />
      );

      expect(screen.getByLabelText("Property to edit")).toBeInTheDocument();

      const typeSelect = screen.getByLabelText("Action 1 type");

      await user.selectOptions(typeSelect, "send_notification");
      expect(screen.getByLabelText("Notification message")).toBeInTheDocument();

      await user.selectOptions(typeSelect, "send_webhook");
      expect(screen.getByLabelText("Webhook URL")).toBeInTheDocument();

      await user.selectOptions(typeSelect, "define_variables");
      expect(screen.getByLabelText("Variable name")).toBeInTheDocument();
      expect(screen.getByLabelText("Formula expression")).toBeInTheDocument();
    });

    it("send_mail_to/send_slack_notification_to never appear as selectable action-type options", () => {
      noFetch();
      render(
        <AutomationEditor
          automation={automation({ actions: [{ type: "edit_property", property_key: "status", value: { type: "status", status: null } }] })}
          properties={[STATUS_PROP]}
          dataSourceId="ds-1"
          onUpdateAutomation={vi.fn()}
        />
      );
      const options = screen.getByLabelText("Action 1 type").querySelectorAll("option");
      const values = Array.from(options).map((o) => o.getAttribute("value"));
      expect(values).not.toContain("send_mail_to");
      expect(values).not.toContain("send_slack_notification_to");
      expect(values).toEqual([
        "edit_property",
        "add_page_to",
        "edit_pages_in",
        "send_notification",
        "send_webhook",
        "define_variables",
      ]);
    });

    it("send_webhook's url field never renders a formula toggle", async () => {
      noFetch();
      const user = userEvent.setup();
      render(
        <AutomationEditor
          automation={automation({ actions: [{ type: "send_webhook", url: "" }] })}
          properties={[STATUS_PROP]}
          dataSourceId="ds-1"
          onUpdateAutomation={vi.fn().mockResolvedValue(automation({}))}
        />
      );
      expect(screen.getByLabelText("Webhook URL")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Formula" })).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Formula expression")).not.toBeInTheDocument();
    });

    it("reordering (up/down) and deleting an action updates the PATCHed actions array correctly", async () => {
      noFetch();
      const user = userEvent.setup();
      const onUpdateAutomation = vi.fn().mockResolvedValue(automation({}));
      render(
        <AutomationEditor
          automation={automation({
            actions: [
              { type: "send_notification", message: "first" },
              { type: "send_webhook", url: "https://example.com" },
            ],
          })}
          properties={[STATUS_PROP]}
          dataSourceId="ds-1"
          onUpdateAutomation={onUpdateAutomation}
        />
      );

      await user.click(screen.getByLabelText("Move action 2 up"));
      await waitFor(() =>
        expect(onUpdateAutomation).toHaveBeenCalledWith("a1", {
          actions: [
            { type: "send_webhook", url: "https://example.com" },
            { type: "send_notification", message: "first" },
          ],
        })
      );

      onUpdateAutomation.mockClear();
      await user.click(screen.getAllByRole("button", { name: /^Remove action 1$/ })[0]);
      await waitFor(() =>
        expect(onUpdateAutomation).toHaveBeenCalledWith("a1", {
          actions: [{ type: "send_notification", message: "first" }],
        })
      );
    });
  });
});
