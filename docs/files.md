# File tools

`file_read`, `file_write`, `file_patch`, `file_search`, `file_list` and
`analyze_file` work on the local filesystem by default and on any
configured remote resource via the `target` parameter (where
applicable — `analyze_file` is local-only).

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
- **`~/`** expands to `$HOME` on local. On a remote target `~` expands
  to the SSH user's home (and wins over `resource.workspace`); a bare
  relative path joins onto `resource.workspace`, or onto the SSH user's
  home when the resource sets none.

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

Every file tool description tells the model to use it instead of
running `cat`, `echo`, `grep` or `sed` through exec: the file tools
paginate safely, have no quoting issues, and work the same locally and
over SSH (SFTP). This is deliberate policy: in cross-engine tool
design, the orchestrator prefers tools whose description tells it when
to pick them.

The `exec` tool mirrors this in reverse — file_* for read, write,
patch and search; exec for what the file tools cannot do (run a build,
start a server, and the like).

## Multimodal: `file_read` polymorph + `analyze_file`

### `file_read` is polymorphic — text, image, or PDF

When pointed at a local file, `file_read` detects the format via magic
bytes and returns one of three things based on the file kind AND the
active model's capabilities:

| Detected | Active model has `image` cap? | Returned |
|---|---|---|
| Text | n/a | text content (paginated, 200k char cap) |
| Image (PNG/JPEG/WebP/GIF) | yes | image content block — model sees it directly |
| Image | no | error pointing at `analyze_file` |
| PDF | yes | each page rendered to PNG, returned as image-array (max 20 pages) |
| PDF | no | error pointing at `analyze_file` |
| Unknown binary | n/a | error with hint to inspect via `exec` first |

**PDF → PNG-page render.** MCP's tool-result content union has no
`document` type, so the polymorph rasterizes each page server-side
and ships them as `image` blocks. The model OCRs the page images
visually — same approach Anthropic uses internally for native PDF.
Token cost is real: ~1300 tokens per page on Anthropic, so a
30-page PDF costs ~40k tokens. For long PDFs prefer `analyze_file`.

**Capability gating** uses the active turn's resolved model. somora
passes the model through `ToolContext.activeModel` — set in-process
by the server's run-turn, set via `SOMORA_ACTIVE_MODEL` env var for
the MCP child process when claude-cli/codex-cli spawn it. Models
declare capabilities in their provider config (`capabilities:
[text, image, pdf, reasoning]`). file_read polymorph requires the
`image` capability for both image AND pdf paths because both deliver
as images post-rasterization. The `pdf` capability is meaningful for
`analyze_file` (which can talk to providers with native PDF support).

### `analyze_file` — the worker dispatcher

It is a **substitute for models that cannot see**, and only those. The
tool is not offered at all when the active model has the `image`
capability: an agent that can look at the file itself should, and a tool
it never sees is one it cannot pick by mistake.

It appears when:
- the active main model lacks `image` capability (text-only LLM) and you
  still need to reason about a file;
- targeted questions help — `analyze_file({path, prompt: "Which row of
  the table has the highest value?"})` lets the worker focus, the agent
  gets a sharp answer.

A described file is second-hand: the tool result names the worker, and
the agent is told to quote it rather than claim to have looked.

```yaml
# config.yaml — global vision worker config
vision:
  worker: openrouter/claude-haiku-4-5      # default for image + PDF
  pdfWorker: openrouter/claude-sonnet-4-6  # optional override for PDFs
```

`worker` also takes an **ordered list**, tried front to back until one
answers:

```yaml
vision:
  worker:
    - local/qwen-vision                    # preferred: free, stays in-house
    - openrouter/claude-haiku-4-5          # always available, costs money
  timeoutMs: 60000                         # per attempt, then move on
  totalBudgetMs: 90000                     # for the WHOLE chain
  maxOutputTokens: 1500                    # a caption is not a chat answer
  healthCacheMs: 60000                     # skip a just-failed worker this long
  timeoutCooldownMs: 10000                 # shorter: slow is not dead
```

Two budgets, because one was not enough. `timeoutMs` bounds a single
attempt and `totalBudgetMs` bounds the walk: each attempt gets whatever
is left, and a worker that could not finish in the remaining time is not
started; without it a chain of four workers spends four full timeouts
back to back. `maxOutputTokens`
overrides the worker model's own cap, which is a chat cap — with 16k
available, a reasoning worker thinks its way past the timeout while
writing three lines about a screenshot. A worker that returns nothing
with `finish_reason: length` says exactly that instead of "empty
response". A timeout cools a worker down for `timeoutCooldownMs` rather
than the full `healthCacheMs`, because slow and gone are different
things.

