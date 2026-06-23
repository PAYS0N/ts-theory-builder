// The editor model, separated from rendering so each editor behavior is an
// independent, testable knob.
//
//   emit(template, behaviors)  -> Event[]      (what Plover types: a keystroke IR)
//   interpret(events, behaviors) -> EditorState (how an editor reacts)
//   serialize(events)          -> Plover value string
//
// A "profile" is just a Behaviors preset: PLAIN = a dumb editor (all features
// off), SMART = auto-close + type-over + block-expand, SMART_INDENT adds
// auto-indent (so multi-level blocks need no literal \t and no typed closers).
// Tests assert  interpret(emit(t, B), B)  reproduces the intended code with the
// cursor on %0, for each B — and a Monaco harness checks the model against the
// real editor.

export type KeyName =
  | "Up"
  | "Down"
  | "Left"
  | "Right"
  | "Home"
  | "End"
  | "BackSpace"
  | "Tab"
  | "Enter";

export type Event =
  | { k: "text"; s: string } // literal characters typed (may trigger auto-close)
  | { k: "key"; key: KeyName; n: number } // a special key, repeated n times
  | { k: "mark"; n: number }; // record the cursor as landing %n (types nothing)

export interface Behaviors {
  /** Typing ( [ { (and quotes) inserts the matching closer. */
  autoClose: boolean;
  /** Typing a closer while the cursor sits on the matching auto-closer steps over it. */
  typeOver: boolean;
  /**
   * A new line is auto-indented to the current brace depth, and Enter between
   * empty braces `{|}` block-expands onto three lines. Verified in Monaco: this
   * is gated on auto-indent (with it off, Enter just inserts a bare newline) and
   * Backspace inside leading indentation deletes a whole `indentUnit` level.
   */
  autoIndent: boolean;
  /** One indentation level — VS Code's default is four spaces. */
  indentUnit: string;
}

const INDENT_UNIT = "    "; // four spaces (VS Code default)

export const PLAIN: Behaviors = {
  autoClose: false,
  typeOver: false,
  autoIndent: false,
  indentUnit: INDENT_UNIT,
};

export const SMART: Behaviors = {
  autoClose: true,
  typeOver: true,
  autoIndent: false,
  indentUnit: INDENT_UNIT,
};

export const SMART_INDENT: Behaviors = { ...SMART, autoIndent: true };

const AUTO_OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const AUTO_CLOSE = new Set([")", "]", "}"]);
const QUOTE = new Set(["`", '"', "'"]);

export interface EditorState {
  buffer: string;
  /** Final cursor offset (where the last keystroke left it). */
  rest: number;
  /** %0's offset, or null. */
  target: number | null;
}

