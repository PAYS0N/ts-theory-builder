import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTemplate, parseSource, StenoError, type Chunk } from "../src/parse.ts";

describe("parseTemplate — primitives", () => {
  it("plain literal", () => {
    expect(parseTemplate("console.log(x)")).toEqual([{ k: "lit", text: "console.log(x)" }]);
  });

  it("landings, count, type-slot, body-break, pattern", () => {
    expect(parseTemplate("%0%d%t%b%p")).toEqual([
      { k: "landing", n: 0 },
      { k: "dcount" },
      { k: "typeslot" },
      { k: "bodybreak" },
      { k: "pattern" },
    ]);
  });

  it("multi-digit landings are two separate single-digit landings", () => {
    // %12 is %1 then literal "2" — landings are single digit by design.
    expect(parseTemplate("%12")).toEqual([{ k: "landing", n: 1 }, { k: "lit", text: "2" }]);
  });

  it("structural braces become brace chunks; %b stays separate", () => {
    expect(parseTemplate("{%b}")).toEqual([
      { k: "brace", open: true },
      { k: "bodybreak" },
      { k: "brace", open: false },
    ]);
  });

  it("escapes: \\{ \\} \\% \\\\ \\` become literals; \\n \\t become chunks", () => {
    expect(parseTemplate("\\{\\}\\%\\\\\\`")).toEqual([{ k: "lit", text: "{}%\\`" }]);
    expect(parseTemplate("a\\nb\\tc")).toEqual([
      { k: "lit", text: "a" },
      { k: "newline" },
      { k: "lit", text: "b" },
      { k: "tab" },
      { k: "lit", text: "c" },
    ]);
  });
});

describe("parseTemplate — repeat", () => {
  it("sep | body form (param list)", () => {
    expect(parseTemplate("(%[, |%d%])")).toEqual([
      { k: "lit", text: "(" },
      { k: "repeat", sep: [{ k: "lit", text: ", " }], body: [{ k: "dcount" }] },
      { k: "lit", text: ")" },
    ] satisfies Chunk[]);
  });

  it("no-pipe form has empty separator", () => {
    const out = parseTemplate("%[case %(2d-1):\\nbreak;\\n%]");
    expect(out).toEqual([
      {
        k: "repeat",
        sep: [],
        body: [
          { k: "lit", text: "case " },
          { k: "computed", expr: { a: 2, b: -1 } },
          { k: "lit", text: ":" },
          { k: "newline" },
          { k: "lit", text: "break;" },
          { k: "newline" },
        ],
      },
    ]);
  });

  it("a top-level | outside a repeat is a literal", () => {
    expect(parseTemplate("T | undefined")).toEqual([{ k: "lit", text: "T | undefined" }]);
  });

  it("nested repeats", () => {
    const out = parseTemplate("%[; |%[, |%p%]%]");
    expect(out).toEqual([
      {
        k: "repeat",
        sep: [{ k: "lit", text: "; " }],
        body: [{ k: "repeat", sep: [{ k: "lit", text: ", " }], body: [{ k: "pattern" }] }],
      },
    ]);
  });
});

describe("parseTemplate — computed", () => {
  it.each([
    ["%(d)", { a: 1, b: 0 }],
    ["%(2d)", { a: 2, b: 0 }],
    ["%(2d-1)", { a: 2, b: -1 }],
    ["%(2d+1)", { a: 2, b: 1 }],
    ["%(-d)", { a: -1, b: 0 }],
    ["%(5)", { a: 0, b: 5 }],
    ["%( 2d - 1 )", { a: 2, b: -1 }],
  ])("%s -> %o", (src, expr) => {
    expect(parseTemplate(src)).toEqual([{ k: "computed", expr }]);
  });
});

