type AnyBlockLike = { type: string; children?: AnyBlockLike[]; [key: string]: unknown };

export async function extractCalloutChildren<T extends AnyBlockLike>(
  html: string,
  parseHTML: (html: string) => Promise<T[]>
): Promise<{ strippedHtml: string; calloutChildren: T[][] }> {
  const doc = new window.DOMParser().parseFromString(html, "text/html");
  const allCalloutDivs = [...doc.querySelectorAll('div[data-type="callout"]')];
  // attachCalloutChildren re-associates extracted children with their callout
  // block using a positional counter (document order). A callout div nested
  // inside another callout div, or inside a table cell, would still match
  // querySelectorAll but isn't a top-level callout in the block tree BlockNote
  // produces — extracting/counting it desyncs the counter and silently
  // mis-attributes every callout that follows. Skip those instead: leave
  // their markup untouched rather than risk wrong content on a sibling.
  //
  // Note: this deliberately checks `el.parentElement.closest(...)` (strict
  // ancestors only), not `el.closest(...)`. `closest()` matches the element
  // itself before walking up, and every callout div always self-matches the
  // `div[data-type="callout"]` branch of this selector — so calling it on
  // the element itself would always return the element, making the check a
  // no-op that never detects nesting (verified with a jsdom probe).
  const calloutDivs = allCalloutDivs.filter(
    (el) => el.parentElement?.closest('div[data-type="callout"], td, th') == null
  );
  if (calloutDivs.length !== allCalloutDivs.length) {
    console.warn(
      `extractCalloutChildren: skipped ${allCalloutDivs.length - calloutDivs.length} ` +
        `callout div(s) nested inside another callout or a table cell (left in place, not extracted).`
    );
  }
  const calloutChildren: T[][] = [];
  for (const el of calloutDivs) {
    const children = await parseHTML(el.innerHTML);
    calloutChildren.push(children);
    el.innerHTML = "";
  }
  return { strippedHtml: doc.body.innerHTML, calloutChildren };
}

export function attachCalloutChildren<T extends AnyBlockLike>(
  blocks: T[],
  calloutChildren: T[][]
): T[] {
  let i = 0;
  function walk(list: T[]): T[] {
    return list.map((b) => {
      const children = Array.isArray(b.children) ? walk(b.children as T[]) : [];
      if (b.type === "callout") {
        return { ...b, children: calloutChildren[i++] ?? [] };
      }
      return { ...b, children };
    });
  }
  return walk(blocks);
}
