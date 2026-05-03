# File tools

`file_read`, `file_write`, `file_patch`, and `file_search` work on the
local filesystem by default and on any configured remote resource via
the `target` parameter.

## The `target` parameter

Every file tool accepts:

```
target: "local" | "<resource-name>"
```

- `local` (default) — the somora server's own filesystem.
- a resource name from `resource_list` — operates over SSH (SFTP for
  read/write/patch, remote-exec'd ripgrep for search).

The model picks the target. It never picks the SSH transport, auth, or
host-key handling — those are all server-side.

## Path resolution

- **Relative paths** resolve against the agent's workspace dir
  (per-agent `workspace.path` in `agent.yaml`, falling back to
  `config.workspace.default` which auto-creates `~/somoraworkspace` at
  first start).
- **Absolute paths** pass through.
- **`~/`** expands to `$HOME` on local; remote uses `~` literally
  (interpreted by the remote shell on exec, by `resource.workspace` for
  SFTP).

## The path-blacklist (write side)

`file_write` and `file_patch` refuse to touch anything under:

```
System/credentials:
  /etc, /usr, /boot, /sys, /proc, /dev,
  /etc/shadow, /etc/sudoers, /etc/ssh
  ~/.ssh, ~/.gnupg, ~/.aws/credentials, ~/.kube/config

somora-internal:
  ~/.somora/known_hosts.json                  (SSH trust file)
  ~/.somora/agents/*/sessions/                (any agent's session JSONL +
                                               meta — append-only, managed
                                               by the storage layer)
```

Symlink escapes are caught: each write resolves the closest existing
ancestor with `realpath` and re-checks the policy on the resolved path.

**What's INTENTIONALLY allowed**:

- `~/.somora/agents/<any-agent>/{AGENTS,SOUL,USER}.md` — including
  OTHER agents' persona files. Cross-agent editing is by design;
  agents collaboratively shape each other's behaviour, not just their
  own.
- `~/.somora/agents/<any-agent>/agent.yaml` — operator config. Same
  cross-agent rule.
- `~/.somora/agents/<any-agent>/memory/notes/*.md` — memory notes.
- `~/.somora/config.yaml` — global server config.

The blacklist exists to prevent footguns (system corruption, leaked
credentials) and to protect the data formats somora's own storage
layer manages (session JSONL, the SSH known-hosts file). Within those
limits, agents are trusted.

The read side has a smaller blacklist — only credential files and
`/etc/shadow`-class secrets. Other paths read freely.

## Steering the model away from `exec`

Every file tool description ends with: "Use this INSTEAD of running
`cat`/`echo`/`grep`/`sed` via exec — file_* paginates safely, has no
quoting issues, works the same locally and over SSH (SFTP)." This is
deliberate policy: in cross-engine tool design, the orchestrator
prefers tools whose description tells it when to pick them.

When the future `exec` tool lands, its description will mirror this in
reverse: "use file_* for read/write/patch/search; exec is for things
the file tools can't do (run a build, start a server, etc.)".

## Limits

| Tool | Cap | Notes |
|---|---|---|
| `file_read` | 200 000 chars per call | Use `offset`+`limit` for larger files. |
| `file_write` | none on input; 100 000 char result envelope | Atomic via tmp+rename. |
| `file_patch` | requires `old_string` to be unique unless `replace_all=true` | Match is byte-exact (no fuzzy). |
| `file_search` | 50 hits default, 500 max; 200 000 char result envelope | Needs `rg` (ripgrep) on the target machine. |

`rg` not installed → clear error: "Install via brew/apt/dnf/pacman or
set `$RG_BIN`." We deliberately don't ship a JS fallback walker —
parity with rg's defaults (.gitignore-respect, encoding handling) is
worth the dependency.

## Examples (what the agent sees)

```jsonc
// Local read
{ "name": "file_read", "input": { "path": "notes.md" } }
// → reads <workspace>/notes.md

// Remote read
{ "name": "file_read", "input": { "path": "/tmp/log.txt", "target": "mac-studio" } }
// → SFTP read via the mac-studio resource

// Remote search
{ "name": "file_search", "input": { "pattern": "TODO", "path": "src/", "target": "mac-studio" } }
// → ssh mac-studio 'rg --json --max-count 50 "TODO" /home/.../src/'
```
