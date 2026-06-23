// Monaco fidelity harness — ground-truth for src/editor.ts.
//
//   node --experimental-strip-types bin/monaco-check.ts          (compare mode)
//   node --experimental-strip-types bin/monaco-check.ts --probe  (print Monaco)
//
// Serves Monaco from node_modules, drives it with real keystrokes via Playwright,
// and compares the resulting buffer+cursor to interpret(events, behaviors). The
// interpreter is the fast, pure model used everywhere else; this checks it
// against the real editor so the smart/auto-indent rules can be trusted.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { chromium, type Page } from "playwright";
import {
  type Behaviors,
  type Event,
  type KeyName,
  PLAIN,
  SMART,
  SMART_INDENT,
  interpret,
} from "../src/editor.ts";
import { parseSource } from "../src/parse.ts";
import { emitStruct } from "../src/struct.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const monacoMin = join(root, "node_modules", "monaco-editor", "min");

const HTML = `<!DOCTYPE html><html><body>
<div id="c" style="width:900px;height:600px"></div>
<script src="/vs/loader.js"></script>
<script>
  require.config({ paths: { vs: "/vs" } });
  require(["vs/editor/editor.main"], function () {
    // autoIndent only takes effect at construction, so recreate per behavior.
    window.__configure = function (opts) {
      if (window.__editor) window.__editor.dispose();
      var el = document.getElementById("c");
      el.innerHTML = "";
      window.__editor = monaco.editor.create(el, Object.assign({
        value: "", language: "typescript", automaticLayout: true,
        quickSuggestions: false, suggestOnTriggerCharacters: false,
        parameterHints: { enabled: false }, wordBasedSuggestions: "off",
        acceptSuggestionOnEnter: "off", tabCompletion: "off",
        formatOnType: false, formatOnPaste: false, autoSurround: "never",
        minimap: { enabled: false },
      }, opts.editor));
      window.__editor.getModel().updateOptions(opts.model);
      window.__editor.setPosition({ lineNumber: 1, column: 1 });
      window.__editor.focus();
    };
    window.__ready = true;
  });
</script></body></html>`;

function startServer(): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0]!;
    if (url === "/" || url === "/index.html") {
      res.setHeader("Content-Type", "text/html");
      res.end(HTML);
      return;
    }
    // /vs/* -> node_modules/monaco-editor/min/vs/*
    const file = normalize(join(monacoMin, url));
    if (!file.startsWith(monacoMin) || !existsSync(file)) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const ext = file.slice(file.lastIndexOf("."));
    const type =
      ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "application/octet-stream";
    res.setHeader("Content-Type", type);
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

const KEY: Record<string, string> = {
  Enter: "Enter",
  BackSpace: "Backspace",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Home: "Home",
  End: "End",
  Tab: "Tab",
};

async function configure(page: Page, b: Behaviors): Promise<void> {
  const opts = {
    editor: {
      autoClosingBrackets: b.autoClose ? "always" : "never",
      autoClosingQuotes: b.autoClose ? "always" : "never",
      autoClosingOvertype: b.typeOver ? "always" : "never",
      autoIndent: b.autoIndent ? "full" : "none",
    },
    model: { insertSpaces: b.indentUnit !== "\t", tabSize: b.indentUnit === "\t" ? 4 : b.indentUnit.length },
  };
  await page.evaluate(`window.__configure(${JSON.stringify(opts)})`);
  await page.waitForTimeout(40); // let the freshly-created editor lay out & focus
}

/** Javelin emits keystrokes with a ~5ms inter-key delay; replay at that cadence
 * so the harness faithfully reflects whether the editor keeps up in practice. */
const JAVELIN_DELAY = 5;

async function replay(page: Page, events: Event[]): Promise<void> {
  for (const ev of events) {
    if (ev.k === "mark") continue;
    if (ev.k === "text") await page.keyboard.type(ev.s, { delay: JAVELIN_DELAY });
    else for (let i = 0; i < ev.n; i++) await page.keyboard.press(KEY[ev.key]!, { delay: JAVELIN_DELAY });
  }
}

