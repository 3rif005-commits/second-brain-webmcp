// M7's "Display as" (view-tab-bar.md) — Text and icon / Text only / Icon
// only. Notion's own copy marks this "Only applies to you", and it governs
// the TAB's presentation, not the view TYPE — so it must not go into
// `view.config`, which is shared across every viewer of this (single-user,
// but still) app. `localStorage`, keyed per view id, is the whole store.
export type ViewTabDisplayAs = "text_and_icon" | "text_only" | "icon_only";

const PREFIX = "db-view-tab-display-as:";

export function getDisplayAs(viewId: string): ViewTabDisplayAs {
  if (typeof window === "undefined") return "text_and_icon";
  try {
    const raw = window.localStorage.getItem(PREFIX + viewId);
    if (raw === "text_and_icon" || raw === "text_only" || raw === "icon_only") return raw;
  } catch {
    // localStorage unavailable (SSR, private mode) — fall back to the default.
  }
  return "text_and_icon";
}

export function setDisplayAs(viewId: string, mode: ViewTabDisplayAs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFIX + viewId, mode);
  } catch {
    // Best-effort; a failed write just means the preference doesn't stick.
  }
}
