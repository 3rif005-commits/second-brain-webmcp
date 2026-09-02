/**
 * Remark plugin: parses ":::name attr=val attr=\"q v\"" fenced directives into
 * a custom `customFence` mdast node carrying { name, attrs, children }.
 *
 * Container syntax:
 *   :::callout color=blue icon=📋
 *   This is the body — may contain **markdown**.
 *   :::
 *
 *   :::interactive title="Live derivative plotter"
 *   <html-block-here>
 *   :::
 *
 *   :::note-ref id=uuid title="Calculus"
 *   :::
 */
import { visit } from "unist-util-visit";
import type { Node, Parent } from "unist";
import type { Root } from "mdast";

const OPEN = /^:::([a-zA-Z][a-zA-Z0-9_-]*)\s*(.*)$/;
const CLOSE = /^:::\s*$/;

interface CustomFenceNode extends Node {
  type: "customFence";
  name: string;
  attrs: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  children: any[];
  raw: string;  // raw inner content (for HTML-only fences like interactive)
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

export function remarkCustomFences() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tree: Root) => {
    visit(tree, "paragraph", (node: any, index: number | undefined, parent: Parent | undefined) => {
      if (!parent || typeof index !== "number") return;
      const firstChild = node.children?.[0];
      if (!firstChild || firstChild.type !== "text") return;
      const m = OPEN.exec(firstChild.value.split("\n")[0]);
      if (!m) return;

      const name = m[1];
      const attrs = parseAttrs(m[2]);

      // Collect siblings until a closing ::: paragraph is found
      const innerNodes: any[] = [];
      const rawLines: string[] = [];
      let end = index + 1;
      while (end < parent.children.length) {
        const sib: any = parent.children[end];
        if (sib.type === "paragraph") {
          const txt = sib.children?.[0]?.value ?? "";
          if (CLOSE.test(txt.trim())) break;
        }
        innerNodes.push(sib);
        if (sib.type === "paragraph") {
          for (const c of sib.children ?? []) {
            if (c.value) rawLines.push(c.value);
          }
        }
        end++;
      }

      const fenceNode: CustomFenceNode = {
        type: "customFence",
        name,
        attrs,
        children: innerNodes,
        raw: rawLines.join("\n"),
      };
      parent.children.splice(index, end - index + 1, fenceNode as any);
    });
  };
}
