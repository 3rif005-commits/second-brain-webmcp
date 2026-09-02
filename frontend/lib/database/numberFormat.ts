// Number display formatting — the thing that makes the `Edit property` panel's
// `Number format` row a real control rather than a setting nothing reads.
//
// Everything here is DISPLAY-ONLY, exactly as the backend's `NumberConfig`
// says: the stored value is always a plain JS number, and none of this ever
// travels back through `onChange`.
//
// The format list and its order are the live capture
// (docs/ui-specs/raw-dom/20-edit-property-panel.md). Notion offers 45; the
// backend's `NumberFormat` literal carries 39. We render the intersection, in
// Notion's order, so the list a user scrolls is a prefix-faithful subset
// rather than a differently-ordered one. The six Notion has that we do not are
// Australian dollar (AUD), Peruvian sol (PEN), Vietnamese dong (VND), Pakistani
// rupee (PKR), Nigerian naira (NGN) and Bitcoin (BTC) — absent from the backend
// enum, not dropped here. Adding one means editing `NumberFormat` in
// backend/services/db/properties/scalar.py, then this list, then CURRENCY_CODES.

import type { CSSProperties } from "react";

export interface NumberConfig {
  format?: string;
  decimal_places?: number | null;
  show_as?: "number" | "bar" | "ring";
  bar_color?: string;
  divide_by?: number | null;
  show_number?: boolean;
}

/** `[backend enum value, the label Notion shows]`, in Notion's own order. */
export const NUMBER_FORMATS: readonly (readonly [string, string])[] = [
  ["number", "Number"],
  ["number_with_commas", "Number with separators"],
  ["percent", "Percent"],
  ["dollar", "US Dollar (USD)"],
  ["canadian_dollar", "Canadian dollar (CAD)"],
  ["singapore_dollar", "Singapore dollar (SGD)"],
  ["euro", "Euro (EUR)"],
  ["pound", "Pound (GBP)"],
  ["yen", "Yen (JPY)"],
  ["ruble", "Ruble (RUB)"],
  ["rupee", "Rupee (INR)"],
  ["won", "Won (KRW)"],
  ["yuan", "Yuan (CNY)"],
  ["real", "Real (BRL)"],
  ["lira", "Lira (TRY)"],
  ["rupiah", "Rupiah (IDR)"],
  ["franc", "Franc (CHF)"],
  ["hong_kong_dollar", "Hong Kong dollar (HKD)"],
  ["new_zealand_dollar", "New Zealand dollar (NZD)"],
  ["krona", "Swedish krona (SEK)"],
  ["norwegian_krone", "Norwegian krone (NOK)"],
  ["mexican_peso", "Mexican peso (MXN)"],
  ["rand", "Rand (ZAR)"],
  ["new_taiwan_dollar", "New Taiwan dollar (TWD)"],
  ["danish_krone", "Danish krone (DKK)"],
  ["zloty", "Złoty (PLN)"],
  ["baht", "Baht (THB)"],
  ["forint", "Forint (HUF)"],
  ["koruna", "Koruna (CZK)"],
  ["shekel", "Shekel (ILS)"],
  ["chilean_peso", "Chilean peso (CLP)"],
  ["philippine_peso", "Philippine peso (PHP)"],
  ["dirham", "Dirham (AED)"],
  ["colombian_peso", "Colombian peso (COP)"],
  ["riyal", "Riyal (SAR)"],
  ["ringgit", "Ringgit (MYR)"],
  ["leu", "Leu (RON)"],
  ["argentine_peso", "Argentine peso (ARS)"],
  ["uruguayan_peso", "Uruguayan peso (UYU)"],
];

const FORMAT_LABELS: Record<string, string> = Object.fromEntries(NUMBER_FORMATS);

export function numberFormatLabel(format: string | undefined): string {
  return FORMAT_LABELS[format ?? "number"] ?? FORMAT_LABELS.number;
}

/** ISO 4217 code per backend enum value. Absent = not a currency. */
const CURRENCY_CODES: Record<string, string> = {
  dollar: "USD",
  canadian_dollar: "CAD",
  singapore_dollar: "SGD",
  euro: "EUR",
  pound: "GBP",
  yen: "JPY",
  ruble: "RUB",
  rupee: "INR",
  won: "KRW",
  yuan: "CNY",
  real: "BRL",
  lira: "TRY",
  rupiah: "IDR",
  franc: "CHF",
  hong_kong_dollar: "HKD",
  new_zealand_dollar: "NZD",
  krona: "SEK",
  norwegian_krone: "NOK",
  mexican_peso: "MXN",
  rand: "ZAR",
  new_taiwan_dollar: "TWD",
  danish_krone: "DKK",
  zloty: "PLN",
  baht: "THB",
  forint: "HUF",
  koruna: "CZK",
  shekel: "ILS",
  chilean_peso: "CLP",
  philippine_peso: "PHP",
  dirham: "AED",
  colombian_peso: "COP",
  riyal: "SAR",
  ringgit: "MYR",
  leu: "RON",
  argentine_peso: "ARS",
  uruguayan_peso: "UYU",
};

