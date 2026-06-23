// v2 smart emitter for pre-formatted multi-line blocks (the @literal data
// structures). A smart editor auto-closes every `{`, auto-indents each line, and
// block-expands `{`+Enter — so instead of typing literal `\t` and `}` (which the
// editor would double / reflow), we drive it structurally:
//
//   * type only the OPENING / content lines (every `}`-only line is auto-supplied)
//   * Enter after a line ending in `{` block-expands one level deeper
//   * Enter between siblings keeps the level
//   * to drop K levels, walk Down×K onto the outermost auto-`}`, End, Enter
//   * a line that *starts* with `}` (e.g. `} else {`) appends onto that auto-`}`
//
// Verified against Monaco (bin/monaco-check.ts). Indentation is the editor's, so
// the result uses its indent unit (4 spaces), not the template's tabs.

import type { Chunk } from "./parse.ts";
import type { Event, KeyName } from "./editor.ts";

const t = (s: string): Event => ({ k: "text", s });
const key = (k: KeyName, n = 1): Event => ({ k: "key", key: k, n });

interface SLine {
  depth: number;
  content: string;
}

/** Render a literal block template to its raw text (tabs, newlines, braces). */
export function structText(template: Chunk[]): string {
  let out = "";
  for (const c of template) {
    if (c.k === "lit") out += c.text;
    else if (c.k === "brace") out += c.open ? "{" : "}";
    else if (c.k === "newline" || c.k === "bodybreak") out += "\n";
    else if (c.k === "tab") out += "\t";
    // landings/typeslots don't occur in @literal blocks
  }
  return out;
}

/** Split into (tab-depth, content) lines, dropping blanks and `}`-only lines
 * (those closers are auto-supplied by the editor). */
function structLines(template: Chunk[]): SLine[] {
  const lines: SLine[] = [];
  for (const raw of structText(template).split("\n")) {
    let d = 0;
    while (raw[d] === "\t") d++;
    const content = raw.slice(d);
    if (content === "" || content === "}") continue;
    lines.push({ depth: d, content });
  }
  return lines;
}

/** Emit the keystroke IR for an @literal block under a smart auto-indent editor. */
export function emitStruct(template: Chunk[]): Event[] {
  const lines = structLines(template);
  const out: Event[] = [];
  let prevDepth = 0;
  let prevOpens = false;

  for (let i = 0; i < lines.length; i++) {
    const { depth, content } = lines[i]!;
    const closer = content.startsWith("}"); // e.g. `} else {`, `} catch (e) {`

    if (i > 0) {
      if (closer) {
        // Append onto the auto-supplied `}` that sits `prevDepth - depth` lines down.
        if (prevDepth - depth > 0) out.push(key("Down", prevDepth - depth));
        out.push(key("End"));
      } else if (prevOpens) {
        out.push(key("Enter")); // descend: block-expand the just-opened `{`
      } else if (depth === prevDepth) {
        out.push(key("Enter")); // sibling at the same level
      } else if (depth < prevDepth) {
        out.push(key("Down", prevDepth - depth)); // exit: past the auto-`}`s
        out.push(key("End"));
        out.push(key("Enter"));
      } else {
        out.push(key("Enter")); // deeper without an opener: shouldn't happen
      }
    }
    // A `}`-prefixed line's brace is already present; type only the remainder.
    out.push(t(closer ? content.slice(1) : content));
    prevDepth = depth;
    prevOpens = content.endsWith("{");
  }
  return out;
}
