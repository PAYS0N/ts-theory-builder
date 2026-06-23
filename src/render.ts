// Passes C + D + E, for BOTH profiles.
//
//  C (profile):  %b -> newline; NON-TERMINAL entries drop all bracing (the
//                delete/retype of the next chained stroke can't be trusted to
//                revert auto-paired or editor-supplied closers).
//  D (movement): TERMINAL entries land the cursor on %0 via the indent-independent
//                {#Up}xN {#End} {#Left}xK pattern (parsing-plan §4c / Pass D).
//  E (serialize): emit a Plover value — {^} prefix, \{ \} \n escapes, then the
//                movement keystroke group.
//
// PLAIN profile (renderPlain): a dumb editor. Every closer is typed; the cursor
// rests at document end after typing and walks back to %0.
//
// SMART profile (renderSmart): a VS Code-style editor that auto-closes ( [ { and
// quotes (NOT <, ambiguous in TS), types over a closer when the cursor sits on
// it, and block-expands a newline typed inside {}. We emit only what the editor
// won't supply — interior closers stay (passed via type-over), the trailing run
// of auto-closers is dropped — and compute movement against the editor's RESULT
// buffer (simulateSmart), which the cursor rests inside, not at its end.
// Non-terminal entries are byte-identical to the plain profile: they emit no
// openers, so nothing is auto-inserted for the next stroke's delete/retype to
// orphan.

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

/**
 * Indent-independent move within `buffer` from the cursor's resting offset
 * `from` to the target offset `to` (Pass D). Crossing lines uses {#End} to
 * normalize the column (so editor indentation never matters); a same-line move
 * counts {#Left} straight from the resting column. The target must not be below
 * or right-of the resting cursor — every construct lands %0 at or before where
 * the last keystroke leaves the cursor.
 */
function movement(buffer: string, from: number, to: number): string {
  const lines = buffer.split("\n");
  const pos = (off: number): { line: number; col: number } => {
    let col = off;
    for (let i = 0; i < lines.length; i++) {
      if (col <= lines[i]!.length) return { line: i, col };
      col -= lines[i]!.length + 1; // +1 for the consumed newline
    }
    return { line: lines.length - 1, col: lines[lines.length - 1]!.length };
  };
  const f = pos(from);
  const t = pos(to);
  const N = f.line - t.line;
  if (N < 0) throw new RenderError("movement target is below the resting cursor");

  const keys: string[] = [];
  if (N === 0) {
    const k = f.col - t.col; // straight left from where the cursor rests
    if (k < 0) throw new RenderError("movement target is right of the resting cursor");
    for (let i = 0; i < k; i++) keys.push("Left");
  } else {
    for (let i = 0; i < N; i++) keys.push("Up");
    keys.push("End"); // normalize column after the Ups
    const k = lines[t.line]!.length - t.col; // back from the target line's end
    for (let i = 0; i < k; i++) keys.push("Left");
  }
  if (keys.length === 0) return "";
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
      // A lone internal space is safe only with a real (non-newline) char on BOTH
      // sides. Touching the start/end of the text or a newline is a boundary
      // Plover eats — e.g. a trailing space exposed when smart drops a closer.
      const safe =
        len === 1 &&
        before !== undefined &&
        before !== "\n" &&
        after !== undefined &&
        after !== "\n";
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
  // Plain: the cursor rests at document end after typing every closer.
  if (entry.terminal && cursor != null) value += movement(text, text.length, cursor);
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
  return buildDict(entries, renderPlain);
}

function buildDict(
  entries: TypedEntry[],
  render: (e: TypedEntry) => { key: string; value: string },
): BuildResult {
  const dict: Record<string, string> = {};
  const collisions: string[] = [];
  for (const e of entries) {
    const { key, value } = render(e);
    const prev = dict[key];
    if (prev !== undefined && prev !== value) collisions.push(key);
    dict[key] = value;
  }
  return { dict, collisions };
}

// ---------------------------------------------------------------------------
// SMART-brace profile.
// ---------------------------------------------------------------------------

/** Openers the editor auto-closes (NOT `<` — ambiguous with comparison in TS). */
const AUTO_OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const AUTO_CLOSE = new Set([")", "]", "}"]);
/** Quote-likes auto-close to themselves; the same char opens or types over. */
const QUOTE = new Set(["`", '"', "'"]);

type Tok = { t: "ch"; ch: string } | { t: "nl" } | { t: "land"; n: number };