describe("parseTemplate — errors", () => {
  it.each([
    ["%z", /unknown operator %z/],
    ["abc%", /trailing '%'/],
    ["a\\", /trailing backslash/],
    ["x\\q", /unknown escape \\q/],
    ["%[a", /unterminated %\[/],
    ["%(2d", /unterminated %\(/],
    ["%(zz)", /bad computed expression/],
  ])("%s throws", (src, re) => {
    expect(() => parseTemplate(src)).toThrow(re);
  });
});

describe("parseSource", () => {
  const src = [
    "# a comment",
    "// another",
    "",
    "````STKWR-PBGS/-FLT",
    "function %0(%[, |%d%]): %t {%b%2}",
    "````",
    "@count AOEU",
    "",
    "````PH",
    "Map<%t, %t>",
    "````",
    "@arity 2",
    "",
    "````STKWR-FP",
    "switch (%0) {%b}",
    "````",
    "@multiline",
  ].join("\n");

  it("parses entries, splits strokes, attaches directives to the entry above", () => {
    const entries = parseSource(src);
    expect(entries.map((e) => e.strokeRaw)).toEqual(["STKWR-PBGS/-FLT", "PH", "STKWR-FP"]);

    const fn = entries[0];
    expect(fn.stroke).toEqual(["STKWR-PBGS", "-FLT"]);
    expect(fn.count).toBe("AOEU");
    expect(fn.arity).toBeUndefined();

    expect(entries[1].arity).toBe(2);
    expect(entries[2].multiline).toBe(true);
  });

  it("preserves multi-line literal blocks verbatim", () => {
    const block = ["````X", "class A {", "\tx = 1;", "}", "````"].join("\n");
    const [e] = parseSource(block);
    expect(e.raw).toBe("class A {\n\tx = 1;\n}");
    // first chunk is the literal up to the first structural brace
    expect(e.template[0]).toEqual({ k: "lit", text: "class A " });
  });

  it.each([
    [["@count AOEU"].join("\n"), /directive before any entry/],
    [["````X", "unterminated"].join("\n"), /unterminated block/],
    [["````"].join("\n"), /closing fence without an open block/],
    [["junk line"].join("\n"), /unexpected text/],
    [["````X", "ok", "````", "@nope x"].join("\n"), /unknown directive @nope/],
    [["````X", "ok", "````", "@arity two"].join("\n"), /@arity needs a non-negative integer/],
  ])("rejects bad source", (bad, re) => {
    expect(() => parseSource(bad)).toThrow(re);
  });

  it("StenoError carries a line number", () => {
    try {
      parseSource("\n\njunk");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(StenoError);
      expect((e as StenoError).line).toBe(3);
    }
  });
});

describe("dict.steno", () => {
  const text = readFileSync(fileURLToPath(new URL("../dict.steno", import.meta.url)), "utf8");

  it("parses with no errors", () => {
    expect(() => parseSource(text)).not.toThrow();
  });

  it("has the expected entries and directives", () => {
    const entries = parseSource(text);
    const byStroke = new Map(entries.map((e) => [e.strokeRaw, e]));

    expect(entries.length).toBeGreaterThan(15);
    expect(byStroke.get("STKWR-PBGS/-FLT")?.count).toBe("AOEU");
    expect(byStroke.get("STKWR-BGS")?.count).toBe("FPLT");
    expect(byStroke.get("STKWR-FP")?.multiline).toBe(true);
    expect(byStroke.get("PR")?.arity).toBe(1);
    expect(byStroke.get("PH")?.arity).toBe(2);

    // the data-structure block round-trips and contains a brace chunk
    const stack = byStroke.get("STKWR-RBGT/S")!;
    expect(stack.raw).toContain("class Stack<T> {");
    expect(stack.template.some((c) => c.k === "brace")).toBe(true);
  });

  it("no entry uses an unknown operator (every % is consumed)", () => {
    // parseSource would already throw; this just asserts the corpus is non-trivial.
    const entries = parseSource(text);
    const total = entries.reduce((n, e) => n + e.template.length, 0);
    expect(total).toBeGreaterThan(50);
  });
});
