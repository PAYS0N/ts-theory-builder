# steno-ts (Neovim)

Editor-side expander for the steno TypeScript theory. Plover transmits *which
chord was pressed* as a keyset token; this plugin turns the token into a real
LSP snippet with tabstops — so the cursor lands and tabs natively, with none of
the `{#Up}{#Left}` movement hacks the Plover-only `plain`/`smart` dictionaries
need.

## How it fits together

```
chord ─► Plover (out/plover-keys.json)  stroke ─► «keyset token»
        types the token into the editor
                         │
                         ▼
      steno-ts plugin (out/snippets.json)  «token» ─► LSP snippet body
        detects the token, deletes it, vim.snippet.expand(body)
```

The compiler in this repo produces both files:

```sh
npm run build:nvim   # writes out/plover-keys.json and out/snippets.json
```

- Load **`out/plover-keys.json`** as a Plover dictionary (it maps every stroke to
  a `«…»` token).
- Point the plugin at **`out/snippets.json`** (token → snippet body).

## Install & configure

Requires Neovim **0.10+** (built-in `vim.snippet`). With lazy.nvim:

```lua
{
  dir = "/path/to/steno/nvim",          -- or a published repo
  config = function()
    require("steno-ts").setup({
      snippets_path = "/path/to/steno/out/snippets.json",
      -- filetypes = { "typescript", "javascript", ... },  -- default
    })
  end,
}
```

The plugin attaches a `TextChangedI` autocmd to matching buffers; when a complete
`«token»` appears at the cursor it deletes it and expands the snippet.

## Status & the chaining caveat

- **Single / fused strokes work cleanly** — functions, classes, control flow,
  declarations, ternary, the template literal, data structures: each is one
  terminal outline, so Plover emits one token and the plugin expands it.
- **Type-append chains through a *defined* non-terminal head** (e.g.
  `Promise` → `Promise<string>`) are the open edge: the non-terminal token
  expands to the "pre-function" partial, but Plover's retro-delete on the next
  stroke counts the *token* it typed, not the expanded snippet — so it can leave
  stray characters. Reconciling Plover's delete/retype with editor-side
  expansion needs validation against a live setup; expect to iterate here.

Non-terminal partials are intentionally included in `snippets.json` (the
"pre-function" style), per design — the caveat above is about the *chaining*
runtime, not the bodies themselves.
