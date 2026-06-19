import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSource } from "../src/parse.ts";
import { expandDict } from "../src/expand.ts";
import { renderPlain, buildPlainDict } from "../src/render.ts";

const dictText = readFileSync(fileURLToPath(new URL("../dict.steno", import.meta.url)), "utf8");
const typed = expandDict(parseSource(dictText));
const byStroke = new Map(typed.map((e) => [e.stroke, e]));

describe("renderPlain", () => {
  it("terminal: emits braces, escapes, and movement back to %0", () => {
    const e = byStroke.get("STKWR-PBGS/TPH-FLT")!; // fused: number-returning function
    const { key, value } = renderPlain(e);
    expect(key).toBe("STKWR-PBGS/TPH-FLT");
    expect(value).toBe(
      "{^}function (): number \\{\\n\\}{#Up End Left Left Left Left Left Left Left Left Left Left Left Left}{^}",
    );
  });

  it("non-terminal: drops all bracing and emits no movement", () => {
    const e = byStroke.get("STKWR-PBGS/PH-FLT")!; // Map head — non-terminal
    expect(e.terminal).toBe(false);
    const { value } = renderPlain(e);
    expect(value).not.toContain("{#"); // no movement
    expect(value).not.toMatch(/[()[\]<>]/); // auto-paired delimiters stripped ({} ok: {^} / {^ ^})
  });

  it("a single-line terminal lands with no {#Up} (same line)", () => {
    const e = byStroke.get("STKWR-BGS")!; // [%d] count 0 -> [0], no %0 -> no movement
    const { value } = renderPlain(e);
    expect(value).toBe("{^}[0]{^}");
  });
});

describe("full plain dict", () => {
  const { dict, collisions } = buildPlainDict(typed);

  it("builds with no value collisions", () => {
    expect(collisions).toEqual([]);
  });

  it("reports its real serialized size", () => {
    const json = JSON.stringify(dict);
    const keys = Object.keys(dict).length;
    // eslint-disable-next-line no-console
    console.log(
      `plain.json: ${keys} keys, ${(json.length / 1e6).toFixed(2)} MB serialized ` +
        `(${typed.length} entries before dedupe)`,
    );
    expect(keys).toBeGreaterThan(1000);
  });
});
