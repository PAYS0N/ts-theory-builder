// Stage 1 of the pipeline (see ../../parsing-plan.md): source text -> typed AST.
// This file does NOT expand counts/types, compile movement, or emit JSON — it
// only turns a .steno source into Entry[] with each template parsed to Chunk[].

export class StenoError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.name = "StenoError";
    this.line = line;
  }
}

/** A computed index `%(EXPR)`, stored in linear form `a*d + b` (d = repeat index). */
export interface Expr {
  a: number;
  b: number;
}

export type Chunk =
  | { k: "lit"; text: string } // literal run of text
  | { k: "brace"; open: boolean } // a raw structural { or } (profile may strip closers)
  | { k: "newline" } // the \n escape
  | { k: "tab" } // the \t escape
  | { k: "landing"; n: number } // %0..%9 ordered landing point
  | { k: "dcount" } // %d count from the bank
  | { k: "typeslot" } // %t, filled by an appended type stroke
  | { k: "bodybreak" } // %b, the one-liner-toggleable newline
  | { k: "pattern" } // %p destructuring slot
  | { k: "repeat"; sep: Chunk[]; body: Chunk[] } // %[ sep | body %]
  | { k: "computed"; expr: Expr }; // %(EXPR)

export interface Entry {
  /** Stroke key split on `/`, e.g. ["STKWR-PBGS", "-FLT"]. */
  stroke: string[];
  strokeRaw: string;
  template: Chunk[];
  /** Raw template text between the fences (for debugging / round-trip). */
  raw: string;
  /** @count key spec, e.g. "AOEU". Weights are derived later from board geometry. */
  count?: string;
  /** @arity N — type-arg count for a generic type entry. */
  arity?: number;
  /** @multiline — construct never collapses to one line (ignores the O flag). */
  multiline?: boolean;
  /** 1-based line of the opening fence. */
  line: number;
}

/** Parse a single template string into a Chunk[]. Exposed for unit testing. */
export function parseTemplate(src: string, line = 1): Chunk[] {
  let i = 0;
  const peek = (o = 0): string | undefined => (i + o < src.length ? src[i + o] : undefined);
  const fail = (msg: string): never => {
    throw new StenoError(`${msg} (col ${i + 1})`, line);
  };

  const parseExpr = (raw: string): Expr => {
    const s = raw.replace(/\s+/g, "");
    const m = /^(-?\d*)d([+-]\d+)?$/.exec(s);
    if (m) {
      const a = m[1] === "" ? 1 : m[1] === "-" ? -1 : parseInt(m[1], 10);
      const b = m[2] ? parseInt(m[2], 10) : 0;
      return { a, b };
    }
    if (/^-?\d+$/.test(s)) return { a: 0, b: parseInt(s, 10) };
    return fail(`bad computed expression "${raw}"`);
  };

  const parseComputed = (): Chunk => {
    // "%(" already consumed
    let e = "";
    while (peek() !== undefined && peek() !== ")") e += src[i++];
    if (peek() !== ")") fail("unterminated %( ... )");
    i++; // consume ')'
    return { k: "computed", expr: parseExpr(e) };
  };

  const parseRepeat = (): Chunk => {
    // "%[" already consumed. First segment stops on a top-level | or %].
    const first = parseChunks(true, true);
    if (first.stop === "|") {
      const body = parseChunks(false, true);
      return { k: "repeat", sep: first.chunks, body: body.chunks };
    }
    // No separator was given: the single segment is the body.
    return { k: "repeat", sep: [], body: first.chunks };
  };

  function parseChunks(
    stopOnPipe: boolean,
    stopOnClose: boolean,
  ): { chunks: Chunk[]; stop: "|" | "%]" | "" } {
    const chunks: Chunk[] = [];
    let lit = "";
    const flush = () => {
      if (lit) {
        chunks.push({ k: "lit", text: lit });
        lit = "";
      }
    };

    while (true) {
      const c = peek();
      if (c === undefined) break;

      if (stopOnClose && c === "%" && peek(1) === "]") {
        flush();
        i += 2;
        return { chunks, stop: "%]" };
      }
      if (stopOnPipe && c === "|") {
        flush();
        i++;
        return { chunks, stop: "|" };
      }

      if (c === "\\") {
        const n = peek(1);
        if (n === undefined) fail("trailing backslash");
        i += 2;
        if (n === "n") {
          flush();
          chunks.push({ k: "newline" });
        } else if (n === "t") {
          flush();
          chunks.push({ k: "tab" });
        } else if (n === "{" || n === "}" || n === "%" || n === "|" || n === "\\" || n === "`") {
          lit += n;
        } else {
          i -= 2;
          fail(`unknown escape \\${n}`);
        }
        continue;
      }

      if (c === "{") {
        flush();
        chunks.push({ k: "brace", open: true });
        i++;
        continue;
      }
      if (c === "}") {
        flush();
        chunks.push({ k: "brace", open: false });
        i++;
        continue;
      }

      if (c === "%") {
        const n = peek(1);
        if (n === undefined) fail("trailing '%'");
        if (n !== undefined && n >= "0" && n <= "9") {
          flush();
          chunks.push({ k: "landing", n: Number(n) });
          i += 2;
          continue;
        }
        if (n === "d") {
          flush();
          chunks.push({ k: "dcount" });
          i += 2;
          continue;
        }
        if (n === "t") {
          flush();
          chunks.push({ k: "typeslot" });
          i += 2;
          continue;
        }
        if (n === "b") {
          flush();
          chunks.push({ k: "bodybreak" });
          i += 2;
          continue;
        }
        if (n === "p") {
          flush();
          chunks.push({ k: "pattern" });
          i += 2;
          continue;
        }
        if (n === "[") {
          flush();
          i += 2;
          chunks.push(parseRepeat());
          continue;
        }
        if (n === "(") {
          flush();
          i += 2;
          chunks.push(parseComputed());
          continue;
        }
        fail(`unknown operator %${n}`);
      }

      lit += c;
      i++;
    }

    flush();
    if (stopOnClose) fail("unterminated %[ ... %]");
    return { chunks, stop: "" };
  }

  return parseChunks(false, false).chunks;
}

