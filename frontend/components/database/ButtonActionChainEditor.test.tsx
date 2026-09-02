// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/providers", () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

import { ButtonActionChainEditor } from "./ButtonActionChainEditor";
import { BUTTON_ACTION_TYPES, BUTTON_BLOCK_ACTION_TYPES } from "@/lib/database/types";
import type { ButtonBlockAction } from "@/lib/database/types";

const oneAction: ButtonBlockAction[] = [{ type: "send_webhook", url: "" }];

describe("ButtonActionChainEditor action-type gating (decision 2/3's allowed set)", () => {
  it("offers exactly the 8 BUTTON_ACTION_TYPES (no insert_blocks) for a button property", () => {
    render(
      <ButtonActionChainEditor
        actions={oneAction}
        allowed={BUTTON_ACTION_TYPES}
        properties={[]}
        dataSourceId="ds-1"
        onChange={() => {}}
      />
    );
    const select = screen.getByLabelText(/action 1 type/i) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value).sort();
    expect(values).toEqual([...BUTTON_ACTION_TYPES].sort());
    expect(values).not.toContain("insert_blocks");
  });

  it("offers exactly the 9 BUTTON_BLOCK_ACTION_TYPES (includes insert_blocks) for a button block", () => {
    render(
      <ButtonActionChainEditor
        actions={oneAction}
        allowed={BUTTON_BLOCK_ACTION_TYPES}
        properties={[]}
        dataSourceId="ds-1"
        onChange={() => {}}
      />
    );
    const select = screen.getByLabelText(/action 1 type/i) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value).sort();
    expect(values).toEqual([...BUTTON_BLOCK_ACTION_TYPES].sort());
    expect(values).toContain("insert_blocks");
  });

  it("never offers send_mail_to or send_slack_notification_to in either mode", () => {
    expect(BUTTON_ACTION_TYPES).not.toContain("send_mail_to");
    expect(BUTTON_ACTION_TYPES).not.toContain("send_slack_notification_to");
    expect(BUTTON_BLOCK_ACTION_TYPES).not.toContain("send_mail_to");
    expect(BUTTON_BLOCK_ACTION_TYPES).not.toContain("send_slack_notification_to");
  });
});
