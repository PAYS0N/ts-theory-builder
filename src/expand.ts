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
import { addKey, applyCount, countBank, mergeStrokes } from "./steno.ts";

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
  /** Empty type (SKP): a free/custom type — leaves `: ` and a tabstop to type by hand. */
  freeType?: boolean;
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
  freeType?: boolean;
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
    if (t.freeType) {
      yield { suffix: [t.stroke], text: "", terminal: true, freeType: true };
    } else if (t.arity === 0) {
      yield { suffix: [t.stroke], text: renderType(t, []), terminal: true };
    } else {
      yield { suffix: [t.stroke], text: partialType(t, []), terminal: false };
      yield* fillArgs(t, [t.stroke], [], opts.genericArgs);
    }
  }
}

function withTypes(template: Chunk[], slots: number[], texts: string[]): Chunk[] {
  const out = template.slice();
  slots.forEach((idx, i) => {
    out[idx] = { k: "lit", text: texts[i]! };
  });
  return out;
}

/**
 * Free-type fill: replace the type slot with a numbered tabstop above all existing
 * landings, so the plain profile still lands on %0 (the name) but the snippet
 * profile gets a stop at the type. The `: ` stays.
 */
function withFreeType(template: Chunk[], slot: number): Chunk[] {
  let max = -1;
  for (const c of template) if (c.k === "landing") max = Math.max(max, c.n);
  const out = template.slice();
  out[slot] = { k: "landing", n: max + 1 };
  return out;
}

function fillTemplate(template: Chunk[], slot: number, f: Filling): Chunk[] {
  return f.freeType ? withFreeType(template, slot) : withTypes(template, [slot], [f.text]);
}

/**
 * Multi-slot fill (typed params): every %t slot gets an arity-0 type from the
 * pool, appended one per slot. All slots must be filled to terminate.
 */
function expandMultiSlot(entry: ExpandedEntry, slots: number[], pool: TypeDef[]): TypedEntry[] {
  const m = slots.length;
  const out: TypedEntry[] = [
    { ...entry, template: withTypes(entry.template, slots, slots.map(() => "")), terminal: false },
  ];
  const rec = (chosen: TypeDef[]): void => {
    if (chosen.length > 0) {
      const texts = slots.map((_, i) => (chosen[i] ? renderType(chosen[i]!, []) : ""));
      out.push({
        ...entry,
        stroke: `${entry.stroke}/${chosen.map((t) => t.stroke).join("/")}`,
        template: withTypes(entry.template, slots, texts),
        terminal: chosen.length === m,
      });
    }
    if (chosen.length < m) for (const t of pool) rec([...chosen, t]);
  };
  rec([]);
  return out;
}

/** Build the type-append chain(s) for one count-expanded entry. */
export function expandTypesOne(entry: ExpandedEntry, opts: TypeOptions): TypedEntry[] {
  const slots = entry.template.flatMap((c, i) => (c.k === "typeslot" ? [i] : []));
  if (slots.length === 0) return [{ ...entry, terminal: true }];
  if (slots.length > 1) return expandMultiSlot(entry, slots, opts.genericArgs);

  const slot = slots[0]!;
  const out: TypedEntry[] = [];

  if (entry.source.fuse) {
    // Fuse the construct's last segment (the shape selector) into the first
    // appended type stroke, and drop the type-less base entirely.
    const segs = entry.stroke.split("/");
    const shape = segs[segs.length - 1]!;
    const root = segs.slice(0, -1);
    for (const f of fillings(opts)) {
      const first = mergeStrokes(f.suffix[0]!, shape);
      out.push({
        ...entry,
        stroke: [...root, first, ...f.suffix.slice(1)].join("/"),
        template: fillTemplate(entry.template, slot, f),
        terminal: f.terminal,
      });
    }
    return out;
  }

  // base: the skeleton before any type is appended (non-terminal)
  out.push({ ...entry, template: withTypes(entry.template, [slot], [""]), terminal: false });
  for (const f of fillings(opts)) {
    out.push({
      ...entry,
      stroke: `${entry.stroke}/${f.suffix.join("/")}`,
      template: fillTemplate(entry.template, slot, f),
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
    const def: TypeDef = { stroke: e.strokeRaw, arity: e.arity ?? 0, text };
    if (text === "") def.freeType = true;
    types.push(def);
    if (e.noArg) noArg.add(e.strokeRaw);
  }
  // Generic-arg pool = arity-0 concrete types that are realistic as type arguments.
  const arity0 = types.filter((t) => t.arity === 0 && !t.freeType && !noArg.has(t.stroke));
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
      // The one-liner decision is made up front, so U rides the FIRST stroke
      // (the construct's base), not the final type stroke.
      const segs = e.stroke.split("/");
      segs[0] = addKey(segs[0]!, "U");
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
