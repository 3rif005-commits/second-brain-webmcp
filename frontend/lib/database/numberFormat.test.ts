import { describe, expect, it } from "vitest";
import {
  BAR_COLOR_KEYS,
  BAR_COLOR_VALUE_KEYS,
  NUMBER_FORMATS,
  barColorValue,
  barFraction,
  formatNumber,
  numberFormatLabel,
} from "./numberFormat";

// Every assertion below pins a locale-INDEPENDENT property (a substring, a
// digit count, a ratio) rather than a whole formatted string. `formatNumber`
// deliberately passes no locale to `Intl`, so asserting "1,234.50" would pass
// on CI and fail on a machine whose locale writes "1.234,50" — a false failure
// about the test, not about the code.

describe("NUMBER_FORMATS", () => {
  it("carries exactly the backend NumberFormat enum's 39 values", () => {
    expect(NUMBER_FORMATS).toHaveLength(39);
  });

  it("starts with Notion's own first three, in Notion's order", () => {
    expect(NUMBER_FORMATS.slice(0, 3).map(([, label]) => label)).toEqual([
      "Number",
      "Number with separators",
      "Percent",
    ]);
  });

  it("has no duplicate values", () => {
    const values = NUMBER_FORMATS.map(([v]) => v);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("numberFormatLabel", () => {
  it("names a known format", () => {
    expect(numberFormatLabel("dollar")).toBe("US Dollar (USD)");
  });

  it("falls back to Number for undefined and for an unknown value", () => {
    expect(numberFormatLabel(undefined)).toBe("Number");
    expect(numberFormatLabel("dogecoin")).toBe("Number");
  });
});

describe("formatNumber", () => {
  it("renders nothing for an absent value", () => {
    expect(formatNumber(null, undefined)).toBe("");
    expect(formatNumber(undefined, undefined)).toBe("");
    expect(formatNumber(NaN, undefined)).toBe("");
  });

  it("leaves a plain number ungrouped — the whole difference from Number with separators", () => {
    expect(formatNumber(1234567, { format: "number" })).toBe("1234567");
    expect(formatNumber(1234567, { format: "number_with_commas" })).not.toBe("1234567");
  });

  it("treats Percent as a suffix, not as a x100 multiplier", () => {
    // Notion shows the STORED number with a % sign: 42 is "42%", not "4200%".
    expect(formatNumber(42, { format: "percent" })).toBe("42%");
  });

  it("pads to decimal_places as both a minimum and a maximum", () => {
    expect(formatNumber(1, { format: "number", decimal_places: 2 })).toBe("1.00");
    expect(formatNumber(1.239, { format: "number", decimal_places: 2 })).toBe("1.24");
  });

  it("leaves fraction digits alone when decimal_places is Default", () => {
    expect(formatNumber(1, { format: "number" })).toBe("1");
    expect(formatNumber(1.5, { format: "number", decimal_places: null })).toBe("1.5");
  });

  it("renders a currency with its symbol or code", () => {
    expect(formatNumber(5, { format: "dollar" })).toContain("5");
    expect(formatNumber(5, { format: "dollar" })).toMatch(/\$|USD/);
  });

  it("renders 0 rather than treating it as empty", () => {
    expect(formatNumber(0, { format: "number" })).toBe("0");
  });

  it("renders a negative number", () => {
    const out = formatNumber(-3, { format: "number" });
    expect(out).toContain("3");
    expect(out).toMatch(/-|−/);
  });
});

describe("barFraction", () => {
  it("is null when Show as is Number, or unset", () => {
    expect(barFraction(5, { show_as: "number", divide_by: 10 })).toBeNull();
    expect(barFraction(5, { divide_by: 10 })).toBeNull();
    expect(barFraction(5, undefined)).toBeNull();
  });

  it("is null when no divisor is configured, rather than dividing by zero", () => {
    expect(barFraction(5, { show_as: "bar" })).toBeNull();
    expect(barFraction(5, { show_as: "bar", divide_by: 0 })).toBeNull();
    expect(barFraction(5, { show_as: "bar", divide_by: null })).toBeNull();
  });

  it("is the ratio, clamped to 0..1 at both ends", () => {
    expect(barFraction(5, { show_as: "bar", divide_by: 10 })).toBe(0.5);
    expect(barFraction(20, { show_as: "bar", divide_by: 10 })).toBe(1);
    expect(barFraction(-5, { show_as: "ring", divide_by: 10 })).toBe(0);
  });

  it("is null for an empty value", () => {
    expect(barFraction(null, { show_as: "bar", divide_by: 10 })).toBeNull();
  });
});

describe("bar color palette", () => {
  it("defines a class and a literal value for exactly the same colors", () => {
    // A ring needs a literal color inside its conic-gradient and a bar needs a
    // Tailwind class. If the two maps drift, one of the two silently renders
    // gray for whichever color only one map knows.
    expect([...BAR_COLOR_VALUE_KEYS].sort()).toEqual([...BAR_COLOR_KEYS].sort());
  });

  it("falls back to gray for an unknown color, and to green for none", () => {
    expect(barColorValue("chartreuse")).toBe(barColorValue("gray"));
    expect(barColorValue(undefined)).toBe(barColorValue("green"));
  });
});