const FENCE = /^(`{4,})(.*)$/;

/** Parse a whole .steno source into entries. Throws StenoError on any problem. */
export function parseSource(src: string): Entry[] {
  const lines = src.split(/\r?\n/);
  const entries: Entry[] = [];
  let last: Entry | undefined;
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i] ?? "";
    const lineNo = i + 1;
    const fm = FENCE.exec(raw);

    if (fm) {
      if (fm[2].trim() === "") {
        throw new StenoError("closing fence without an open block", lineNo);
      }
      const strokeRaw = fm[2].trim();
      const content: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const cl = lines[i] ?? "";
        const cfm = FENCE.exec(cl);
        if (cfm && cfm[2].trim() === "") {
          closed = true;
          i++;
          break;
        }
        content.push(cl);
        i++;
      }
      if (!closed) throw new StenoError(`unterminated block for "${strokeRaw}"`, lineNo);

      const text = content.join("\n");
      const entry: Entry = {
        strokeRaw,
        stroke: strokeRaw
          .split("/")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
        template: parseTemplate(text, lineNo + 1),
        raw: text,
        line: lineNo,
      };
      entries.push(entry);
      last = entry;
      continue;
    }

    const t = raw.trim();
    if (t === "" || t.startsWith("//") || t.startsWith("#")) {
      i++;
      continue;
    }
    if (t.startsWith("@")) {
      if (!last) throw new StenoError("directive before any entry", lineNo);
      applyDirective(last, t, lineNo);
      i++;
      continue;
    }
    throw new StenoError(`unexpected text: ${t}`, lineNo);
  }

  return entries;
}

function applyDirective(e: Entry, line: string, lineNo: number): void {
  const m = /^@(\w+)\s*(.*)$/.exec(line);
  if (!m) throw new StenoError(`malformed directive: ${line}`, lineNo);
  const name = m[1];
  const arg = m[2].trim();
  switch (name) {
    case "count":
      if (!arg) throw new StenoError("@count needs a key list", lineNo);
      e.count = arg;
      return;
    case "arity": {
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 0) {
        throw new StenoError(`@arity needs a non-negative integer, got "${arg}"`, lineNo);
      }
      e.arity = n;
      return;
    }
    case "multiline":
      e.multiline = true;
      return;
    default:
      throw new StenoError(`unknown directive @${name}`, lineNo);
  }
}