/** Run a keystroke stream through an editor with the given behaviors. */
export function interpret(events: Event[], b: Behaviors): EditorState {
  let buffer = "";
  let cursor = 0;
  const landing: Record<number, number> = {};

  const insert = (s: string): void => {
    buffer = buffer.slice(0, cursor) + s + buffer.slice(cursor);
    cursor += s.length;
  };
  const lineStart = (off: number): number => buffer.lastIndexOf("\n", off - 1) + 1;
  const lineEnd = (off: number): number => {
    const i = buffer.indexOf("\n", off);
    return i === -1 ? buffer.length : i;
  };
  const leadingIndent = (start: number): string => {
    let i = start;
    while (buffer[i] === " " || buffer[i] === "\t") i++;
    return buffer.slice(start, i);
  };

  const typeChar = (ch: string): void => {
    if (b.autoClose && AUTO_OPEN[ch]) {
      insert(ch + AUTO_OPEN[ch]);
      cursor -= AUTO_OPEN[ch].length; // sit between the pair
    } else if (b.autoClose && QUOTE.has(ch)) {
      if (buffer[cursor] === ch) cursor += 1; // type over the auto quote
      else {
        insert(ch + ch);
        cursor -= 1;
      }
    } else if (b.typeOver && (AUTO_CLOSE.has(ch) || QUOTE.has(ch)) && buffer[cursor] === ch) {
      cursor += 1; // type over the auto closer
    } else {
      insert(ch);
    }
  };

  const enter = (): void => {
    if (!b.autoIndent) {
      insert("\n"); // dumb: a bare newline, no expansion or indent
      return;
    }
    if (buffer[cursor - 1] === "{" && buffer[cursor] === "}") {
      // Block-expand: open line / indented body line / dedented close line.
      const base = leadingIndent(lineStart(cursor));
      insert("\n" + base + b.indentUnit + "\n" + base);
      cursor -= ("\n" + base).length; // back onto the body line's end
      return;
    }
    // Indent the new line to the depth implied by the line we are leaving.
    const start = lineStart(cursor);
    let indent = leadingIndent(start);
    const lineSoFar = buffer.slice(start, cursor).trimEnd();
    if (/[([{]$/.test(lineSoFar)) indent += b.indentUnit;
    insert("\n" + indent);
  };

  const applyKey = (key: KeyName): void => {
    switch (key) {
      case "Enter":
        enter();
        break;
      case "BackSpace":
        if (cursor > 0) {
          // Inside leading indentation, Backspace deletes back to the previous
          // tab stop (a whole indentUnit), matching VS Code's useTabStops.
          const start = lineStart(cursor);
          const before = buffer.slice(start, cursor);
          let del = 1;
          if (b.autoIndent && before.length > 0 && /^ +$/.test(before)) {
            const unit = b.indentUnit.length || 1;
            del = before.length - Math.floor((before.length - 1) / unit) * unit;
          }
          buffer = buffer.slice(0, cursor - del) + buffer.slice(cursor);
          cursor -= del;
        }
        break;
      case "Left":
        if (cursor > 0) cursor -= 1;
        break;
      case "Right":
        if (cursor < buffer.length) cursor += 1;
        break;
      case "Home":
        cursor = lineStart(cursor);
        break;
      case "End":
        cursor = lineEnd(cursor);
        break;
      case "Up": {
        const col = cursor - lineStart(cursor);
        const prevEnd = lineStart(cursor) - 1;
        if (prevEnd >= 0) {
          const prevStart = lineStart(prevEnd);
          cursor = Math.min(prevStart + col, prevEnd);
        }
        break;
      }
      case "Down": {
        const col = cursor - lineStart(cursor);
        const nextStart = lineEnd(cursor) + 1;
        if (nextStart <= buffer.length) {
          cursor = Math.min(nextStart + col, lineEnd(nextStart));
        }
        break;
      }
      case "Tab":
        insert(b.indentUnit);
        break;
    }
  };

  for (const ev of events) {
    if (ev.k === "mark") landing[ev.n] = cursor;
    else if (ev.k === "text") for (const ch of ev.s) typeChar(ch);
    else for (let i = 0; i < ev.n; i++) applyKey(ev.key);
  }
  return { buffer, rest: cursor, target: landing[0] ?? null };
}

/**
 * Indent-independent movement from the resting cursor to the target offset,
 * as key Events: cross lines with Up×N then End, then Left to the column; a
 * same-line move goes straight Left from where the cursor rests.
 */
export function movementEvents(buffer: string, from: number, to: number): Event[] {
  const lines = buffer.split("\n");
  const pos = (off: number): { line: number; col: number } => {
    let col = off;
    for (let i = 0; i < lines.length; i++) {
      if (col <= lines[i]!.length) return { line: i, col };
      col -= lines[i]!.length + 1;
    }
    return { line: lines.length - 1, col: lines[lines.length - 1]!.length };
  };
  const f = pos(from);
  const t = pos(to);
  const n = f.line - t.line;
  if (n < 0) throw new Error("movement target is below the resting cursor");
  const out: Event[] = [];
  if (n === 0) {
    const k = f.col - t.col;
    if (k < 0) throw new Error("movement target is right of the resting cursor");
    if (k > 0) out.push({ k: "key", key: "Left", n: k });
  } else {
    out.push({ k: "key", key: "Up", n });
    out.push({ k: "key", key: "End", n: 1 });
    const k = lines[t.line]!.length - t.col;
    if (k > 0) out.push({ k: "key", key: "Left", n: k });
  }
  return out;
}

/** Escape literal text for a Plover value (spaces at boundaries need {^ ^}). */
export function escapeText(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === " ") {
      let j = i;
      while (j < s.length && s[j] === " ") j++;
      const len = j - i;
      const before = i > 0 ? s[i - 1] : undefined;
      const after = j < s.length ? s[j] : undefined;
      // A lone internal space is safe only with a real char on both sides;
      // touching a boundary/newline is a space Plover eats.
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

/**
 * Serialize a keystroke stream to a Plover value (no surrounding {^} affixes).
 * Typed characters and newlines accumulate into one text span that is escaped
 * as a whole (so boundary-space detection sees real neighbors); marks are
 * invisible and never split a span; only true editing/navigation keys
 * (Backspace, arrows, End…) emit a `{#...}` group and break the span.
 */
export function serialize(events: Event[]): string {
  let out = "";
  let text = ""; // pending typed characters (with real \n for Enter)
  let group: string[] = []; // pending {#...} keys
  const flushText = (): void => {
    if (text) {
      out += escapeText(text);
      text = "";
    }
  };
  const flushGroup = (): void => {
    if (group.length) {
      out += `{#${group.join(" ")}}`;
      group = [];
    }
  };
  for (const ev of events) {
    if (ev.k === "mark") continue;
    if (ev.k === "text") {
      flushGroup();
      text += ev.s;
    } else if (ev.key === "Enter") {
      flushGroup();
      text += "\n".repeat(ev.n);
    } else {
      flushText();
      for (let i = 0; i < ev.n; i++) group.push(ev.key);
    }
  }
  flushText();
  flushGroup();
  return out;
}
