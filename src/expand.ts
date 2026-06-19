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
import { addKey, applyCount, countBank } from "./steno.ts";

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

// ---------------------------------------------------------------------------
// Pass B — type-append.
//
// A construct's single %t is filled by appending type strokes. Arity-0 types
// terminate immediately; an arity-N generic stays NON-TERMINAL until N args are
// appended. Non-terminal steps accumulate the type as bracketless space-joined
// tokens ("Map", "Map string"); the terminal step renders the real brackets
// ("Map<string, number>"). Nesting (a generic as a generic's arg) is out of
// scope, so generic args are drawn from a restricted arity-0 pool.
// ---------------------------------------------------------------------------

export interface TypeDef {
  stroke: string;
  arity: number;
  /** Rendered text with %t arg markers, e.g. "string" or "Map<%t, %t>". */
  text: string;
}

export interface TypedEntry {
  stroke: string;
  template: Chunk[];
  /** False = non-terminal step (later passes drop bracing and skip movement). */
  terminal: boolean;
  /** True = the U one-liner variant (every %b collapses instead of breaking). */
  oneLiner?: boolean;
  count: number | null;
  source: Entry;
}

export interface TypeOptions {
  /** Top-level types a %t may take (all of them, generics included). */
  types: TypeDef[];
  /** Types usable as a generic's argument (arity-0 only; no nesting). */
  genericArgs: TypeDef[];
}

function typeName(t: TypeDef): string {
  const i = t.text.indexOf("<");
  return i === -1 ? t.text : t.text.slice(0, i);
}

function renderType(t: TypeDef, args: string[]): string {
  let i = 0;
  return t.text.replace(/%t/g, () => args[i++] ?? "");
}

function partialType(t: TypeDef, args: string[]): string {
  return args.length ? `${typeName(t)} ${args.join(" ")}` : typeName(t);
}

interface Filling {
  suffix: string[];
  text: string;
  terminal: boolean;
}

function* fillArgs(
  t: TypeDef,
  suffix: string[],
  args: string[],
  pool: TypeDef[],
): Generator<Filling> {
  for (const a of pool) {
    const sfx = [...suffix, a.stroke];
    const ar = [...args, renderType(a, [])];
    if (ar.length === t.arity) {
      yield { suffix: sfx, text: renderType(t, ar), terminal: true };
    } else {
      yield { suffix: sfx, text: partialType(t, ar), terminal: false };
      yield* fillArgs(t, sfx, ar, pool);
    }
  }
}

function* fillings(opts: TypeOptions): Generator<Filling> {
  for (const t of opts.types) {
    if (t.arity === 0) {
      yield { suffix: [t.stroke], text: renderType(t, []), terminal: true };
    } else {
      yield { suffix: [t.stroke], text: partialType(t, []), terminal: false };
      yield* fillArgs(t, [t.stroke], [], opts.genericArgs);
    }
  }
}

function withType(template: Chunk[], slot: number, text: string): Chunk[] {
  const out = template.slice();
  out[slot] = { k: "lit", text };
  return out;
}

/** Build the type-append chain for one count-expanded entry. */
export function expandTypesOne(entry: ExpandedEntry, opts: TypeOptions): TypedEntry[] {
  const slot = entry.template.findIndex((c) => c.k === "typeslot");
  if (slot === -1) {
    return [{ ...entry, terminal: true }];
  }
  if (entry.template.slice(slot + 1).some((c) => c.k === "typeslot")) {
    throw new ExpandError(`"${entry.stroke}" has more than one %t (unsupported)`);
  }

  const out: TypedEntry[] = [
    // base: the skeleton before any type is appended (non-terminal)
    { ...entry, template: withType(entry.template, slot, ""), terminal: false },
  ];
  for (const f of fillings(opts)) {
    out.push({
      ...entry,
      stroke: `${entry.stroke}/${f.suffix.join("/")}`,
      template: withType(entry.template, slot, f.text),
      terminal: f.terminal,
    });
  }
  return out;
}

export function expandTypes(entries: ExpandedEntry[], opts: TypeOptions): TypedEntry[] {
  return entries.flatMap((e) => expandTypesOne(e, opts));
}

function renderTypeText(template: Chunk[]): string {
  return template
    .map((c) => {
      if (c.k === "lit") return c.text;
      if (c.k === "typeslot") return "%t";
      throw new ExpandError(`@type entry has an unexpected chunk "${c.k}"`);
    })
    .join("");
}

/** Collect the @type entries into the append set (full set + arity-0 pool). */
export function buildTypeSet(entries: Entry[]): { types: TypeDef[]; arity0: TypeDef[] } {
  const types: TypeDef[] = [];
  const noArg = new Set<string>();
  for (const e of entries) {
    if (!e.isType) continue;
    const text = renderTypeText(e.template);
    if (text === "") continue; // SKP (empty/skip type) — colon handling still TBD
    types.push({ stroke: e.strokeRaw, arity: e.arity ?? 0, text });
    if (e.noArg) noArg.add(e.strokeRaw);
  }
  // Generic-arg pool = arity-0 types that are realistic as type arguments.
  const arity0 = types.filter((t) => t.arity === 0 && !noArg.has(t.stroke));
  return { types, arity0 };
}

/**
 * Line-expansion flag: every TERMINAL entry that contains a %b (and isn't a
 * forced-multiline construct) also gets a U-keyed one-liner variant where the
 * body break collapses. The default (no U) stays multi-line.
 */
export function expandLineFlag(entries: TypedEntry[]): TypedEntry[] {
  const out: TypedEntry[] = [];
  for (const e of entries) {
    out.push(e); // default: multi-line
    const hasBreak = e.template.some((c) => c.k === "bodybreak");
    if (e.terminal && hasBreak && !e.source.multiline) {
      const segs = e.stroke.split("/");
      const i = segs.length - 1;
      segs[i] = addKey(segs[i]!, "U");
      out.push({ ...e, stroke: segs.join("/"), oneLiner: true });
    }
  }
  return out;
}

/**
 * Full Pass A + Pass B + line-flag over a parsed dictionary. @type entries become
 * the append set (consumed, not emitted); generic args use the full arity-0 pool.
 */
export function expandDict(entries: Entry[], genericArgStrokes?: string[]): TypedEntry[] {
  const { types, arity0 } = buildTypeSet(entries);
  const pool = genericArgStrokes
    ? arity0.filter((t) => genericArgStrokes.includes(t.stroke))
    : arity0;
  const opts: TypeOptions = { types, genericArgs: pool };
  const typed = entries
    .filter((e) => !e.isType)
    .flatMap(expandCounts)
    .flatMap((e) => expandTypesOne(e, opts));
  return expandLineFlag(typed);
}