async function readState(page: Page): Promise<{ value: string; offset: number }> {
  return (await page.evaluate(`(() => {
    const ed = window.__editor, m = ed.getModel();
    return { value: m.getValue(), offset: m.getOffsetAt(ed.getPosition()) };
  })()`)) as { value: string; offset: number };
}

async function runMonaco(
  page: Page,
  events: Event[],
  b: Behaviors,
): Promise<{ value: string; offset: number }> {
  await configure(page, b);
  await replay(page, events);
  return readState(page);
}

function mark(buffer: string, offset: number): string {
  return JSON.stringify(buffer.slice(0, offset) + "‹›" + buffer.slice(offset));
}

const text = (s: string): Event => ({ k: "text", s });
const k = (key: KeyName, n = 1): Event => ({ k: "key", key, n });

interface Case {
  label: string;
  b: Behaviors;
  events: Event[];
}

const CASES: Case[] = [
  { label: "auto-close (", b: SMART, events: [text("(")] },
  { label: "type-over ()", b: SMART, events: [text("()")] },
  { label: "no auto-close < ", b: SMART, events: [text("Promise<")] },
  { label: "brace+Enter (SMART)", b: SMART, events: [text("{"), k("Enter")] },
  { label: "brace+Enter (INDENT)", b: SMART_INDENT, events: [text("{"), k("Enter")] },
  {
    label: "if-block+Enter (INDENT)",
    b: SMART_INDENT,
    events: [text("if (x) {"), k("Enter")],
  },
  {
    label: "nested brace x2 (INDENT)",
    b: SMART_INDENT,
    events: [text("{"), k("Enter"), text("a {"), k("Enter")],
  },
  {
    label: "sibling line (INDENT)",
    b: SMART_INDENT,
    events: [text("{"), k("Enter"), text("a;"), k("Enter"), text("b;")],
  },
  {
    label: "Backspace dedent (INDENT)",
    b: SMART_INDENT,
    events: [text("{"), k("Enter"), k("BackSpace")],
  },
  {
    label: "Down/End/Enter block-exit (INDENT)",
    b: SMART_INDENT,
    events: [text("{"), k("Enter"), text("a;"), k("Down"), k("End"), k("Enter"), text("b;")],
  },
  { label: "plain types literally", b: PLAIN, events: [text("a(b){"), k("Enter"), text("c")] },
];

// Real data structures: emitStruct keystrokes -> Monaco, vs the interpreter.
const dictSrc = readFileSync(join(root, "dict.steno"), "utf8");
for (const stroke of ["STKWR-RBGT/S", "STKWR-RBGT/HR", "STKWR-RBGT/TKHR"]) {
  const entry = parseSource(dictSrc).find((e) => e.strokeRaw === stroke);
  if (entry) CASES.push({ label: `struct ${stroke}`, b: SMART_INDENT, events: emitStruct(entry.template) });
}

async function main(): Promise<void> {
  const probe = process.argv.includes("--probe");
  const { url, close } = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction("window.__ready === true");

  let fails = 0;
  for (const c of CASES) {
    const got = await runMonaco(page, c.events, c.b);
    const pred = interpret(c.events, c.b);
    const ok = got.value === pred.buffer && got.offset === pred.rest;
    if (probe) {
      console.log(`\n${c.label}`);
      console.log(`  monaco:  ${mark(got.value, got.offset)}`);
      console.log(`  model:   ${mark(pred.buffer, pred.rest)}  ${ok ? "✓" : "✗ MISMATCH"}`);
    } else {
      console.log(`${ok ? "✓" : "✗"} ${c.label}`);
      if (!ok) {
        console.log(`    monaco: ${mark(got.value, got.offset)}`);
        console.log(`    model:  ${mark(pred.buffer, pred.rest)}`);
      }
    }
    if (!ok) fails++;
  }

  await browser.close();
  close();
  console.log(`\n${CASES.length - fails}/${CASES.length} match`);
  process.exit(fails > 0 && !probe ? 1 : 0);
}

main();