This exists because a locally hosted worker is only loaded while its GPU
profile is active; with a single configured value, switching profiles
takes `analyze_file` down for every agent at once and does so silently.
Entries that don't resolve, or that lack the capability the file needs,
are skipped rather than fatal — the point of a chain is surviving one
entry being unusable. The tool result names the worker that answered,
and lists the ones passed over when it wasn't the first.

### Switching to a model that can't see images

History is packed for the model that will read it. A session that once
carried an image would replay that image on every later turn, and a
text-only endpoint rejects the content type — so attachments the active
model cannot process are replayed as a text marker naming the file, its
type and its size. The conversation keeps working and the model can
still refer to what it cannot see
(`[Image attachment "shot.png" (image/png, 1.2 MB) — not shown: …]`).
The text of those turns is untouched.

Sending a **new** attachment to such a model does not fail the turn.
somora hands the file to the configured vision worker and appends its
description to the message the model receives, marked as a description
rather than the file itself. The clients still show the original
attachment, so what you see is unchanged. Only when no `vision.worker`
is configured does the turn refuse, and the error says both ways out:
switch models, or configure a worker.

### What can be attached

Images (PNG/JPEG/GIF/WebP), PDFs and text. Video and audio are
recognised by the file-type sniffer — that is what lets the web FileView
serve them with an honest content type — but they are deliberately not
attachable to a chat turn: no engine can put a video in a prompt, and
accepting one would mean an attachment that vanishes silently while the
turn is packed.

Worker model **must be on `openai-compatible` engine** (use
openrouter or another openai-compatible proxy if you want a Claude or
GPT model). Same constraint as Dream-Mode. At server startup, somora
warn-checks worker capabilities and surfaces missing `image`/`pdf`
declarations clearly in the log — but does NOT hard-fail, so an
image-only worker is still usable for image analysis (PDF requests
will error per call instead).

**Caps:** 5 MB per image, 32 MB per PDF (the upstream provider
ceilings; providers additionally cap PDFs at 100 pages). PDF render:
max 20 pages by default, scale 1.5× (configurable in code).

**Engine support:**
- claude-cli (Anthropic) — full polymorph support; images and rendered
  PDFs ride as native ImageBlock / DocumentBlock content
- codex-cli (OpenAI) — dynamic-tool results carry images natively
  (`inputImage`); PDFs rasterise to per-page PNGs
- openai-compatible (omlx, openrouter, ollama) — works for vision-
  capable models (gemma-vision, gpt-5 via openrouter, etc.); local
  servers vary in tool-result image-content support — failures
  surface as explicit API errors

The multimodal helper modules in `src/multimodal/` feed both the
agent-driven path (file_read / analyze_file) and the user-driven
path (chat-message attachments via paperclip / paste / drag&drop).

## User-attachments (web + TUI client)

The web client exposes paperclip / drag&drop / paste so users can
attach files directly to a chat turn. Pipeline:

1. `POST /attachments` — raw bytes go to a streaming endpoint that
   sniffs MIME via magic-bytes (extensions are untrusted), enforces
   per-kind caps from `config.attachments`, and lands the file at
   `~/.somora/attachments/<sha256>.<ext>`. Returns
   `{hash, mime, kind, size, name}`. Same content uploaded twice =
   same file on disk (sha256 dedup).
2. `POST /chat/send` (and `/chat/send-sync`, `/spawn-async`) — body
   extension `attachments: [{hash, name, mime, size}]`. Server resolves refs, validates the active model's
   capabilities, refuses with a clear error if the model lacks
   `image` / `pdf` cap.
3. JSONL persists refs only on the `user_message` event — bytes never
   travel into JSONL or back out. History replay re-loads bytes from
   disk on demand.
4. Agents use the same pipeline through their tools: `agent_ask` and
   `spawn_subagent`/`spawn_subagents` take `images: ["/absolute/path"]`,
   upload those files themselves and put the refs on the turn they
   start. That is how an orchestrator hands a co-worker a graphic it
   just generated — naming the path in the message text only gives the
   receiving model a string. A receiving model without
   vision gets the vision worker's description, exactly as for a chat
   attachment.
