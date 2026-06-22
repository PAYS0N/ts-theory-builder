// Build the Plover JSON dictionary from dict.steno.
//   node --experimental-strip-types bin/build.ts   (or: npm run build)
//
// Pipeline: parse -> Pass A (counts) -> Pass B (types) -> Pass C/D/E (render).
// Emits BOTH profiles: plain.json (dumb editor) and smart.json (auto-brace).
// Both load together on the device, so the real budget is their sum.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSource } from "../src/parse.ts";
import { expandDict } from "../src/expand.ts";
import { buildPlainDict, buildSmartDict, type BuildResult } from "../src/render.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcPath = join(root, "dict.steno");
const outDir = join(root, "out");

const entries = parseSource(readFileSync(srcPath, "utf8"));
const typed = expandDict(entries);

mkdirSync(outDir, { recursive: true });

function emit(name: string, { dict, collisions }: BuildResult): number {
  if (collisions.length > 0) {
    console.error(`ERROR (${name}): ${new Set(collisions).size} stroke collision(s):`);
    for (const k of new Set(collisions)) console.error(`  ${k}`);
    process.exit(1);
  }
  // One stroke per line — readable diffs, still valid JSON that Plover loads.
  const body = Object.entries(dict)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(",\n");
  const json = `{\n${body}\n}\n`;
  const outPath = join(outDir, `${name}.json`);
  writeFileSync(outPath, json);
  console.log(`Wrote ${outPath}`);
  console.log(`  ${Object.keys(dict).length} strokes, ${(json.length / 1e6).toFixed(2)} MB`);
  return json.length;
}

const plainBytes = emit("plain", buildPlainDict(typed));
const smartBytes = emit("smart", buildSmartDict(typed));
console.log(`  combined (both load on device): ${((plainBytes + smartBytes) / 1e6).toFixed(2)} MB`);
