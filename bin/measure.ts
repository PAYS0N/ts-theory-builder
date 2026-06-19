// Size matrix: generic-arg pool x (full param counts vs. no-param functions).
//   node --experimental-strip-types bin/measure.ts
//
// "no-param" = function shapes carry no AOE param expansion; params would be
// added afterward by a separate STKWR-BGSD-style stroke (not counted here).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSource, parseTemplate, type Entry } from "../src/parse.ts";
import { expandDict } from "../src/expand.ts";
import { buildPlainDict } from "../src/render.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entries = parseSource(readFileSync(join(root, "dict.steno"), "utf8"));

const NOPARAM: Record<string, string> = {
  "STKWR-PBGS/-FLT": "function %0(): %t {%b%1}",
  "STKWR-PBGS/-R": "(): %t => {%b%0}",
  "STKWR-PBGS/-PL": "%0(): %t {%b%1}",
  "STKWR-PBGS/-PB": "async function %0(): Promise<%t> {%b%1}",
  "STKWR-PBGS/-D": "function* %0(): Generator<%t> {%b%1}",
  "STKWR-PBGS/-F": "(function %0(): %t {%b%1})();",
};
function noParams(es: Entry[]): Entry[] {
  return es.map((e) => {
    const t = NOPARAM[e.strokeRaw];
    return t ? { ...e, count: undefined, template: parseTemplate(t, e.line) } : e;
  });
}

const POOLS: [string, string[] | undefined][] = [
  ["all arity-0 (14)", undefined],
  ["str,num,bool,unknown,any (5)", ["STR", "TPH", "PW", "TPWH", "STKPWHR"]],
  ["str,num,bool (3)", ["STR", "TPH", "PW"]],
];

function measure(label: string, es: Entry[], pool: string[] | undefined): void {
  const { dict, collisions } = buildPlainDict(expandDict(es, pool));
  const mb = (JSON.stringify(dict).length / 1e6).toFixed(2);
  const warn = collisions.length ? `  (${new Set(collisions).size} collisions!)` : "";
  console.log(
    `  ${label.padEnd(32)} ${String(Object.keys(dict).length).padStart(6)} strokes  ${mb.padStart(6)} MB${warn}`,
  );
}

console.log("FULL params (functions keep AOE 0-7 param counts):");
for (const [label, pool] of POOLS) measure(label, entries, pool);
console.log("NO param strokes (params added later via a separate stroke):");
const np = noParams(entries);
for (const [label, pool] of POOLS) measure(label, np, pool);
