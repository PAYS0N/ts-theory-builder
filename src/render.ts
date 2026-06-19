// Passes C + D + E for the PLAIN profile (no smart-brace).
//
//  C (profile):  %b -> newline; NON-TERMINAL entries drop all bracing (the
//                delete/retype of the next chained stroke can't be trusted to
//                revert auto-paired or editor-supplied closers).
//  D (movement): TERMINAL entries land the cursor on %0 via the indent-independent
//                {#Up}xN {#End} {#Left}xK pattern (parsing-plan §4c / Pass D).
//  E (serialize): emit a Plover value — {^} prefix, \{ \} \n escapes, then the
//                movement keystroke group.
//
// The smart-brace profile (drop terminal closers, editor supplies them) layers on
// top of this and is not implemented yet.

import type { Chunk } from "./parse.ts";
import type { TypedEntry } from "./expand.ts";

const BRACKETS = new Set(["(", ")", "[", "]", "<", ">", "{", "}"]);

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

interface Rendered {
  text: string; // real newlines/tabs
  cursor: number | null; // char offset of %0, or null
}

function stripBrackets(s: string): string {
  let out = "";
  for (const ch of s) if (!BRACKETS.has(ch)) out += ch;
  return out;
}

function renderTemplate(template: Chunk[], terminal: boolean, oneLiner: boolean): Rendered {
  let text = "";
  let cursor: number | null = null;
  for (const c of template) {
    switch (c.k) {
      case "lit":
        text += terminal ? c.text : stripBrackets(c.text);
        break;
      case "brace":
        if (terminal) text += c.open ? "{" : "}";
        break;
      case "bodybreak":
        // newlines are irreversible too: only terminal strokes get them, and the
        // U one-liner collapses the break.
        if (terminal && !oneLiner) text += "\n";
        break;
      case "newline":
        if (terminal) text += "\n";
        break;
      case "tab":
        text += "\t";
        break;
      case "landing":
        if (c.n === 0) cursor = text.length; // plain profile only lands on %0
        break;
      default:
        throw new RenderError(`unresolved chunk "${c.k}" reached the renderer`);
    }
  }
  return { text, cursor };
}

/** Indent-independent move from end-of-text back to the cursor offset (Pass D). */
function movement(text: string, cursor: number): string {
  const lines = text.split("\n");
  let line = 0;
  let col = cursor;
  for (let i = 0; i < lines.length; i++) {
    if (col <= lines[i]!.length) {
      line = i;
      break;
    }
    col -= lines[i]!.length + 1; // +1 for the consumed newline
  }
  const N = lines.length - 1 - line; // lines up from the (last) cursor line
  const K = lines[line]!.length - col; // chars from line end back to the slot
  if (N === 0 && K === 0) return "";

  const keys: string[] = [];
  for (let i = 0; i < N; i++) keys.push("Up");
  if (N > 0) keys.push("End"); // normalize column after the Ups
  for (let i = 0; i < K; i++) keys.push("Left");
  return `{#${keys.join(" ")}}`;
}

function escapeText(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === " ") {
      // Plover collapses adjacent spaces and eats line-edge/trailing ones, so a
      // space run that is length>=2 or touches a boundary/newline must be made
      // explicit with {^ ^}. A lone internal space is safe.
      let j = i;
      while (j < s.length && s[j] === " ") j++;
      const len = j - i;
      const before = i > 0 ? s[i - 1] : undefined;
      const after = j < s.length ? s[j] : undefined;
      const safe = len === 1 && before !== undefined && before !== "\n" && after !== "\n";
      out += safe ? " " : "{^ ^}".repeat(len);
      i = j;
      continue;
    }
    if (ch === "{") out += "\\{";
    else if (ch === "}") out += "\\}";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else out += ch;
    i++;
  }
  return out;
}

/** Render one expanded+typed entry to a Plover { key, value } (plain profile). */
export function renderPlain(entry: TypedEntry): { key: string; value: string } {
  const { text, cursor } = renderTemplate(entry.template, entry.terminal, entry.oneLiner ?? false);
  let value = "{^}" + escapeText(text);
  if (entry.terminal && cursor != null) value += movement(text, cursor);
  value += "{^}"; // every translation ends attached: no trailing space
  return { key: entry.stroke, value };
}

export interface BuildResult {
  dict: Record<string, string>;
  /** Strokes that appeared twice with DIFFERENT values. */
  collisions: string[];
}

/** Render many entries into a Plover dictionary, flagging value collisions. */
export function buildPlainDict(entries: TypedEntry[]): BuildResult {
  const dict: Record<string, string> = {};
  const collisions: string[] = [];
  for (const e of entries) {
    const { key, value } = renderPlain(e);
    const prev = dict[key];
    if (prev !== undefined && prev !== value) collisions.push(key);
    dict[key] = value;
  }
  return { dict, collisions };
}
