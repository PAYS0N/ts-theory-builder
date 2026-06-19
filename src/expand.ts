// Pass A — count expansion.
//
// Each @count entry fans out to one expanded entry per count value (0..bank.max):
// the bank keys are merged into the stroke, the %[ sep | body %] repeat is run
// `count` times, and %d / %(EXPR) are resolved. Entries without @count pass
// through unchanged. Type-slots (%t), body-breaks (%b), braces and landings are
// left for later passes.
//
// Scope of `d`:  total count outside a repeat, iteration index inside one.
// Iteration index is 0-based (ITERATION_BASE) — a one-line knob.

import type { Chunk, Entry } from "./parse.ts";
import { applyCount, countBank } from "./steno.ts";

export class ExpandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpandError";
  }
}

export interface ExpandedEntry {
  /** Full Plover key, e.g. "STKWR-PBGS/AOFLT". */
  stroke: string;
  /** Count-resolved chunks: no repeat/dcount/computed remain. */
  template: Chunk[];
  /** The count value, or null for a non-count entry. */
  count: number | null;
  source: Entry;
}

export const ITERATION_BASE = 0;

function usesCount(chunks: Chunk[]): boolean {
  return chunks.some((c) => c.k === "repeat" || c.k === "dcount" || c.k === "computed");
}

function resolve(chunks: Chunk[], scopeD: number, total: number): Chunk[] {
  const out: Chunk[] = [];
  for (const c of chunks) {
    switch (c.k) {
      case "dcount":
        out.push({ k: "lit", text: String(scopeD) });
        break;
      case "computed": {
        const n = c.expr.a * scopeD + c.expr.b;
        if (n < 0) {
          throw new ExpandError(`computed landing resolves to ${n} (< 0) at d=${scopeD}`);
        }
        out.push({ k: "landing", n });
        break;
      }
      case "repeat":
        for (let i = 0; i < total; i++) {
          const iterD = ITERATION_BASE + i;
          if (i > 0) out.push(...resolve(c.sep, iterD, total));
          out.push(...resolve(c.body, iterD, total));
        }
        break;
      default:
        out.push(c);
    }
  }
  return out;
}

/** Expand one entry over its count bank (or pass through if it has no @count). */
export function expandCounts(entry: Entry): ExpandedEntry[] {
  const uses = usesCount(entry.template);

  if (entry.count == null) {
    if (uses) {
      throw new ExpandError(`"${entry.strokeRaw}" uses a count operator but has no @count`);
    }
    return [{ stroke: entry.strokeRaw, template: entry.template, count: null, source: entry }];
  }

  if (!uses) {
    throw new ExpandError(`"${entry.strokeRaw}" has @count but no count operator in its template`);
  }
  const last = entry.stroke.length - 1;
  if (last < 0) throw new ExpandError(`"${entry.strokeRaw}" has an empty stroke`);

  const bank = countBank(entry.count);
  const out: ExpandedEntry[] = [];
  for (let d = 0; d <= bank.max; d++) {
    const merged = applyCount(entry.stroke[last]!, entry.count, d);
    const stroke = [...entry.stroke.slice(0, last), merged].join("/");
    out.push({ stroke, template: resolve(entry.template, d, d), count: d, source: entry });
  }
  return out;
}

/** Expand a whole parsed dictionary. */
export function expandAll(entries: Entry[]): ExpandedEntry[] {
  return entries.flatMap(expandCounts);
}
