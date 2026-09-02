import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FormulaEditor } from "./FormulaEditor";
import type { FormulaValidateResponse } from "@/lib/database/types";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const VALID: FormulaValidateResponse = {
  valid: true,
  errors: [],
  result_type: "number",
  referenced_properties: ["priceKey"],
  is_volatile: false,
};

const SYNTAX_ERROR: FormulaValidateResponse = {
  valid: false,
  errors: [{ message: "unexpected token 'EOF'", pos: 4, line: 1, col: 5 }],
  result_type: null,
  referenced_properties: [],
  is_volatile: false,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FormulaEditor", () => {
  it("renders a textarea seeded with the current expression", () => {
    render(
      <FormulaEditor dataSourceId="ds-1" expression='prop("Price")' onExpressionChange={vi.fn()} />
    );
    expect(screen.getByRole("textbox", { name: /formula expression/i })).toHaveValue(
      'prop("Price")'
    );
  });

  it("calls onExpressionChange on every keystroke (the textarea itself is a controlled input)", async () => {
    const user = userEvent.setup();
    const onExpressionChange = vi.fn();
    render(
      <FormulaEditor
        dataSourceId="ds-1"
        expression=""
        onExpressionChange={onExpressionChange}
        debounceMs={5}
      />
    );
    await user.type(screen.getByRole("textbox", { name: /formula expression/i }), "1");
    expect(onExpressionChange).toHaveBeenCalledWith("1");
  });

  it("debounces: does not call the validate endpoint before debounceMs elapses, then calls it exactly once", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(VALID)));
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <FormulaEditor
        dataSourceId="ds-1"
        expression=""
        onExpressionChange={vi.fn()}
        debounceMs={50}
      />
    );
    // Simulate rapid retyping — each rerender restarts the debounce timer,
    // matching a real controlled-input keystroke burst.
    rerender(
      <FormulaEditor dataSourceId="ds-1" expression="1" onExpressionChange={vi.fn()} debounceMs={50} />
    );
    rerender(
      <FormulaEditor
        dataSourceId="ds-1"
        expression="1 +"
        onExpressionChange={vi.fn()}
        debounceMs={50}
      />
    );
    rerender(
      <FormulaEditor
        dataSourceId="ds-1"
        expression="1 + 1"
        onExpressionChange={vi.fn()}
        debounceMs={50}
      />
    );

    // Nothing yet — the debounce window for the last rerender hasn't elapsed.
    expect(fetchMock).not.toHaveBeenCalled();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/db/data-sources/ds-1/formulas/validate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expression: "1 + 1" }),
      })
    );
  });

  it('shows "Valid — <type>" and calls onValidated for a valid formula', async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(VALID))));
    const onValidated = vi.fn();
    render(
      <FormulaEditor
        dataSourceId="ds-1"
        expression='prop("Price") * 2'
        onExpressionChange={vi.fn()}
        onValidated={onValidated}
        debounceMs={5}
      />
    );
    await waitFor(() => expect(screen.getByText(/Valid/)).toBeInTheDocument());
    expect(screen.getByText(/number/)).toBeInTheDocument();
    expect(onValidated).toHaveBeenCalledWith(VALID);
  });

  it("renders the error list with line/col positions for an invalid (200) response", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(SYNTAX_ERROR))));
    render(
      <FormulaEditor dataSourceId="ds-1" expression="1 + " onExpressionChange={vi.fn()} debounceMs={5} />
    );
    await waitFor(() =>
      expect(screen.getByText(/Line 1, col 5: unexpected token/)).toBeInTheDocument()
    );
    expect(screen.getByText("1 error")).toBeInTheDocument();
  });

  it("issues no request at all for an empty (or whitespace-only) expression", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(VALID)));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <FormulaEditor dataSourceId="ds-1" expression="   " onExpressionChange={vi.fn()} debounceMs={5} />
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
