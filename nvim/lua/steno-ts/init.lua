-- steno-ts — expand Plover-emitted keyset tokens into LSP snippets.
--
-- Plover (loaded with out/plover-keys.json) types a sentinel-wrapped token such
-- as «STKWR-PBGS/TPH-FLT». This plugin watches insert mode, and when a complete
-- token appears it deletes the token and expands the matching snippet body from
-- out/snippets.json via Neovim's built-in `vim.snippet` (requires 0.10+).
--
-- The heavy lifting (counts, type-append, tabstop numbering) is done by the
-- compiler in this repo; this plugin is just the editor-side expander.

local M = {}

-- Must match SENTINEL_OPEN/CLOSE in src/snippet.ts. ASCII (Javelin-emittable),
-- non-auto-pairing, and never valid TS so it can't appear in real code.
local OPEN = "@@"
local CLOSE = "@@"

local config = {
  -- Path to the generated snippets.json (keyId -> LSP body).
  snippets_path = nil,
  -- Only expand in these buffers (empty = any buffer).
  filetypes = { "typescript", "javascript", "typescriptreact", "javascriptreact" },
}

local snippets = {} -- keyId -> body
local augroup = vim.api.nvim_create_augroup("StenoTs", { clear = true })

local function load_snippets(path)
  local fd = io.open(path, "r")
  if not fd then
    vim.notify("steno-ts: cannot read " .. tostring(path), vim.log.levels.ERROR)
    return false
  end
  local raw = fd:read("*a")
  fd:close()
  local ok, decoded = pcall(vim.json.decode, raw)
  if not ok then
    vim.notify("steno-ts: invalid JSON in " .. path, vim.log.levels.ERROR)
    return false
  end
  snippets = decoded
  return true
end

-- Return the keyId of a complete @@…@@ token ending exactly at the cursor, plus
-- the 0-indexed byte column where the token starts; or nil.
local function token_before_cursor()
  local line = vim.api.nvim_get_current_line()
  local col = vim.api.nvim_win_get_cursor(0)[2] -- 0-indexed byte col of cursor
  local prefix = line:sub(1, col)
  if prefix:sub(-#CLOSE) ~= CLOSE then
    return nil
  end
  -- Strip the trailing close first, so when OPEN == CLOSE the search below
  -- can't match the closing fence as if it were the opening one.
  local body = prefix:sub(1, #prefix - #CLOSE)
  local start, init = nil, 1
  while true do
    local i = body:find(OPEN, init, true)
    if not i then
      break
    end
    start = i
    init = i + #OPEN
  end
  if not start then
    return nil
  end
  local key = body:sub(start + #OPEN)
  return key, start - 1 -- start_col is 0-indexed
end

local function try_expand()
  if not vim.snippet then
    return
  end
  local key, start_col = token_before_cursor()
  if not key then
    return
  end
  local body = snippets[key]
  if not body then
    return
  end
  local row = vim.api.nvim_win_get_cursor(0)[1] - 1
  local end_col = vim.api.nvim_win_get_cursor(0)[2]
  -- Delete the token, then expand the snippet where it stood.
  vim.api.nvim_buf_set_text(0, row, start_col, row, end_col, { "" })
  vim.api.nvim_win_set_cursor(0, { row + 1, start_col })
  vim.snippet.expand(body)
end

local function attach_buffer()
  if #config.filetypes > 0 and not vim.tbl_contains(config.filetypes, vim.bo.filetype) then
    return
  end
  vim.api.nvim_create_autocmd("TextChangedI", {
    group = augroup,
    buffer = 0,
    callback = try_expand,
  })
end

function M.setup(opts)
  config = vim.tbl_extend("force", config, opts or {})
  if not config.snippets_path then
    vim.notify("steno-ts: set snippets_path to out/snippets.json", vim.log.levels.ERROR)
    return
  end
  if not load_snippets(config.snippets_path) then
    return
  end
  vim.api.nvim_create_autocmd("FileType", {
    group = augroup,
    pattern = #config.filetypes > 0 and config.filetypes or "*",
    callback = attach_buffer,
  })
  -- Attach to already-open buffers too.
  attach_buffer()
end

-- Exposed for manual triggering / tests.
M._try_expand = try_expand
M._token_before_cursor = token_before_cursor

return M
