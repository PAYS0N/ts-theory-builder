// Passes C + D + E — turn a typed entry into a Plover dictionary value.
//
// The editor model lives in editor.ts: emit a keystroke IR, interpret it under a
// Behaviors preset, then serialize. A "profile" is just a preset:
//   PLAIN  — a dumb editor: every closer typed, cursor walks back from doc end.
//   SMART  — auto-close + type-over + block-expand: emit only what the editor
//            won't supply (interior closers stay via type-over, the trailing run
//            of auto-closers drops), movement computed against the result buffer.
//
// NON-TERMINAL (type-append intermediate) strokes are identical in both: strip
// all brackets, no newlines, no movement — they emit no openers, so the next
// stroke's delete/retype has nothing auto-inserted to orphan.

import type { Chunk } from "./parse.ts";
import type { TypedEntry } from "./expand.ts";
import {
  type Behaviors,
  type Event,
  PLAIN,
  SMART,
  escapeText,
  interpret,
  movementEvents,
  serialize,
} from "./editor.ts";

const BRACKETS = new Set(["(", ")", "[", "]", "<", ">", "{", "}"]);
const AUTO_CLOSE = new Set([")", "]", "}"]);
const QUOTE = new Set(["`", '"', "'"]);

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

function stripBrackets(s: string): string {
  let out = "";
  for (const ch of s) if (!BRACKETS.has(ch)) out += ch;
  return out;
}

// --- emit: template -> keystroke IR ----------------------------------------

type Tok = { t: "ch"; ch: string } | { t: "enter" } | { t: "mark"; n: number };

function tokenize(template: Chunk[], oneLiner: boolean): Tok[] {
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
        if (!oneLiner) toks.push({ t: "enter" });
        break;
      case "newline":
        toks.push({ t: "enter" });
        break;
      case "tab":
        toks.push({ t: "ch", ch: "\t" });
        break;
      case "landing":
        toks.push({ t: "mark", n: c.n });
        break;
      default:
        throw new RenderError(`unresolved chunk "${(c as Chunk).k}" reached the renderer`);
    }
  }
  return toks;
}

/** Drop the trailing run of auto-closers (editor supplies them); skip marks,
 * stop at the first real token (an opener, normal char, or newline). */
function dropTrailingClosers(toks: Tok[]): Tok[] {
  const out = toks.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const tk = out[i]!;
    if (tk.t === "mark") continue;
    if (tk.t === "ch" && (AUTO_CLOSE.has(tk.ch) || QUOTE.has(tk.ch))) {
      out.splice(i, 1);
      continue;
    }
    break;
  }
  return out;
}

function coalesce(toks: Tok[]): Event[] {
  const events: Event[] = [];
  let run = "";
  const flush = (): void => {
    if (run) {
      events.push({ k: "text", s: run });
      run = "";
    }
  };
  for (const tk of toks) {
    if (tk.t === "ch") run += tk.ch;
    else if (tk.t === "enter") {
      flush();
      events.push({ k: "key", key: "Enter", n: 1 });
    } else {
      flush();
      events.push({ k: "mark", n: tk.n });
    }
  }
  flush();
  return events;
}

/** Emit the content keystrokes for a TERMINAL entry under the given behaviors. */
function emitContent(template: Chunk[], oneLiner: boolean, b: Behaviors): Event[] {
  let toks = tokenize(template, oneLiner);
  if (b.autoClose) toks = dropTrailingClosers(toks);
  return coalesce(toks);
}

// --- render: emit -> interpret -> serialize --------------------------------

/** Non-terminal: bracket-stripped partial, no newlines, no movement. */
function renderNonTerminal(template: Chunk[]): string {
  let text = "";
  for (const c of template) {
    if (c.k === "lit") text += stripBrackets(c.text);
    else if (c.k === "tab") text += "\t";
    // brace / bodybreak / newline / landing: dropped (irreversible)
  }
  return "{^}" + escapeText(text) + "{^}";
}

function renderWith(entry: TypedEntry, b: Behaviors): { key: string; value: string } {
  const content = emitContent(entry.template, entry.oneLiner ?? false, b);
  const state = interpret(content, b);
  const move =
    state.target != null ? movementEvents(state.buffer, state.rest, state.target) : [];
  const value = "{^}" + serialize([...content, ...move]) + "{^}";
  return { key: entry.stroke, value };
}

/** Render one expanded+typed entry to a Plover { key, value } (plain profile). */
export function renderPlain(entry: TypedEntry): { key: string; value: string } {
  if (!entry.terminal) return { key: entry.stroke, value: renderNonTerminal(entry.template) };
  return renderWith(entry, PLAIN);
}

/** Render one expanded+typed entry to a Plover { key, value } (smart profile). */
export function renderSmart(entry: TypedEntry): { key: string; value: string } {
  // @literal blocks (whole-code dumps) are emitted verbatim: a smart editor
  // mangles them regardless, so dropping closers would only lose a brace.
  if (entry.source.literal) return renderPlain(entry);
  if (!entry.terminal) return { key: entry.stroke, value: renderNonTerminal(entry.template) };
  return renderWith(entry, SMART);
}

export interface BuildResult {
  dict: Record<string, string>;
  /** Strokes that appeared twice with DIFFERENT values. */
  collisions: string[];
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

/** Render many entries into the plain Plover dictionary, flagging collisions. */
export function buildPlainDict(entries: TypedEntry[]): BuildResult {
  return buildDict(entries, renderPlain);
}

/** Render many entries into the smart-brace Plover dictionary. */
export function buildSmartDict(entries: TypedEntry[]): BuildResult {
  return buildDict(entries, renderSmart);
}
