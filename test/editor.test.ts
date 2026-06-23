import { describe, it, expect } from "vitest";
import {
  type Event,
  PLAIN,
  SMART,
  SMART_INDENT,
  interpret,
  movementEvents,
  serialize,
} from "../src/editor.ts";

/** Render an editor state as "buffer" with a ‹› cursor marker for readability. */
function show(events: Event[], b: Parameters<typeof interpret>[1]): string {
  const s = interpret(events, b);
  return s.buffer.slice(0, s.rest) + "‹›" + s.buffer.slice(s.rest);
}
const type = (s: string): Event[] => [{ k: "text", s }];

describe("interpret — PLAIN (dumb editor)", () => {
  it("types everything literally, no auto-close", () => {
    expect(show(type("a(b)c"), PLAIN)).toBe("a(b)c‹›");
  });
  it("Enter just inserts a newline at the cursor", () => {
    expect(show([{ k: "text", s: "a" }, { k: "key", key: "Enter", n: 1 }, { k: "text", s: "b" }], PLAIN)).toBe(
      "a\nb‹›",
    );
  });
});

describe("interpret — SMART (auto-close, type-over, block-expand)", () => {
  it("auto-closes an opener and sits between the pair", () => {
    expect(show(type("("), SMART)).toBe("(‹›)");
  });
  it("types over a closer the editor already supplied", () => {
    expect(show(type("()"), SMART)).toBe("()‹›");
  });
  it("nests auto-closers, then types over them", () => {
    expect(show(type("foo(("), SMART)).toBe("foo((‹›))"); // both pairs auto-closed
    expect(show(type("foo(()"), SMART)).toBe("foo(()‹›)"); // final ) steps over the inner
  });
  it("without auto-indent, Enter is a bare newline (no expansion)", () => {
    expect(show([{ k: "text", s: "{" }, { k: "key", key: "Enter", n: 1 }], SMART)).toBe("{\n‹›}");
  });
  it("< is not auto-closed", () => {
    expect(show(type("Promise<"), SMART)).toBe("Promise<‹›");
  });
});

describe("interpret — SMART_INDENT (adds auto-indent)", () => {
  it("block-expands with an indented body line and dedented close", () => {
    expect(show([{ k: "text", s: "{" }, { k: "key", key: "Enter", n: 1 }], SMART_INDENT)).toBe(
      "{\n    ‹›\n}",
    );
  });
  it("a sibling Enter keeps the same indent level", () => {
    const evs: Event[] = [
      { k: "text", s: "{" }, // -> {} , block-expands
      { k: "key", key: "Enter", n: 1 }, // -> {\n\t\n}
      { k: "text", s: "a;" }, // body line
      { k: "key", key: "Enter", n: 1 }, // sibling line, same indent
    ];
    expect(show(evs, SMART_INDENT)).toBe("{\n    a;\n    ‹›\n}");
  });
  it("Backspace removes one indent char (one dedent level)", () => {
    const evs: Event[] = [
      { k: "text", s: "{" },
      { k: "key", key: "Enter", n: 1 },
      { k: "key", key: "BackSpace", n: 1 },
    ];
    expect(show(evs, SMART_INDENT)).toBe("{\n‹›\n}");
  });
});

describe("serialize", () => {
  it("a mark never splits a text span (the space before %0( stays literal)", () => {
    const evs: Event[] = [
      { k: "text", s: "function " },
      { k: "mark", n: 0 },
      { k: "text", s: "()" },
    ];
    expect(serialize(evs)).toBe("function ()");
  });
  it("a trailing space (before a key) is protected", () => {
    const evs: Event[] = [
      { k: "text", s: "x " },
      { k: "key", key: "Left", n: 1 },
    ];
    expect(serialize(evs)).toBe("x{^ ^}{#Left}");
  });
  it("Enter serializes as \\n and breaks {#...} groups", () => {
    const evs: Event[] = [
      { k: "text", s: "a" },
      { k: "key", key: "Enter", n: 1 },
      { k: "key", key: "Up", n: 2 },
      { k: "key", key: "End", n: 1 },
    ];
    expect(serialize(evs)).toBe("a\\n{#Up Up End}");
  });
});

describe("movementEvents", () => {
  it("same line: straight Left", () => {
    // buffer "abcdef", from end (6) to col 2
    expect(serialize(movementEvents("abcdef", 6, 2))).toBe("{#Left Left Left Left}");
  });
  it("cross line: Up then End then Left", () => {
    // buffer "abc\nde", from end (6=line1 col2) to (line0 col1)
    expect(serialize(movementEvents("abc\nde", 6, 1))).toBe("{#Up End Left Left}");
  });
  it("no move when from == to", () => {
    expect(movementEvents("abc", 2, 2)).toEqual([]);
  });
});
