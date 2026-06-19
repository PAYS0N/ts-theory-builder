import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSource, type Chunk } from "../src/parse.ts";
import {
  buildTypeSet,
  expandCounts,
  expandDict,
  expandTypesOne,
  type TypeDef,
  type TypeOptions,
} from "../src/expand.ts";

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
        case "bodybreak":
          return "%b";
        case "typeslot":
          return "<UNFILLED %t>";
        default:
          return `<${c.k}>`;
      }
    })
    .join("");
}

const NUMBER: TypeDef = { stroke: "TPH", arity: 0, text: "number" };
const STRING: TypeDef = { stroke: "STR", arity: 0, text: "string" };
const PROMISE: TypeDef = { stroke: "PR", arity: 1, text: "Promise<%t>" };
const MAP: TypeDef = { stroke: "PH", arity: 2, text: "Map<%t, %t>" };

const OPTS: TypeOptions = {
  types: [NUMBER, STRING, PROMISE, MAP],
  genericArgs: [NUMBER, STRING],
};

/** A simple %t-bearing construct (no count). */
function construct(template: string, stroke = "X") {
  const entry = parseSource(`\`\`\`\`${stroke}\n${template}\n\`\`\`\``)[0]!;
  const expanded = expandCounts(entry);
  expect(expanded.length).toBe(1);
  return expandTypesOne(expanded[0]!, OPTS);
}

describe("type-append chains", () => {
  const chain = construct("let a: %t = b");
  const byStroke = new Map(chain.map((e) => [e.stroke, e]));

  it("emits a non-terminal base before any type is appended", () => {
    const base = byStroke.get("X")!;
    expect(base.terminal).toBe(false);
    expect(show(base.template)).toBe("let a:  = b");
  });

  it("arity-0 types terminate immediately", () => {
    expect(byStroke.get("X/STR")!.terminal).toBe(true);
    expect(show(byStroke.get("X/STR")!.template)).toBe("let a: string = b");
  });

  it("arity-1 generic: non-terminal head, then terminal with the arg bracketed", () => {
    expect(byStroke.get("X/PR")!.terminal).toBe(false);
    expect(show(byStroke.get("X/PR")!.template)).toBe("let a: Promise = b");
    expect(byStroke.get("X/PR/STR")!.terminal).toBe(true);
    expect(show(byStroke.get("X/PR/STR")!.template)).toBe("let a: Promise<string> = b");
  });

  it("arity-2 generic: head and one-arg steps are non-terminal (bracketless)", () => {
    expect(byStroke.get("X/PH")!.terminal).toBe(false);
    expect(show(byStroke.get("X/PH")!.template)).toBe("let a: Map = b");

    expect(byStroke.get("X/PH/STR")!.terminal).toBe(false);
    expect(show(byStroke.get("X/PH/STR")!.template)).toBe("let a: Map string = b");

    expect(byStroke.get("X/PH/STR/TPH")!.terminal).toBe(true);
    expect(show(byStroke.get("X/PH/STR/TPH")!.template)).toBe("let a: Map<string, number> = b");
  });

  it("count: base + 2 arity-0 + Promise(1+2) + Map(1+2+4)", () => {
    expect(chain.length).toBe(1 + 2 + 3 + 7);
  });

  it("every terminal stroke is unique", () => {
    const strokes = chain.map((e) => e.stroke);
    expect(new Set(strokes).size).toBe(strokes.length);
  });
});

describe("type-append — no %t passes through", () => {
  it("a construct without %t yields one terminal entry", () => {
    const chain = construct("console.log(%0)");
    expect(chain.length).toBe(1);
    expect(chain[0]!.terminal).toBe(true);
  });
});

describe("type-append — generic wrapping a generic head is allowed (Promise<Map<...>>)", () => {
  it("the construct wrapper nests one appended generic", () => {
    const chain = construct("(): Promise<%t> => {}");
    const byStroke = new Map(chain.map((e) => [e.stroke, e]));
    expect(show(byStroke.get("X/PH/STR/TPH")!.template)).toBe(
      "(): Promise<Map<string, number>> => {}",
    );
  });
});

describe("full dict.steno — Pass A + B (all arity-0 as generic args)", () => {
  const text = readFileSync(fileURLToPath(new URL("../dict.steno", import.meta.url)), "utf8");
  const entries = parseSource(text);

  it("builds a type set with the expected arities", () => {
    const { types, arity0 } = buildTypeSet(entries);
    expect(types.find((t) => t.stroke === "PH")).toEqual({
      stroke: "PH",
      arity: 2,
      text: "Map<%t, %t>",
    });
    // 14 arity-0 types minus the 4 @noarg ones (null/undefined/never/function).
    expect(arity0.length).toBe(10);
    expect(arity0.find((t) => t.stroke === "STPHR")).toBeUndefined(); // never culled
  });

  it("expands end-to-end and reports its size", () => {
    const all = expandDict(entries);
    // Rough byte estimate: stroke key + value text + JSON punctuation.
    let bytes = 0;
    for (const e of all) {
      const value = e.template.reduce((n, c) => n + (c.k === "lit" ? c.text.length : 2), 0);
      bytes += e.stroke.length + value + 12;
    }
    // eslint-disable-next-line no-console
    console.log(
      `expandDict: ${all.length} entries, ~${(bytes / 1e6).toFixed(2)} MB/profile (pre-serialize estimate)`,
    );
    expect(all.length).toBeGreaterThan(1000);
  });

  it("a deep terminal type entry is present and correct", () => {
    const all = expandDict(entries);
    const e = all.find((x) => x.stroke === "STKWR-PBGS/PH-FLT/STR/TPH"); // shape fused into Map
    expect(e).toBeDefined();
    expect(e!.terminal).toBe(true);
    expect(show(e!.template)).toBe("function %0(%1): Map<string, number> {%b%2}");
  });
});
