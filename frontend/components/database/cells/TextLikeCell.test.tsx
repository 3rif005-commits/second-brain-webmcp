// M2b — URL / Email / Phone.
//
// One component serves all three because they share rich_text's wire shape.
// These tests exist to pin the reason they are NOT just TextCell: the read
// state differs per type, and that difference is the whole point of having
// the types at all.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TextLikeCell } from "./TextLikeCell";
import type { EmailValue, PhoneValue, UrlValue } from "@/lib/database/types";

describe("read state", () => {
  it("renders a URL as a link and adds a scheme when the value has none", () => {
    render(
      <TextLikeCell
        kind="url"
        value={{ type: "url", url: "example.com" } as UrlValue}
        editable={false}
        onChange={vi.fn()}
      />
    );
    // Without the scheme the browser would treat it as a relative path.
    expect(screen.getByRole("link", { name: "example.com" })).toHaveAttribute(
      "href",
      "https://example.com"
    );
  });

  it("leaves an existing scheme alone", () => {
    render(
      <TextLikeCell
        kind="url"
        value={{ type: "url", url: "http://a.test" } as UrlValue}
        editable={false}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "http://a.test");
  });

  it("renders an email as mailto: and a phone as tel:", () => {
    const { rerender } = render(
      <TextLikeCell
        kind="email"
        value={{ type: "email", email: "a@b.test" } as EmailValue}
        editable={false}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "mailto:a@b.test");

    rerender(
      <TextLikeCell
        kind="phone_number"
        value={{ type: "phone_number", phone_number: "+123" } as PhoneValue}
        editable={false}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "tel:+123");
  });

  it("shows an em dash when empty, and no link", () => {
    render(<TextLikeCell kind="url" value={undefined} editable={false} onChange={vi.fn()} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("offers no edit affordance when the source is read-only", () => {
    render(
      <TextLikeCell
        kind="url"
        value={{ type: "url", url: "a.test" } as UrlValue}
        editable={false}
        onChange={vi.fn()}
      />
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("editing", () => {
  it("commits a trimmed value under the key matching its type", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TextLikeCell kind="email" value={undefined} editable onChange={onChange} />
    );

    await user.click(screen.getByRole("button", { name: "Edit Email" }));
    await user.type(screen.getByLabelText("Email"), "  a@b.test  ");
    await user.tab();

    // The key must be `email`, not `rich_text` — the wire shape is shared but
    // the discriminator is not.
    expect(onChange).toHaveBeenCalledWith({ type: "email", email: "a@b.test" });
  });

  it("Escape abandons the edit without writing", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TextLikeCell
        kind="url"
        value={{ type: "url", url: "keep.test" } as UrlValue}
        editable
        onChange={onChange}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit URL" }));
    await user.type(screen.getByLabelText("URL"), "junk");
    await user.keyboard("{Escape}");

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://keep.test");
  });

  it("uses an input type the browser can validate and keyboards can help with", async () => {
    const user = userEvent.setup();
    render(<TextLikeCell kind="phone_number" value={undefined} editable onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Edit Phone" }));
    expect(screen.getByLabelText("Phone")).toHaveAttribute("type", "tel");
  });
});
