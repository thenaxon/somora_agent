# Language servers

A builder agent hears the compiler's verdict on a file the moment it
writes it. somora runs language servers, the programs an editor uses
for its red squiggles, and puts the errors they find on the result of
the write. The model fixes a mistake in the same step and does not find
it only when the tests run.

## What you get

- **Errors on every write.** A builder's `file_write` and `file_patch`
  results list the errors in that file, with line and column.
- **Broken callers too.** When a write breaks other files, for example
  after a renamed function, their errors come along.
- **A clean file says so**, and the builder can trust it.
- **Errors only.** Warnings are left out on purpose: a small model
  chases them and loses the task.
- **Nothing changes for chat agents.** Only agents of kind builder get
  this.

## Install it

```bash
somora lsp install      # both servers
somora lsp status       # what is found, and where
```

The feature is on by default. The next write of a builder to a matching
file carries the verdict.

| id | Files | Server | npm packages |
|---|---|---|---|
| `typescript` | `.ts .tsx .js .jsx .mjs .cjs .mts .cts` | `typescript-language-server` | `typescript-language-server`, `typescript@5` |
| `pyright` | `.py .pyi` | `pyright-langserver` | `pyright` |

npm installs the servers into `~/.somora/lsp/`. Nothing touches the
system's global packages, and nothing is downloaded during a turn.

## What the builder sees

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

| Field | Meaning |
|---|---|
| `errors` | Errors in the written file. At most 10, then a line that counts the rest. |
| `errors_in_other_files` | Up to 5 other files whose errors changed with this write, at most 5 errors each. Paths are relative to the project folder. Each change is reported once. |
| `language_server` | The id of the server that answered. |
| `hint` | Tells the model to fix the errors first. A clean file gets `"hint": "No errors in this file."` |

The result has none of these fields when there is no verdict: no server
for the file type, server not installed or switched off, no answer in
time, or a file on a remote resource. The write itself succeeded.

The builder's environment block names the state of each server, so the
model knows what to expect: `typescript ✓`, `pyright — off`, or
`pyright — not installed (somora lsp install pyright)`.

## When a server runs

- **Start.** One process per project root and language, started when a
  builder first reads or writes a matching file. A read warms the
  server up, so the first write does not wait for the cold start.
- **Stop.** After ten idle minutes, or when somora shuts down.
- **Failed start.** A server that is missing or fails to start is left
  alone for ten minutes, then tried again.

The servers live in the main somora process. The file tools ask it over
loopback HTTP, so builders on the CLI engines (`claude-cli`,
`codex-cli`, `grok-cli`) get the same verdicts.

## The project root

The root is the nearest folder at or above the file that holds a marker
file, never above the session's project folder. Without a marker, the
project folder is the root.

| Server | Markers |
|---|---|
| `typescript` | `tsconfig.json`, `jsconfig.json`, `package.json`, `.git` |
| `pyright` | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `pyrightconfig.json`, `.git` |

TypeScript checks with the project's own `node_modules/typescript` when
there is one, else with the TypeScript 5 installed beside the server.
Pyright uses `<root>/.venv/bin/python` when it exists, else `python3`.

## How long a write waits

After a write, somora waits for the server's verdict on that file for
`lsp.waitMs`. The first verdict in a project root waits longer, because
the server loads the project first: at least 8 seconds for TypeScript
and 10 for Pyright.

No verdict in time means no errors on the result and one log line. The
turn goes on.

## Settings

```yaml
lsp:
  enabled: true
  waitMs: 3000
  servers:
    typescript:
      enabled: true
      # command: /usr/local/bin/typescript-language-server
    pyright:
      enabled: true
```

| Setting | Default | Meaning |
|---|---|---|
| `lsp.enabled` | `true` | `false` starts no server. Results are plain. |
| `lsp.waitMs` | `3000` | Wait for a verdict after a write, in ms. Allowed: 200 to 60000. |
| `lsp.servers.<id>.enabled` | `true` | `false` switches one server off. |
| `lsp.servers.<id>.command` | not set | Executable to run, started with `--stdio`. |

A server is looked up in this order: the `command` in the config,
`~/.somora/lsp`, then `PATH`.

## Commands

| Command | What it does |
|---|---|
| `somora lsp status` | One line per server: the path found and its source, or `not installed`. It does not read `command` from the config. |
| `somora lsp install` | Installs all servers, then prints the status. |
| `somora lsp install <id>` | Installs only the named servers, for example `somora lsp install typescript`. |

## Routes

| Route | Body | Answer |
|---|---|---|
| `POST /lsp/diagnostics` | `{agent, session, path, touch?}` | `{diagnostics: {server, errors, errors_in_other_files} \| null}` |
| `GET /lsp/status` | | `{enabled, waitMs, servers: [{id, title, extensions, enabled, command, source}], running: [{id, root, alive, docs, idleMs}]}` |

`POST /lsp/diagnostics` is what the file tools call. `path` must be
absolute.

- With `touch: true` it only starts the server for that file and
  answers `{diagnostics: null, touched: true}`.
- `diagnostics` is `null` for a chat agent (`reason: "not a builder"`),
  a disabled feature (`reason: "disabled"`), a file without a server,
  or no verdict in time.
- A bad body answers `400`, an unknown agent `404`.

In `GET /lsp/status`, `source` is `config`, `somora` or `path`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| No `errors` on a builder's write | Check `somora lsp status`. The agent must be of kind builder and the file local. |
| Still nothing right after an install | A missing server is retried after ten minutes per project root. Wait, or restart somora. |
| Errors missing in a large project | The verdict came too late: `lsp.no_diagnostics_in_time` in the log. Raise `lsp.waitMs`. |
| Server does not start | `lsp.init_failed` in the log names the reason. A start that takes over 20 seconds counts as failed. |
| TypeScript server reports nothing | It needs the classic `tsserver.js`, which TypeScript 7 does not ship. `somora lsp install typescript` adds TypeScript 5 beside the server. |

## See also

- [Builder agents](builder.md): the kind of agent that gets these
  errors
- [File tools](files.md): `file_write`, `file_patch` and `file_read`
- [API](api.md): every route
