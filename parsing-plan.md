# Parsing & JSON-Generation Plan

> How the human-intent notation in `snippets.txt` / `snippets2.txt` becomes a
> committed Plover JSON dictionary. This is a **proposal for review** — no code
> yet. It defines (1) a strict, parsable source format, (2) the template DSL
> grammar, (3) the compiler passes that expand one template into many literal
> Plover entries, (4) the indent-independent movement compiler, and (5) JSON
> output + validation.

---

## 0. Why the current files are not parsable yet

- Stroke→template pairing is implied by line order and fence formatting, not a
  defined grammar.
- Count banks, bit-weights, and arities live in prose comments (`snippets.txt`
  lines 1, 109, 118, 159), not machine-readable directives.
- Operators (`%d`, `%[ %]`, `%(expr)`, `%t`) have intent but no precise contract
  (e.g. `%[ sep | body %]` separator semantics were never written out).
- Terminal vs non-terminal emission (the typing model) is not encoded at all.

The plan replaces these implicit conventions with explicit ones, **without
changing the authoring feel** — fenced `STROKE` / template pairs stay.

---

## 1. Pipeline overview

```
source (.steno)                                  one source entry can fan out to
   │  parse                                       dozens of dictionary entries
   ▼
AST entries  ──►  PASS A: count expansion (%d, %[ %] repeat, %(expr))
              ──►  PASS B: type-append expansion (%t chains, arity, terminal flag)
              ──►  PASS C: profile application (smart-brace, %b newline toggle)
              ──►  PASS D: movement compilation (final-stroke-only Up/End/Left)
              ──►  PASS E: serialization to Plover control text
   ▼
validate (collisions, max-count, reversibility)
   ▼
<profile>.json   (Plover dictionary: { "STROKE/STROKE": "value", ... })
```

Order matters: **movement is compiled LAST** (Pass D), after count/type/profile
have produced the final rendered text, so the geometry it measures is real.

---

## 2. Source format (formalized, authoring-friendly)

Keep the fenced style; pin it down. Each **entry** is a fence line whose content
is the canonical stroke, followed by exactly one template line:

```
````STKWR-PBGS/-FLT````
function %0(%[%d, %]): %t {%b%2}
```

Two new **directive** kinds, attached to the entry immediately above:

```
@count AOEU                 # this entry's %d count bank, listed MSB..LSB-agnostic;
                            # weights derived from the FIXED LSB-toward-middle rule
@arity 2                    # only on TYPE entries: type-arg count (Map=2, etc.)
```

- Lines starting `//` or `#` are comments.
- `@count <keys>`: the physical keys forming the count bank for this construct.
  Because the bit-significance convention is fixed (LSB nearest the board middle,
  reading left-to-right), the compiler computes each key's weight from its board
  position — the author only lists *which* keys, never the weights. The compiler
  emits a warning if the listed keys don't form a contiguous, unambiguous bank.
- `@arity N`: declares a type's arity (default 0). Lives on entries in the type
  set, whose templates use `%t` as arg placeholders (`Map<%t, %t>` ⇒ `@arity 2`).

(Alternative considered: move source to YAML. Rejected for now — the fenced form
is closer to how the user already thinks in strokes, and the directives give us
all the structure a parser needs.)

---

## 3. Template DSL grammar (EBNF)

```
template   = { chunk } ;
chunk      = literal | escape | landing | dcount | typeslot | bodybreak
           | repeat | pattern | computed ;
literal    = ? any run of chars except '%' '{' '}' '\' '`' ? ;
escape     = "\{" | "\}" | "\n" | "\t" | "\\" | "\%" ;
landing    = "%" digit ;                 (* %0 .. %9 ordered landing points *)
dcount     = "%d" ;                       (* count chosen by the @count bank *)
typeslot   = "%t" ;                       (* filled by an appended type stroke *)
bodybreak  = "%b" ;                       (* toggleable newline (brace body break)*)
pattern    = "%p" ;                       (* destructuring slot, count-bank driven *)
repeat     = "%[" sep "|" body "%]"       (* canonical: explicit separator        *)
           | "%[" body "%]" ;             (* shorthand: leading ", " sep inferred  *)
