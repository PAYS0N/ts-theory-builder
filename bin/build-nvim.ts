// Build the Neovim snippet artifacts from dict.steno.
//   node --experimental-strip-types bin/build-nvim.ts   (or: npm run build:nvim)
//
// Emits TWO files:
//   out/plover-keys.json  — a Plover dictionary: stroke -> «keyset token»
//   out/snippets.json     — keyset token -> LSP snippet body
// Plover stays a dumb lookup table (stroke -> token); the nvim plugin loads
// snippets.json and expands the token into a real snippet with tabstops.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSource } from "../src/parse.ts";
import { expandDict } from "../src/expand.ts";
import { buildSnippets } from "../src/snippet.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "out");

const entries = parseSource(readFileSync(join(root, "dict.steno"), "utf8"));
const { ploverKeys, snippets, collisions } = buildSnippets(expandDict(entries));

if (collisions.length > 0) {
  console.error(`ERROR: ${new Set(collisions).size} keyset collision(s):`);
  for (const k of new Set(collisions)) console.error(`  ${k}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

function writeJson(name: string, obj: Record<string, string>): number {
  const body = Object.entries(obj)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(",\n");
  const json = `{\n${body}\n}\n`;
  const path = join(outDir, name);
  writeFileSync(path, json);
  console.log(`Wrote ${path}`);
  console.log(`  ${Object.keys(obj).length} keys, ${(json.length / 1e6).toFixed(2)} MB`);
  return json.length;
}

const a = writeJson("plover-keys.json", ploverKeys);
const b = writeJson("snippets.json", snippets);
console.log(`  combined: ${((a + b) / 1e6).toFixed(2)} MB`);
