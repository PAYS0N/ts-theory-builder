import { describe, it, expect } from "vitest";
import { parseSource, type Chunk } from "../src/parse.ts";
import { expandCounts, ExpandError } from "../src/expand.ts";

/** Render resolved chunks for assertions. Any count chunk left over is a bug. */
function show(chunks: Chunk[]): string {
  return chunks
    .map((c) => {
      switch (c.k) {
        case "lit":
          return c.text;
        case "landing":
          return `%${c.n}`;
        case "brace":
          return c.open ? "{" : "}";
        case "newline":
          return "\\n";
        case "tab":
          return "\\t";
        case "typeslot":
          return "%t";
        case "bodybreak":
          return "%b";
        case "pattern":
          return "%p";
        default:
          return `<UNRESOLVED:${c.k}>`;
      }
    })
    .join("");
}

/** Parse a single-entry source and return that entry. */
function one(src: string) {
  const entries = parseSource(src);
  expect(entries.length).toBe(1);
  return entries[0]!;
}

describe("count expansion — index ([%d], FPLT bank)", () => {
  const ex = expandCounts(one("````STKWR-BGS\n[%d]\n````\n@count FPLT"));

  it("fans out to 16 entries (0..15)", () => {
    expect(ex.length).toBe(16);
    expect(ex.map((e) => e.count)).toEqual([...Array(16).keys()]);
  });

  it("count 0 is the bare stroke -> [0]", () => {
    expect(ex[0]!.stroke).toBe("STKWR-BGS");
    expect(show(ex[0]!.template)).toBe("[0]");
  });

  it("non-zero counts merge bank keys and render the number", () => {
    expect(ex[1]!.stroke).toBe("STKWR-FBGS"); // +F
    expect(show(ex[1]!.template)).toBe("[1]");
    expect(ex[15]!.stroke).toBe("STKWR-FPBLGTS"); // +F,P,L,T
    expect(show(ex[15]!.template)).toBe("[15]");
  });
});

describe("count expansion — repeat with computed landings (param list)", () => {
  // %(d+1): with 0-based iteration this yields %1, %2, %3 — name %0 stays free.
  const ex = expandCounts(one("````STKWR-PBGS/-FLT\n(%[, |%(d+1)%])\n````\n@count AOEU"));

  it("count 0 -> empty parens, bare second stroke", () => {
    expect(ex[0]!.stroke).toBe("STKWR-PBGS/-FLT");
    expect(show(ex[0]!.template)).toBe("()");
  });

  it("count 3 -> three comma-joined landings, merged stroke", () => {
    expect(ex[3]!.stroke).toBe("STKWR-PBGS/AOFLT"); // A|O merged into -FLT
    expect(show(ex[3]!.template)).toBe("(%1, %2, %3)");
  });

  it("the separator is a joiner (no trailing comma)", () => {
    expect(show(ex[1]!.template)).toBe("(%1)");
  });
});

describe("count expansion — switch-shaped (per-iteration landings)", () => {
  const src =
    "````STKWR-FP\nswitch(%0) {%b%[case %(2d+1):\\n%(2d+2)\\nbreak;\\n%]}\n````\n@count RBGS\n@multiline";
  const ex = expandCounts(one(src));

  it("two cases get distinct landing pairs", () => {
    expect(show(ex[2]!.template)).toBe(
      "switch(%0) {%bcase %1:\\n%2\\nbreak;\\ncase %3:\\n%4\\nbreak;\\n}",
    );
  });

  it("a computed landing going negative is a hard error", () => {
    // %(2d-1) with 0-based iteration is -1 on the first case.
    const bad = "````STKWR-FP\n{%b%[%(2d-1)%]}\n````\n@count RBGS";
    expect(() => expandCounts(one(bad))).toThrow(/< 0/);
  });
});

describe("count expansion — pass-through and misconfiguration", () => {
  it("a non-count entry passes through unchanged", () => {
    const ex = expandCounts(one("````STKWR-LG\nconsole.log(%0)\n````"));
    expect(ex.length).toBe(1);
    expect(ex[0]!.count).toBeNull();
    expect(ex[0]!.stroke).toBe("STKWR-LG");
    expect(show(ex[0]!.template)).toBe("console.log(%0)");
  });

  it("@count without a count operator is an error", () => {
    expect(() => expandCounts(one("````X\nhello\n````\n@count AOEU"))).toThrow(
      /no count operator/,
    );
  });

  it("a count operator without @count is an error", () => {
    expect(() => expandCounts(one("````X\n[%d]\n````"))).toThrow(/no @count/);
    expect(ExpandError).toBeTruthy();
  });
});