computed   = "%(" expr ")" ;              (* e.g. %(2d-1): index from count d      *)
expr       = ? small integer arithmetic over 'd' and literals ? ;
```

**Operator contracts (resolving the inconsistencies flagged in context.md §3):**

- `%[ sep | body %]` — repeat `body` `d` times (d from the count bank), joined by
  `sep`. **`sep` is a joiner: emitted between items only, never after the last**
  (no trailing comma). `%[%d, %]` is shorthand for `%[ ", " | <one slot> %]`.
- `%(expr)` — integer arithmetic over `d` for derived indices. Switch uses
  `%(2d-1)` / `%(2d)` to number per-case landings.
- `%digit` — ordered landing points. **Plain profile: cursor lands on `%0` only.**
  Higher numbers are retained as *positions* for the future snippet/Vim profile
  (`$1..$0` tabstops) but produce no movement now.
- `%b` — newline toggle. Smart-brace profile: expands to `\n` + the editor's
  auto-indent; one-liner contexts: expands to empty. (`switch`/`case` always
  multi-line regardless — a per-entry `multiline: true` flag overrides.)
- `%t` — return-type slot, filled by the **append chain**, not free-typed.

---

## 4. Intermediate representation

```ts
type Entry = {
  stroke: Stroke[];          // ["STKWR-PBGS", "-FLT"]  (split on '/')
  template: Chunk[];         // parsed AST
  countBank?: KeyBank;       // from @count
  arity?: number;            // from @arity (type entries)
  multiline?: boolean;
};
type Chunk =
  | { k: "lit"; text: string }
  | { k: "landing"; n: number }
  | { k: "dcount" }
  | { k: "typeslot" }
  | { k: "bodybreak" }
  | { k: "pattern" }
  | { k: "repeat"; sep: Chunk[]; body: Chunk[] }
  | { k: "computed"; expr: Expr };
