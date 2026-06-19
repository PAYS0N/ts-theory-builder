import { describe, it, expect } from "vitest";
import {
  parseStroke,
  renderStroke,
  countBank,
  applyCount,
  StrokeError,
} from "../src/steno.ts";

describe("parse/render round-trips", () => {
  // A representative spread of real sub-strokes from dict.steno.
  it.each([
    "STKWR", // left only
    "STKWR-PBGS", // left + right (hyphen)
    "-FLT", // right only (leading hyphen)
    "STKWR*F", // left + star + right
    "STKWR*PLT", // left + star + right
    "TH-R", // left + right (hyphen)
    "TPH", // left-only type stroke
    "SKWR", // left-only type stroke
    "PHAP", // left + vowel + right
    "TPEURLT", // left + 2 vowels + right
    "RAOUS", // left + 3 vowels + right
    "EFR", // vowel + right (no left)
    "SORT", // left + vowel + right
    "STKWR-FP", // switch base
    "STKWR-BGS", // index base
  ])("%s round-trips", (s) => {
    expect(renderStroke(parseStroke(s))).toBe(s);
  });

  it("rejects garbage keys", () => {
    expect(() => parseStroke("XYZ")).toThrow(StrokeError);
    expect(() => parseStroke("ST-K-R")).toThrow(/two hyphens/);
  });
});

describe("countBank", () => {
  it("weights keys LSB-first; max is 2^width - 1", () => {
    const aoeu = countBank("AOEU");
    expect(aoeu.bits.map((b) => [b.key, b.weight, b.side])).toEqual([
      ["A", 1, "mid"],
      ["O", 2, "mid"],
      ["E", 4, "mid"],
      ["U", 8, "mid"],
    ]);
    expect(aoeu.max).toBe(15);

    const rbgs = countBank("RBGS");
    expect(rbgs.bits.map((b) => [b.key, b.weight, b.side])).toEqual([
      ["R", 1, "right"],
      ["B", 2, "right"],
      ["G", 4, "right"],
      ["S", 8, "right"],
    ]);
  });

  it("rejects a non-vowel/right key", () => {
    expect(() => countBank("AOK")).toThrow(/not a vowel or right-bank key/);
  });
});

describe("applyCount", () => {
  it("merges vowel counts into a function terminal stroke", () => {
    // -FLT + count 3 (A=1 | O=2) -> vowels AO + right FLT -> AOFLT
    expect(applyCount("-FLT", "AOEU", 3)).toBe("AOFLT");
    expect(applyCount("-FLT", "AOEU", 0)).toBe("-FLT"); // count 0 adds nothing
    expect(applyCount("-FLT", "AOEU", 8)).toBe("UFLT"); // U=8
  });

  it("merges right-bank counts into the switch base", () => {
    // STKWR-FP + RBGS, count 15 -> right F,P + R,B,G,S -> F R P B G S
    expect(applyCount("STKWR-FP", "RBGS", 15)).toBe("STKWR-FRPBGS");
    expect(applyCount("STKWR-FP", "RBGS", 1)).toBe("STKWR-FRP"); // +R
  });

  it("merges right-bank counts into the index base", () => {
    // STKWR-BGS + FPLT, count 15 -> F,P,L,T + B,G,S -> F P B L G S T
    expect(applyCount("STKWR-BGS", "FPLT", 15)).toBe("STKWR-FPBLGTS");
    expect(applyCount("STKWR-BGS", "FPLT", 0)).toBe("STKWR-BGS");
  });

  it("rejects out-of-range counts and key collisions", () => {
    expect(() => applyCount("-FLT", "AOEU", 16)).toThrow(/out of range/);
    // F is already in the segment; a bank that re-adds F must error.
    expect(() => applyCount("STKWR-FP", "FPLT", 1)).toThrow(/already present/);
  });
});
