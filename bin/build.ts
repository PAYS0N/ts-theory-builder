// Build the Plover JSON dictionary from dict.steno.
//   node --experimental-strip-types bin/build.ts   (or: npm run build)
//
// Pipeline: parse -> Pass A (counts) -> Pass B (types) -> Pass C/D/E (render).
// Currently emits the PLAIN profile only.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSource } from "../src/parse.ts";
import { expandDict } from "../src/expand.ts";
import { buildPlainDict } from "../src/render.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcPath = join(root, "dict.steno");
const outDir = join(root, "out");
const outPath = join(outDir, "plain.json");

const entries = parseSource(readFileSync(srcPath, "utf8"));
const typed = expandDict(entries);
const { dict, collisions } = buildPlainDict(typed);

if (collisions.length > 0) {
  console.error(`ERROR: ${new Set(collisions).size} stroke collision(s):`);
  for (const k of new Set(collisions)) console.error(`  ${k}`);
  process.exit(1);
}

// One stroke per line — readable diffs, still valid JSON that Plover loads.
const body = Object.entries(dict)
  .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
  .join(",\n");
const json = `{\n${body}\n}\n`;

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, json);

console.log(`Wrote ${outPath}`);
console.log(`  ${Object.keys(dict).length} strokes, ${(json.length / 1e6).toFixed(2)} MB`);
