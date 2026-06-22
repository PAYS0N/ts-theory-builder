import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSource } from "../src/parse.ts";
import { expandDict } from "../src/expand.ts";
import { renderSnippet, buildSnippets, SENTINEL_OPEN, SENTINEL_CLOSE } from "../src/snippet.ts";

const dictText = readFileSync(fileURLToPath(new URL("../dict.steno", import.meta.url)), "utf8");
const typed = expandDict(parseSource(dictText));
const byStroke = new Map(typed.map((e) => [e.stroke, e]));
const get = (s: string) => byStroke.get(s)!;

describe("renderSnippet — tabstops", () => {
  it("a function: landings renumber to tab order, body is the ${0} exit", () => {
    const { keyId, body, terminal } = renderSnippet(get("STKWR-PBGS/TPH-FLT"));
    expect(keyId).toBe("STKWR-PBGS/TPH-FLT");
    expect(terminal).toBe(true);
    // %0 name -> $1, %1 param -> $2, %2 body (highest) -> $0
    expect(body).toBe("function ${1}(${2}): number {\n${0}\\}");
  });

  it("a single-landing construct puts it at ${0}", () => {
    // template literal `${%0}` -> backtick + literal $ + { + ${0} + } + backtick
    expect(renderSnippet(get("STKWR-LT")).body).toBe("`\\${${0}\\}`");
  });

  it("the U one-liner keeps the body on one line", () => {
    const { body } = renderSnippet(get("STKWRUPBGS/TPH-FLT"));
    expect(body).not.toContain("\n");
    expect(body).toBe("function ${1}(${2}): number {${0}\\}");
  });

  it("a free-type (SKP) leaves a tabstop at the type slot", () => {
    // function %0(%1): %t {%b%2} with the type slot a synthesized landing
    const { body } = renderSnippet(get("STKWR-PBGS/SKP-FLT"));
    expect(body).toContain("): ${"); // a tabstop sits where the type goes
    expect(body.match(/\$\{\d\}/g)!.length).toBe(4); // name, param, type, body
  });
});

describe("renderSnippet — non-terminals (pre-function partials)", () => {
  it("emit bracket-stripped partial text with no tabstops", () => {
    const e = get("STKWR-PBGS/PR-FLT"); // Promise head — non-terminal
    expect(e.terminal).toBe(false);
    const { body } = renderSnippet(e);
    expect(body).toBe("function : Promise ");
    expect(body).not.toContain("$"); // no tabstops in a partial
  });
});

describe("renderSnippet — escaping", () => {
  it("escapes $, }, and \\ in literal text but emits tabstops raw", () => {
    const { body } = renderSnippet(get("STKWR-LT"));
    expect(body).toContain("\\$"); // literal $ from the template literal
    expect(body).toContain("\\}"); // literal closing brace
    expect(body).toContain("${0}"); // the tabstop is raw
  });
});

describe("buildSnippets", () => {
  const { ploverKeys, snippets, collisions } = buildSnippets(typed);

  it("builds with no keyset collisions", () => {
    expect(collisions).toEqual([]);
  });

  it("the Plover dict maps a stroke to its sentinel-wrapped token", () => {
    expect(ploverKeys["STKWR-PBGS/TPH-FLT"]).toBe(
      `${SENTINEL_OPEN}STKWR-PBGS/TPH-FLT${SENTINEL_CLOSE}`,
    );
  });

  it("every Plover token resolves to a snippet body", () => {
    for (const token of Object.values(ploverKeys)) {
      const key = token.slice(SENTINEL_OPEN.length, -SENTINEL_CLOSE.length);
      expect(snippets[key]).toBeDefined();
    }
  });

  it("reports its size", () => {
    const bytes = JSON.stringify(snippets).length + JSON.stringify(ploverKeys).length;
    // eslint-disable-next-line no-console
    console.log(
      `nvim artifacts: ${Object.keys(snippets).length} snippets, ` +
        `${(bytes / 1e6).toFixed(2)} MB combined`,
    );
    expect(Object.keys(snippets).length).toBeGreaterThan(1000);
  });
});
