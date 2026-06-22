import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSource } from "../src/parse.ts";
import { expandDict } from "../src/expand.ts";
import { renderSmart, renderPlain, buildSmartDict } from "../src/render.ts";

const dictText = readFileSync(fileURLToPath(new URL("../dict.steno", import.meta.url)), "utf8");
const typed = expandDict(parseSource(dictText));
const byStroke = new Map(typed.map((e) => [e.stroke, e]));
const get = (s: string) => byStroke.get(s)!;

describe("renderSmart — skeleton constructs", () => {
  it("a function drops the trailing } (editor auto-closes) and lands on %0", () => {
    const { key, value } = renderSmart(get("STKWR-PBGS/TPH-FLT"));
    expect(key).toBe("STKWR-PBGS/TPH-FLT");
    // opener `{` kept, trailing `\}` gone; cursor lands back on the name.
    expect(value).toBe(
      "{^}function (): number \\{\\n{#Up End Left Left Left Left Left Left Left Left Left Left Left Left}{^}",
    );
    expect(value).not.toContain("\\}"); // no typed closing brace
  });

  it("the interior ) is kept (passed via type-over), only the trailing closer drops", () => {
    // `(` and `)` both present so params land inside the parens correctly.
    const { value } = renderSmart(get("STKWR-PBGS/TPH-FLT"));
    expect(value).toContain("function ():");
  });

  it("the index drops its trailing ]", () => {
    expect(renderSmart(get("STKWR-BGS")).value).toBe("{^}[0{^}");
  });

  it("generics keep both angle brackets (< is not auto-closed in TS)", () => {
    expect(renderSmart(get("STKWR-T/PR/STR")).value).toBe("{^}Promise<string>{^}");
  });

  it("the template literal lands the cursor inside ${} with no movement", () => {
    // `${` typed -> editor gives `${}`; backtick + } dropped as trailing closers.
    expect(renderSmart(get("STKWR-LT")).value).toBe("{^}`$\\{{^}");
  });

  it("the U one-liner stays on one line and lands on %0", () => {
    const { value } = renderSmart(get("STKWRUPBGS/TPH-FLT"));
    expect(value).not.toContain("\\n");
    expect(value).toBe(
      "{^}function (): number \\{{#Left Left Left Left Left Left Left Left Left Left Left Left}{^}",
    );
  });
});

describe("renderSmart — parity rules", () => {
  it("non-terminal entries are byte-identical to plain", () => {
    const e = get("STKWR-PBGS/PR-FLT"); // Promise head — non-terminal
    expect(e.terminal).toBe(false);
    expect(renderSmart(e).value).toBe(renderPlain(e).value);
  });

  it("@literal data structures are byte-identical to plain", () => {
    for (const s of ["STKWR-RBGT/S", "STKWR-RBGT/HR", "STKWR-RBGT/KW"]) {
      expect(renderSmart(get(s)).value).toBe(renderPlain(get(s)).value);
    }
  });

  it("a bracket-free construct (ternary) is identical to plain", () => {
    expect(renderSmart(get("STKWR-RPBT")).value).toBe(renderPlain(get("STKWR-RPBT")).value);
  });
});

describe("full smart dict", () => {
  const { dict, collisions } = buildSmartDict(typed);

  it("builds with no value collisions", () => {
    expect(collisions).toEqual([]);
  });

  it("is no larger than the plain dict (drops closers, never adds)", () => {
    const json = JSON.stringify(dict);
    // eslint-disable-next-line no-console
    console.log(
      `smart.json: ${Object.keys(dict).length} keys, ${(json.length / 1e6).toFixed(2)} MB serialized`,
    );
    expect(Object.keys(dict).length).toBeGreaterThan(1000);
  });
});