```

A `KeyBank` maps each listed key to a weight via board geometry under the fixed
LSB-toward-middle convention; max representable count is clamped to **9**.

---

## 5. Compiler passes

### Pass A — count expansion (`%d`, `%p`, `%[ %]`, `%(expr)`)
For an entry whose template references the count `d`:
1. Enumerate `d ∈ 1..9` (and `0` where meaningful).
2. For each `d`: append the count-bank keys encoding `d` to the stroke
   (merging into the appropriate stroke segment per the construct's float-key
   placement), and expand every `%[ %]` / `%p` to exactly `d` items with `sep`
   as a joiner, and evaluate every `%(expr)` at that `d`.
3. Result: one IR entry per count value. Each distinct count is a literal Plover
   entry (Plover has no arithmetic — this is the whole reason to enumerate).

### Pass B — type-append expansion (`%t`, arity, terminal flag)
For each entry containing `%t` (functions, get, Promise/Map/etc. returns):
1. Build the **append chain** by cross-producing the entry with every type in
   the type set, and — for generics — every legal *depth* of appended args up to
   its arity.
2. Each chain step is its own dictionary entry whose stroke = base + appended
   type strokes (`/STR`, `/STR/TPH`, …).
3. Mark the step **TERMINAL** iff the trailing type's arity is fully satisfied;
   otherwise **NON-TERMINAL**.
4. Emission rule by flag:
   - **NON-TERMINAL**: render accumulated text with **all auto-paired delimiters
     stripped** (no `(` `[` `{` `<` and no body braces) and **no movement** —
     only the established tokens, space-joined. This is what makes the
     delete→retype of the next stroke safe.
   - **TERMINAL**: render the full structure (delimiters included; closers left
     to the editor under the smart-brace profile) and hand off to Pass D for
     movement.
   - **RESOLVED (was CONFIRM):** non-terminal strokes **drop ALL bracing** —
     `(` `[` `{` `<` and their closers. Reason: a half-typed delimiter desyncs
     Plover's delete→retype (`"("` then editor's auto-`")"` → next stroke's
     backspace count is off), and emitting the full pair (`"()"`) only works if
     we encode editor-specific type-over behavior. Dropping all bracing avoids
     baking editor behavior into the chain. The `( , , )` / `{}` in the example
     are for human readability only. This rule is **profile-independent** (see
     Pass C: the type-append chain always behaves as if smart-brace).

### Pass C — profile application
Generate **two dictionaries**, one per profile:
- **smart-brace**: closing `)`, `]`, `}`, `>` are **not** emitted (editor
  supplies them); the compiler tracks them only as virtual columns for movement
  math.
- **plain (no smart brace)**: closers **are** emitted by the dictionary.

Two cross-cutting rules that are the **same in both** dictionaries:
- **The type-append chain (Pass B) always behaves as if smart-brace** — i.e. it
  drops all bracing on non-terminal strokes regardless of profile. Only the
  "string typing" (building up the type string) is forced to the smart-brace
  assumption; everything else honors the profile. This keeps the chain logic
  single-sourced and avoids a profile explosion inside the append machinery.
- **`%b` is the one-liner (`O`) toggle.** A template may contain several `%b`
  (e.g. `try {%b…} catch {%b…} finally {%b…}`); the `O` flag expands or contracts
  **all of them together** in that translation — they are not independent.
  Multi-line-only constructs (`switch`/`case`, data structures) ignore `O`.
- `%b` ⇒ `\n` (+ editor auto-indent) when expanded; empty when contracted.

(Profile list stays pluggable so the snippet/Vim profile can be added later
without touching Passes A/B.)

### Pass D — movement compilation (final-stroke-only, indent-independent)
Operates only on TERMINAL entries. Given the rendered multi-line text and the
chosen landing slot (`%0` in the plain profile):

```
lines      = render.split("\n")
cursorLine = lines.length - 1            # cursor rests at end of emitted text
slotLine   = line index containing %0
slotCol    = column of %0 within its line (chars BEFORE it on that line)
N = cursorLine - slotLine                # template constant: # lines to go up
K = len(lines[slotLine]) - slotCol       # template constant: chars from line END
                                         #   back to the slot
emit:  ("{#Up}" * N) + "{#End}" + ("{#Left}" * K)
```

- **Why indent-independent:** `K` is measured from the line **end** backward, so
  leading indentation (which varies with tab width) sits to the *left* of the
  slot and never enters the count. `N` is a line count, also tab-width-invariant.
  This is exactly context.md §4c, and it replaces the broken
  `{#Up}` + counted `{#Right}` scheme from `js.json`.
- `{#End}` normalizes the column after the `{#Up}`s (which may land in an
  arbitrary column), so a single backward `{#Left}` count is exact.
- Same-line landing ⇒ `N = 0`; the `{#Up}*0` vanishes and `{#End}{#Left}*K`
  remains.
- NON-TERMINAL entries get **no** movement (Pass D skips them) — enforced by
  validation below.

### Pass E — serialization
Render each IR entry's chunks to Plover control text:
- Prepend `{^}` to every value (no leading space attach).
- Literal brace/newline ⇒ `\{` / `\}` / `\n`; movement ⇒ `{#Up}` / `{#End}` /
  `{#Left}`.
- Join the stroke segments with `/` for the dictionary key.

---

## 6. JSON generation & validation

- Assemble `{ "<stroke key>": "<value>" }` for one profile → `<profile>.json`.
- **Collision check:** no two source entries (after full expansion) may produce
  the same stroke key with different values. Fail the build with the offending
  pair. (The float-key count banks exist precisely to avoid these; the validator
  proves it held.)
- **Max-count check:** a bank may use its full bit-width (4 keys → 0–15); the
  earlier "cap at 9" was only a file-size hedge, and §8 shows size is a non-issue,
  so banks are not capped below their width. The check just confirms each
  expansion stays within the bank's own width.
- **Landing-conflict check:** the compiler NEVER renumbers landings. Authors
  choose every landing explicitly (`%0` and `%(EXPR)` values); after expansion,
  if two landings in one translation collide — or a computed landing is negative —
  the build fails with the offending entry. No silent autocorrection.
  (The 0- vs 1-based iteration index, i.e. whether a slot is `%(d)` or `%(d+1)`,
  is an implementation detail of the count loop and is settled in Pass A, not
  baked into the source.)
- **Reversibility check:** assert no NON-TERMINAL entry contains any `{#…}`
  movement or any auto-paired delimiter — the safety invariant of the typing
  model, checked mechanically.
- **Determinism:** stable ordering so JSON diffs are reviewable.

---

## 7. Proposed implementation

- TypeScript (matches the repo). Pure functions per pass; the source `.steno`
  files are the only input, JSON the only committed output.
- Layout:
  ```
  src/parse/      tokenizer + grammar -> Entry[]
  src/expand/     passes A,B,C
  src/movement/   pass D (the geometry compiler) + unit tests
  src/emit/       pass E + JSON writer
  src/validate/   collision / max-count / reversibility
  bin/build.ts    source.steno -> <profile>.json
  ```
- **Tests first on Pass D** (movement) and Pass B (terminal/non-terminal) — the
  two places correctness is subtle and silent failures are worst. Golden-file
  tests: a handful of source entries with hand-verified expected JSON.

---

## 8. Size budget

Target: each generated JSON **< 2 MB** (hard cap 8 MB). The expansion multipliers
are small bases times bounded factors:

- **Count banks** multiply an entry by ≤ 10 (counts 0–9).
- **Type-append** multiplies a function/return entry by the type-set size
  (~18 simple + a few generics) × arity depth (≤ 2). Non-terminal chain prefixes
  add the intermediate steps but those are short strings.
- **Profiles** double the total (two files), but each file is counted on its own
  against the cap.
- **`O` one-liner**, where offered per-stroke, at most doubles the affected
  entries.

Worst-case envelope: functions ≈ 7 shapes × ≤10 param-counts × ~20 return types
≈ 1.4k terminal entries, + their chain prefixes, + everything else (if/else,
loops, switch counts, callbacks, classes, decls) in the low thousands. At
~100–150 bytes per `"key": "value"` pair that is **well under 300 KB per
profile** — comfortably inside the 2 MB target, with the 8 MB cap never in play.
Data structures are large *values* but tiny in *count* (~12 × 2 typed/untyped),
adding only tens of KB. **Answer: yes, current duplication stays under 2 MB.**
Validation should still emit the byte size per profile so regressions surface.

## 9. Inputs still needed from you (not blocking the plan)

1. Per-construct **count-bank key choices** (`@count` values): functions (AOEU?),
   index (SKWRAO), switch (RBGS), destructuring, super.
2. Resolve the three flagged slips: `TKPW` collision (bigint vs object),
   no-type `let`/`const` inversion, `.sort` block return slot.
3. Final **simple-type set** to include (object/any/unknown were provisional).
4. Whether `%b` in the smart-brace profile should also emit auto-indent spaces or
   trust the editor entirely (affects Pass D's `K` on the body line).
5. Untyped data-structure variants are described as "strip `<T>`" — confirm the
   compiler should derive them mechanically vs. authoring them separately.
