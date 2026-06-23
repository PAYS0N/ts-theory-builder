import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSource } from "../src/parse.ts";
import { emitStruct, structText } from "../src/struct.ts";
import { interpret, SMART_INDENT } from "../src/editor.ts";

const dictText = readFileSync(fileURLToPath(new URL("../dict.steno", import.meta.url)), "utf8");
const structs = parseSource(dictText).filter((e) => e.literal);

/** The buffer an auto-indent editor should end with: tabs -> 4 spaces, and the
 * blank separator lines removed (the v2 emitter skips blanks). */
function intended(raw: string): string {
  return raw
    .split("\n")
    .map((l) => {
      let d = 0;
      while (l[d] === "\t") d++;
      return "    ".repeat(d) + l.slice(d);
    })
    .filter((l) => l.trim() !== "")
    .join("\n");
}

describe("emitStruct — reproduces every @literal block under a smart editor", () => {
  it("found the data-structure entries", () => {
    expect(structs.length).toBeGreaterThan(5);
  });

  for (const e of structs) {
    it(`reproduces ${e.strokeRaw}`, () => {
      const got = interpret(emitStruct(e.template), SMART_INDENT).buffer;
      expect(got).toBe(intended(structText(e.template)));
    });
  }
});

describe("emitStruct — keystroke shape", () => {
  it("types opening lines and navigates, never typing a bare closing brace", () => {
    const e = structs.find((x) => x.strokeRaw === "STKWR-RBGT/S")!;
    const events = emitStruct(e.template);
    // No text event is a lone `}` (closers are auto-supplied or appended onto).
    for (const ev of events) if (ev.k === "text") expect(ev.s).not.toBe("}");
    // It uses Down/End navigation to exit nested blocks.
    expect(events.some((ev) => ev.k === "key" && ev.key === "Down")).toBe(true);
  });
});