interface SmartSim {
  /** Exactly the keystrokes Plover sends (openers kept, dropped closers gone). */
  emitted: string;
  /** The editor's resulting buffer, with auto-closers and block-expansion. */
  buffer: string;
  /** Cursor offset in `buffer` after the last keystroke. */
  rest: number;
  /** %0's offset in `buffer`, or null. */
  target: number | null;
}

/** Flatten a terminal template to a token stream (brackets kept as chars). */
function flattenSmart(template: Chunk[], oneLiner: boolean): Tok[] {
  const toks: Tok[] = [];
  for (const c of template) {
    switch (c.k) {
      case "lit":
        for (const ch of c.text) toks.push({ t: "ch", ch });
        break;
      case "brace":
        toks.push({ t: "ch", ch: c.open ? "{" : "}" });
        break;
      case "bodybreak":
        if (!oneLiner) toks.push({ t: "nl" });
        break;
      case "newline":
        toks.push({ t: "nl" });
        break;
      case "tab":
        toks.push({ t: "ch", ch: "\t" });
        break;
      case "landing":
        toks.push({ t: "land", n: c.n });
        break;
      default:
        throw new RenderError(`unresolved chunk "${c.k}" reached the renderer`);
    }
  }
  return toks;
}

/** Drop the trailing run of auto-closers (editor supplies them); skip landings,
 * stop at the first real token (an opener, normal char, or newline). */
function dropTrailingClosers(toks: Tok[]): Tok[] {
  const out = toks.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const tk = out[i]!;
    if (tk.t === "land") continue; // a landing doesn't end the run
    if (tk.t === "ch" && (AUTO_CLOSE.has(tk.ch) || QUOTE.has(tk.ch))) {
      out.splice(i, 1);
      continue;
    }
    break;
  }
  return out;
}

/** Simulate typing a terminal template into a smart-brace editor. */
function simulateSmart(template: Chunk[], oneLiner: boolean): SmartSim {
  const toks = dropTrailingClosers(flattenSmart(template, oneLiner));
  let emitted = "";
  let buffer = "";
  let cur = 0;
  const landing: Record<number, number> = {};
  const insert = (s: string): void => {
    buffer = buffer.slice(0, cur) + s + buffer.slice(cur);
  };

  for (const tk of toks) {
    if (tk.t === "land") {
      landing[tk.n] = cur;
      continue;
    }
    if (tk.t === "nl") {
      emitted += "\n";
      // A newline typed inside empty braces block-expands onto three lines.
      if (buffer[cur - 1] === "{" && buffer[cur] === "}") insert("\n\n");
      else insert("\n");
      cur += 1;
      continue;
    }
    const ch = tk.ch;
    emitted += ch;
    if (QUOTE.has(ch)) {
      if (buffer[cur] === ch) cur += 1; // type over the auto-quote
      else insert(ch + ch), (cur += 1); // open a fresh pair
    } else if (AUTO_OPEN[ch]) {
      insert(ch + AUTO_OPEN[ch]); // editor auto-closes
      cur += 1;
    } else if (AUTO_CLOSE.has(ch)) {
      if (buffer[cur] === ch) cur += 1; // type over the auto-closer
      else insert(ch), (cur += 1); // a manual closer (no pair present)
    } else {
      insert(ch);
      cur += 1;
    }
  }
  return { emitted, buffer, rest: cur, target: landing[0] ?? null };
}

/** Render one expanded+typed entry to a Plover { key, value } (smart profile). */
export function renderSmart(entry: TypedEntry): { key: string; value: string } {
  // @literal blocks (whole-code dumps) are emitted verbatim: a smart editor
  // mangles them regardless, so dropping closers would only lose a brace.
  if (entry.source.literal) return renderPlain(entry);
  if (!entry.terminal) {
    // Identical to plain: strip all brackets, no newline, no movement.
    const { text } = renderTemplate(entry.template, false, entry.oneLiner ?? false);
    return { key: entry.stroke, value: "{^}" + escapeText(text) + "{^}" };
  }
  const sim = simulateSmart(entry.template, entry.oneLiner ?? false);
  let value = "{^}" + escapeText(sim.emitted);
  if (sim.target != null) value += movement(sim.buffer, sim.rest, sim.target);
  value += "{^}";
  return { key: entry.stroke, value };
}

/** Render many entries into the smart-brace Plover dictionary. */
export function buildSmartDict(entries: TypedEntry[]): BuildResult {
  return buildDict(entries, renderSmart);
}
