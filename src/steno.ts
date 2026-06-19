// Steno stroke mechanics for the count-expansion pass.
//
// A count bank "floats": when a construct's count is non-zero, the bank's keys
// are merged into one sub-stroke and the result must be re-rendered in canonical
// English steno order. e.g. STKWR-PBGS/-FLT with 3 params -> STKWR-PBGS/AOFLT.
//
// Canonical order (single stroke):  # | S T K P W H R | A O * E U | F R P B L G T S D Z
// The hyphen appears only to separate right-bank keys when there is no middle
// (vowel or *) to do it. With a middle present, no hyphen.

export const LEFT_ORDER = ["S", "T", "K", "P", "W", "H", "R"] as const;
export const MID_ORDER = ["A", "O", "*", "E", "U"] as const;
export const RIGHT_ORDER = ["F", "R", "P", "B", "L", "G", "T", "S", "D", "Z"] as const;

const MID_SET = new Set<string>(MID_ORDER);
const LEFT_SET = new Set<string>(LEFT_ORDER);
const RIGHT_SET = new Set<string>(RIGHT_ORDER);

export interface StrokeKeys {
  num: boolean;
  left: Set<string>;
  mid: Set<string>;
  right: Set<string>;
}

export class StrokeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrokeError";
  }
}

/** Parse one sub-stroke (no `/`) into its canonical key sets. */
export function parseStroke(s: string): StrokeKeys {
  const keys: StrokeKeys = { num: false, left: new Set(), mid: new Set(), right: new Set() };
  let str = s;
  if (str.startsWith("#")) {
    keys.num = true;
    str = str.slice(1);
  }

  const hy = str.indexOf("-");
  if (hy !== -1) {
    if (str.indexOf("-", hy + 1) !== -1) throw new StrokeError(`two hyphens in "${s}"`);
    const before = str.slice(0, hy);
    const after = str.slice(hy + 1);
    for (const ch of before) {
      if (MID_SET.has(ch)) keys.mid.add(ch);
      else if (LEFT_SET.has(ch)) keys.left.add(ch);
      else throw new StrokeError(`bad left/mid key "${ch}" in "${s}"`);
    }
    for (const ch of after) {
      if (RIGHT_SET.has(ch)) keys.right.add(ch);
      else throw new StrokeError(`bad right key "${ch}" in "${s}"`);
    }
    return keys;
  }

  // No hyphen: split at the first middle key (vowel or *). Without any middle,
  // the whole stroke is left-bank.
  let firstMid = -1;
  for (let i = 0; i < str.length; i++) {
    if (MID_SET.has(str[i]!)) {
      firstMid = i;
      break;
    }
  }
  if (firstMid === -1) {
    for (const ch of str) {
      if (LEFT_SET.has(ch)) keys.left.add(ch);
      else throw new StrokeError(`bad left key "${ch}" in "${s}"`);
    }
    return keys;
  }

  let i = 0;
  for (; i < firstMid; i++) {
    const ch = str[i]!;
    if (LEFT_SET.has(ch)) keys.left.add(ch);
    else throw new StrokeError(`bad left key "${ch}" in "${s}"`);
  }
  for (; i < str.length && MID_SET.has(str[i]!); i++) keys.mid.add(str[i]!);
  for (; i < str.length; i++) {
    const ch = str[i]!;
    if (RIGHT_SET.has(ch)) keys.right.add(ch);
    else throw new StrokeError(`bad right key "${ch}" in "${s}" (mid key after right keys?)`);
  }
  return keys;
}

/** Render canonical key sets back to a sub-stroke string. */
export function renderStroke(k: StrokeKeys): string {
  const left = LEFT_ORDER.filter((c) => k.left.has(c)).join("");
  const mid = MID_ORDER.filter((c) => k.mid.has(c)).join("");
  const right = RIGHT_ORDER.filter((c) => k.right.has(c)).join("");
  const body = right && !mid ? `${left}-${right}` : `${left}${mid}${right}`;
  return (k.num ? "#" : "") + body;
}

export interface CountBank {
  /** Bank keys with their bit weights, lowest first. */
  bits: { key: string; weight: number; side: "mid" | "right" }[];
  /** Inclusive max count the bank can encode (2^width - 1). */
  max: number;
}

/**
 * Build a count bank from an `@count` spec.
 *
 * CONVENTION (assumed; flag if wrong): the spec lists keys LSB-first, so the
 * i-th listed key carries weight 2^i. This matches the existing notes
 * AOEU=>(1,2,4,8), RBGS=>(1,2,4,8), FPLT=>(...<16). A key is a vowel if it is in
 * the middle bank (A O E U), otherwise it is treated as a right-bank key.
 */
export function countBank(spec: string): CountBank {
  const keys = [...spec];
  const bits = keys.map((key, i) => {
    if (!MID_SET.has(key) && !RIGHT_SET.has(key)) {
      throw new StrokeError(`@count key "${key}" is not a vowel or right-bank key`);
    }
    const side = MID_SET.has(key) ? ("mid" as const) : ("right" as const);
    return { key, weight: 1 << i, side };
  });
  return { bits, max: (1 << keys.length) - 1 };
}

/** Merge the keys encoding `count` (per `spec`) into one sub-stroke segment. */
export function applyCount(segment: string, spec: string, count: number): string {
  const bank = countBank(spec);
  if (count < 0 || count > bank.max) {
    throw new StrokeError(`count ${count} out of range for bank "${spec}" (0..${bank.max})`);
  }
  const keys = parseStroke(segment);
  for (const { key, weight, side } of bank.bits) {
    if ((count & weight) === 0) continue;
    const target = side === "mid" ? keys.mid : keys.right;
    if (target.has(key)) {
      throw new StrokeError(`count key "${key}" already present in "${segment}"`);
    }
    target.add(key);
  }
  return renderStroke(keys);
}