5. Each engine adapter builds its native multimodal user-message
   shape: claude-cli inlines as `ContentBlockParam[]` with
   `ImageBlockParam` / `DocumentBlockParam`; codex-cli sends images as
   native `localImage` turn inputs and rasterises PDFs to per-page PNGs
   into a sibling cache dir; openai-compatible produces an array-content
   user message (`{type:'image_url'}` / `{type:'file'}` / rasterised
   PNGs depending on the provider's `pdfMode`).

### Caps + per-turn count

```yaml
attachments:
  maxImageBytes: 5242880   # 5 MB — Anthropic ceiling, lowest common denominator
  maxPdfBytes:   33554432  # 32 MB — Anthropic ceiling
  maxTextBytes:  1048576   # 1 MB
  maxPerTurn:    10        # UX sanity cap
```

Defaults match the strictest engine in the supported set so a config
that accepts any of them is safe everywhere. Operators with a
single-engine fleet can raise these. `analyze_file` honours the same
caps: its vision worker runs on an `openai-compatible` provider, so the
Anthropic ceiling does not apply there — raise `maxImageBytes` when the
agent should inspect large images, e.g. somora's own 2K/4K `imageGen`
output (a 2048×2048 PNG is routinely 6–9 MB).

### `pdfMode` — only on `openai-compatible` providers

```yaml
providers:
  openrouter:
    engine: openai-compatible
    pdfMode: native    # opt-in; default is 'rasterize'
```

- `claude-cli` providers: always native (Anthropic supports inline
  PDF). No knob.
- `codex-cli` providers: always rasterise (Codex accepts only images
  as native input). No knob.
- `openai-compatible` providers: depends on the actual backend
  behind the URL. `rasterize` (default) renders pages to PNG and
  works against omlx, ollama, anything image-capable. `native`
  passes the PDF as a `{type:'file'}` content block — Anthropic
  via OpenRouter and OpenAI direct accept this; most local servers
  do not. Enable `native` per-provider when your backend supports
  it.

Token economics: `native` ships the PDF as text (the provider
extracts on their side) — a few-page invoice lands at ~3–4k
prompt tokens. `rasterize` sends one image per page; image-capable
providers charge ~1.5–2k image-tokens per page on top of the
page-PNG bytes, so a 5-page PDF can easily 3–5× the prompt-token
cost of `native`. Pick `native` when the backend supports it.

### Garbage collection

There is none. Every uploaded file lands in `~/.somora/
attachments/<hash>.<ext>` and stays. After heavy use, orphaned
files (referenced only by JSONL sessions that have since been reset
or deleted) accumulate. Acceptable trade-off: disk is cheap, single-
user setup.

## Persona files: never without a backup

A persona file of any agent — `AGENTS.md`, `SOUL.md`, `USER.md`,
`VOICE.md`, `agent.yaml` under `~/.somora/agents/<name>/` — stays
writable through `file_write` and `file_patch` (agents edit themselves
and, by design, each other), but the current file is copied to
`<file>.bak-<timestamp>` first and the result names that copy in
`backup`; the last five backups are kept, like the web editor does. A
chat agent once overwrote another agent's `AGENTS.md` with one byte in a
test, and the persona was gone.

## Limits

A builder agent pinned to a project folder may write only there and in
its temp folder; see [builder.md](builder.md#where-a-builder-may-write).

| Tool | Cap | Notes |
|---|---|---|
| `file_read` | 2000 lines per call by default (`limit`), 200 000 chars hard cap, 2000 chars per line | Text comes back numbered: every line is `N: text` with its 1-based line number, so the model can cite `path:line` and copy exact lines into `file_patch` (without the prefix). `offset` is the number of lines to skip (0-based), `limit` the number of lines. The result carries `range` (first/last line shown), `lines` (total) and a `summary`: `End of file (N lines).` or `Showing lines a-b of N. Continue with offset=b.` — plus `next_offset` while there is more. A line longer than 2000 chars is cut with `… [line cut at 2000 chars]`. Missing files surface as `file_read: file_not_found at '<path>'. Did you mean: a.ts, b.ts?` with up to three near names from the same directory. Errors on binary files — images and PDFs point at `analyze_file`, other binaries at `exec`. |
| `file_write` | none on input; 100 000 char result envelope | Atomic via tmp+rename. Over SSH the rename uses `posix-rename@openssh.com` so an existing target is replaced; servers without the extension get unlink+rename. |
| `file_patch` | requires `old_string` to be unique unless `replace_all=true` | Exact match first; when the file differs from `old_string` only in whitespace, indentation, line endings, escaped characters or a copied `N: ` line-number prefix, the closest *unique* block is used (see "Tolerant matching" below). The result carries `strategy`, the replaced `lines` range, a `diff` of the changed lines with original line numbers, and a `note` whenever tolerance was needed. |
| `file_search` | 50 hits default, 500 max; hit text is the whole line up to ~500 chars, longer lines windowed ±500 chars around the first match (`col` = column, `truncated` marks a cut line); 100 000 chars of hit text per call, then `truncated: true` | Needs `rg` (ripgrep) on the target machine. `include` narrows to a glob (`*.ts`, `*.{ts,tsx}`, `src/**`, `!*.test.*`), `case_insensitive` ignores case, `context` (0-5) adds `before`/`after` line arrays to each hit, `files_only` returns just `files` (the matching paths). `path` may be a directory or a single file. |
| `file_list` | 5000 entries per call (default 200) | Path resolution + read-policy identical to `file_read`. Recursive listings skip what `.gitignore`/`.ignore` exclude (`node_modules`, build output) by way of `rg --files`; `respect_gitignore: false` lists everything. Directories on the way to a kept file are still listed. Missing dirs surface as `file_list: file_not_found at '<path>'`. |

### Tolerant matching in `file_patch`

A model's `old_string` is a reconstruction of what it read, and small models reconstruct badly: a level of indentation missing, a tab for four spaces, `\n` sent as two characters, or the `12: ` prefix copied from a numbered read. Byte-exact matching turned each of those into "not found" and a retry with the same mistake. `file_patch` now locates `old_string` with a chain of matchers, in this order, and uses the first one that yields exactly one match (or any number with `replace_all`):

1. `exact` — byte-exact, always tried first and always wins when it matches.
2. `line_trimmed` — lines compared without leading/trailing whitespace.
3. `block_anchor` — for blocks of three or more lines: first and last line identical (trimmed), the block may be up to a quarter longer or shorter, middle lines compared by edit-distance similarity (threshold 0.65); with several candidates the clearly most similar one.
4. `whitespace_normalized` — runs of whitespace treated as one; for a single-line `old_string` also as a substring of a line.
5. `indentation_flexible` — common leading indentation removed on both sides.
6. `escape_normalized` — `\n`, `\t`, `\"`, `\\` and friends in `old_string` unescaped.
7. `trimmed_boundary` — leading/trailing whitespace of the whole `old_string` ignored.
8. `context_aware` — anchors at both ends, same length, at least half of the non-empty middle lines identical.

Before the chain runs on an `old_string` whose lines all start like `12: `, the prefixes are stripped (`note` says so). Two brakes: a tolerant match whose span is far larger than `old_string` (≥ twice the lines, or +3 lines, or ×4 the characters) is refused with a request to re-read and pass the exact text; and inside somora's own home (`~/.somora` — config, persona files, memory) only `exact` runs, because a wrong-place edit there costs the most. CRLF files are matched on LF and written back as CRLF. When several matchers see more than one candidate and none sees exactly one, the error says so and asks for more context or `replace_all`.

### Full copies of shortened output

When a tool result is shortened — `exec` output beyond its ~60 000-char budget (or the 256 KB capture cap), or any result over its size cap — the full text is written under `~/.somora/agents/<agent>/tool-output/` and the result names the file (`stdout_file`, `stderr_file`, `full_output_file`) with a hint to `file_read` a window of it or `file_search` inside it instead of re-running the command. Files older than seven days are removed (sweep at boot and hourly).
| `analyze_file` | `attachments.maxImageBytes` (5 MB default) / `attachments.maxPdfBytes` (32 MB) | Local files only; worker on openai-compatible engine. **Hidden from the model entirely when `config.vision.worker` is unset or the active model has the `image` capability itself** (the same path-resolution + read-policy as `file_read` applies). |

`rg` not installed → clear error: `file_search: ripgrep (rg) not found
on PATH. Install via your package manager (brew/apt/dnf/pacman) or set
$RG_BIN to a custom location.` We deliberately don't ship a JS fallback walker —
parity with rg's defaults (.gitignore-respect, encoding handling) is
worth the dependency.

## Examples (what the agent sees)

```jsonc
// Local read
{ "name": "file_read", "input": { "path": "notes.md" } }
// → reads <workspace>/notes.md

// Remote read
{ "name": "file_read", "input": { "path": "/tmp/log.txt", "target": "<resource-name>" } }
// → SFTP read via that resource

// Remote search
{ "name": "file_search", "input": { "pattern": "TODO", "path": "src/", "target": "<resource-name>" } }
// → ssh <resource-name> 'rg --json --max-count 50 "TODO" /home/.../src/'
```