/** Formats a stored number for display.
 *
 * `decimal_places` is deliberately BOTH the minimum and the maximum: Notion's
 * "2" means 1 renders as "1.00", not as "1". `Default` (null/undefined) leaves
 * both to `Intl`, which is what makes an unconfigured column show `1` and
 * `1.5` rather than padding every value.
 *
 * A locale is never passed, so the separators follow the viewer's own locale
 * — Notion does the same, and hardcoding "en-US" would print `1,234.5` to a
 * user whose every other number reads `1.234,5`. */
export function formatNumber(
  value: number | null | undefined,
  config: NumberConfig | undefined
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "";

  const format = config?.format ?? "number";
  const places = config?.decimal_places;
  const digits =
    places === null || places === undefined
      ? {}
      : { minimumFractionDigits: places, maximumFractionDigits: places };

  if (format === "percent") {
    // Notion's Percent shows the STORED number with a % sign — 42 renders as
    // "42%", not "4200%". So `style: "percent"` (which multiplies by 100) is
    // the wrong primitive here; format the bare number and append the sign.
    return `${new Intl.NumberFormat(undefined, { useGrouping: false, ...digits }).format(value)}%`;
  }

  const currency = CURRENCY_CODES[format];
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency, ...digits }).format(
        value
      );
    } catch {
      // An engine without a given currency's data throws rather than degrading.
      // Falling back to a grouped plain number beats rendering nothing.
      return new Intl.NumberFormat(undefined, digits).format(value);
    }
  }

  if (format === "number_with_commas") {
    return new Intl.NumberFormat(undefined, { useGrouping: true, ...digits }).format(value);
  }

  // "number" — plain, ungrouped. 1234567 stays 1234567, which is the whole
  // difference between it and "Number with separators".
  return new Intl.NumberFormat(undefined, { useGrouping: false, ...digits }).format(value);
}

/** Bar/ring fill as a 0..1 fraction, or null when `Show as` is plain Number or
 * no divisor is configured. Notion clamps: a value above the divisor renders a
 * full bar rather than overflowing it. */
export function barFraction(
  value: number | null | undefined,
  config: NumberConfig | undefined
): number | null {
  if (!config || config.show_as === "number" || !config.show_as) return null;
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const divisor = config.divide_by;
  if (!divisor) return null;
  return Math.min(1, Math.max(0, value / divisor));
}

/** The bar/ring palette. Notion offers a subset of the 10 option colors here;
 * anything unrecognised falls back to the same gray a `default` option uses,
 * never to nothing. */
export const BAR_COLORS: readonly (readonly [string, string])[] = [
  ["gray", "Gray"],
  ["brown", "Brown"],
  ["orange", "Orange"],
  ["yellow", "Yellow"],
  ["green", "Green"],
  ["blue", "Blue"],
  ["purple", "Purple"],
  ["pink", "Pink"],
  ["red", "Red"],
];

const BAR_COLOR_CLASSES: Record<string, string> = {
  gray: "bg-gray-400",
  brown: "bg-amber-700",
  orange: "bg-orange-400",
  yellow: "bg-yellow-400",
  green: "bg-green-500",
  blue: "bg-blue-500",
  purple: "bg-purple-500",
  pink: "bg-pink-500",
  red: "bg-red-500",
};

export function barColorClass(color: string | undefined): string {
  return BAR_COLOR_CLASSES[color ?? "green"] ?? BAR_COLOR_CLASSES.gray;
}

/** The same palette as literal color values.
 *
 * A ring is drawn with `conic-gradient`, which needs a real color inside the
 * gradient string — a Tailwind `bg-*` class cannot reach into it, and
 * `currentColor` would inherit the cell's TEXT color (gray), silently painting
 * every ring the same. Kept beside BAR_COLOR_CLASSES so the two can never
 * drift apart unnoticed; the unit test asserts they cover the same keys. */
const BAR_COLOR_VALUES: Record<string, string> = {
  gray: "#9ca3af",
  brown: "#b45309",
  orange: "#fb923c",
  yellow: "#facc15",
  green: "#22c55e",
  blue: "#3b82f6",
  purple: "#a855f7",
  pink: "#ec4899",
  red: "#ef4444",
};

export function barColorValue(color: string | undefined): string {
  return BAR_COLOR_VALUES[color ?? "green"] ?? BAR_COLOR_VALUES.gray;
}

/** The inline style for a ring.
 *
 * A `conic-gradient` alone paints a filled PIE, not a ring — the hole has to be
 * punched out, and a mask is the only way to do that without knowing the
 * background behind the cell (an inner circle painted in the panel colour looks
 * right in the popover and wrong in a table row). Shared by the cell and by the
 * `Show as` preview card so the two cannot drift apart.
 *
 * `WebkitMask` is listed alongside `mask` because Safari still needs it. */
export function ringStyle(fraction: number, color: string | undefined): CSSProperties {
  const hole = "calc(100% - 3px)";
  const mask = `radial-gradient(farthest-side, transparent ${hole}, #000 ${hole})`;
  return {
    background: `conic-gradient(${barColorValue(color)} ${fraction * 360}deg, rgb(128 128 128 / 0.25) 0)`,
    mask,
    WebkitMask: mask,
  };
}

/** Exported for the test that keeps the class and value maps in step. */
export const BAR_COLOR_KEYS = Object.keys(BAR_COLOR_CLASSES);
export const BAR_COLOR_VALUE_KEYS = Object.keys(BAR_COLOR_VALUES);
