# Language servers — errors after every write

A builder agent ([builder.md](builder.md)) gets the compiler's verdict
on a file the moment it writes it. After `file_write` or `file_patch`
the tool result carries the errors a language server found — the same
programs VS Code runs behind its red squiggles — so the model fixes the
mistake in the same step instead of finding it when the tests run.

```json
{
  "path": "/home/me/code/app/src/history.ts",
  "replacements": 1,
  "errors": [
    "ERROR [42:11] Property 'finishedAt' does not exist on type 'SwitchEntry'."
  ],
  "errors_in_other_files": {
    "src/api.ts": ["ERROR [17:5] Expected 2 arguments, but got 1."]
  },
  "language_server": "typescript",
  "hint": "Fix these before moving on — they are the compiler's word, not a guess."
}
```

Errors only (severity *error*), at most 10 per file with a trailer for
the rest, and up to 5 other files whose verdict changed because of this
write — a renamed function breaks its callers, and the builder hears it
at once. Warnings are left out on purpose: a small model chases them
instead of the task. A clean file says `"hint": "No errors in this
file."` so the builder can trust it.

Chat agents never see any of this: the hook asks the server only for a
builder session, and a builder without a language server for the file's
language gets a plain result, as before.

## Which servers

| id | files | server | install |
|---|---|---|---|
| `typescript` | `.ts .tsx .js .jsx .mjs .cjs .mts .cts` | `typescript-language-server` (with `typescript@5`) | `somora lsp install typescript` |
| `pyright` | `.py .pyi` | `pyright-langserver` | `somora lsp install pyright` |

`somora lsp install` (no id) installs both; `somora lsp status` shows
what is found and where. The servers are installed with npm into
`~/.somora/lsp/` — nothing touches the system's global packages — and
found in this order: the `command` in config, `~/.somora/lsp`, then
`PATH`. Nothing is downloaded during a turn: a missing server means no
errors on the result, and the builder's environment block says so
(`pyright — not installed (somora lsp install pyright)`).

## How it runs

- One server process per project root and language, started when a
  builder first reads or writes a matching file (a read pre-warms it,
  so the first write does not wait for the cold start), stopped after
  ten idle minutes or when somora shuts down.
- The root is the nearest folder at or above the file with a marker
  (`tsconfig.json`, `package.json`, `pyproject.toml`, `setup.py`, …,
  `.git`), never above the pinned project folder. Pyright is pointed at
  the project's `.venv/bin/python` when there is one.
- After a write the server gets the new text and somora waits for its
  verdict on that file: `lsp.waitMs` (default 3 s), longer for a
  project's first verdict (the server loads the project). No verdict in
  time → no errors on the result, one log line, the turn goes on.
- A server that fails to start is left alone for ten minutes, then
  tried again.
- The servers live in the main somora process; the file tools ask over
  loopback HTTP (`POST /lsp/diagnostics`), so the MCP child that serves
  claude-cli and codex-cli gets the same verdicts.

## Config

```yaml
lsp:
  enabled: true          # off = no server is started, results as before
  waitMs: 3000           # wait for a verdict after a write (ms)
  servers:
    typescript:
      enabled: true
      # command: /usr/local/bin/typescript-language-server   # instead of ~/.somora/lsp or PATH
    pyright:
      enabled: true
```

## Routes

- `POST /lsp/diagnostics` `{agent, session, path, touch?}` →
  `{diagnostics: {server, errors, errors_in_other_files} | null}`; with
  `touch: true` only starts the server for that file (`{touched: true}`).
  `null` for a chat agent, a disabled feature, a file without a server,
  or no verdict in time.
- `GET /lsp/status` → `{enabled, waitMs, servers: [{id, title,
  extensions, enabled, command, source}], running: [{id, root, alive,
  docs, idleMs}]}`.
