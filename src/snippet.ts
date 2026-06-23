// Snippet target — render a TypedEntry to an LSP snippet body for editor-side
// expansion (Neovim's built-in vim.snippet, VS Code, etc.).
//
// Unlike render.ts (which bakes cursor movement into Plover keystrokes), the
// editor's snippet engine owns cursor placement via tabstops. So there is NO
// movement math, NO closer-dropping, and NO plain/smart split — the engine
// inserts the body literally and walks the tabstops itself.
//
// Landings -> LSP tabstops, renumbered to tab order: the lowest landing becomes
// ${1} and ascends, and the HIGHEST landing becomes ${0} (LSP's final exit), so
// you tab name -> param -> ... -> body and finish in the body. A construct with
// a single landing puts it at ${0}.
//
// NON-TERMINAL (type-append intermediate) strokes emit the same bracket-stripped
// "pre-function" partial text they do in the plain profile, with no tabstops.

import type { Chunk } from "./parse.ts";
import type { TypedEntry } from "./expand.ts";

export class SnippetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnippetError";
  }
}

const BRACKETS = new Set(["(", ")", "[", "]", "<", ">", "{", "}"]);

function stripBrackets(s: string): string {
  let out = "";
  for (const ch of s) if (!BRACKETS.has(ch)) out += ch;
  return out;
}

/** Escape literal text for an LSP snippet body (tabstops are emitted raw). */
function esc(s: string): string {
  let out = "";
  for (const ch of s) out += ch === "\\" || ch === "$" || ch === "}" ? "\\" + ch : ch;
  return out;
}

/** LSP tabstop index for a landing: highest -> 0 (exit), the rest 1..k ascending. */
function tabIndex(n: number, sorted: number[]): number {
  const max = sorted[sorted.length - 1]!;
  if (n === max) return 0;
  return sorted.indexOf(n) + 1;
}

export interface SnippetEntry {
  /** Stable id, also the Plover-emitted token (sentinel-wrapped) and table key. */
  keyId: string;
  /** LSP snippet syntax body. */
  body: string;
  terminal: boolean;
}

/** Render one expanded+typed entry to an LSP snippet. */
export function renderSnippet(entry: TypedEntry): SnippetEntry {
  if (!entry.terminal) {
    // "pre-function" partial: strip brackets, no newlines, no tabstops — exactly
    // what the plain profile emits for a non-terminal, minus the {^} wrapper.
    let body = "";
    for (const c of entry.template) {
      switch (c.k) {
        case "lit":
          body += esc(stripBrackets(c.text));
          break;
        case "tab":
          body += "\t";
          break;
        case "brace":
        case "newline":
        case "bodybreak":
        case "landing":
          break; // dropped: irreversible / not needed for an intermediate
        default:
          throw new SnippetError(`unresolved chunk "${(c as Chunk).k}" reached the snippet renderer`);
      }
    }
    return { keyId: entry.stroke, body, terminal: false };
  }

  const sorted = [
    ...new Set(entry.template.flatMap((c) => (c.k === "landing" ? [c.n] : []))),
  ].sort((a, b) => a - b);
  const oneLiner = entry.oneLiner ?? false;
  let body = "";
  for (const c of entry.template) {
    switch (c.k) {
      case "lit":
        body += esc(c.text);
        break;
      case "brace":
        body += c.open ? "{" : "\\}"; // lone { is literal in LSP; } must escape
        break;
      case "bodybreak":
        if (!oneLiner) body += "\n";
        break;
      case "newline":
        body += "\n";
        break;
      case "tab":
        body += "\t";
        break;
      case "landing":
        body += `\${${tabIndex(c.n, sorted)}}`;
        break;
      default:
        throw new SnippetError(`unresolved chunk "${(c as Chunk).k}" reached the snippet renderer`);
    }
  }
  return { keyId: entry.stroke, body, terminal: true };
}

export interface SnippetBuild {
  /** Plover dictionary: stroke -> sentinel-wrapped token to type. */
  ploverKeys: Record<string, string>;
  /** Snippet table: keyId -> LSP body. */
  snippets: Record<string, string>;
  /** Strokes that mapped to two different bodies. */
  collisions: string[];
}

/** Sentinel pair wrapping the keyset token Plover types (so the plugin can find
 * it without colliding with ordinary text). ASCII so Javelin can emit it, and
 * not an auto-pairing char so the smart editor won't mangle the token. Keep in
 * sync with the nvim plugin. */
export const SENTINEL_OPEN = "@@";
export const SENTINEL_CLOSE = "@@";

/** Build both artifacts from the typed entries. */
export function buildSnippets(entries: TypedEntry[]): SnippetBuild {
  const ploverKeys: Record<string, string> = {};
  const snippets: Record<string, string> = {};
  const collisions: string[] = [];
  for (const e of entries) {
    const { keyId, body } = renderSnippet(e);
    const prev = snippets[keyId];
    if (prev !== undefined && prev !== body) collisions.push(keyId);
    snippets[keyId] = body;
    ploverKeys[e.stroke] = SENTINEL_OPEN + keyId + SENTINEL_CLOSE;
  }
  return { ploverKeys, snippets, collisions };
}
