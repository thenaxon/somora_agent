# File tools

`file_read`, `file_write`, `file_patch`, `file_search`, and
`analyze_file` work on the local filesystem by default and on any
configured remote resource via the `target` parameter (where
applicable — `analyze_file` is local-only in v1).

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

The `exec` tool mirrors this in reverse: "use file_* for
read/write/patch/search; exec is for things the file tools can't do
(run a build, start a server, etc.)".

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

For when file_read polymorph isn't right:
- Active main model lacks `image` capability (text-only LLM), but you
  still need to reason about a file
- Token thrift — a 1024×1024 image is ~1300 tokens in main context;
  a haiku-worker description is usually < 200 tokens
- Targeted questions — `analyze_file({path, prompt: "Which row of the
  table has the highest value?"})` lets the worker focus, the agent
  gets a sharp answer

```yaml
# config.yaml — global vision worker config
vision:
  worker: openrouter/claude-haiku-4-5      # default for image + PDF
  pdfWorker: openrouter/claude-sonnet-4-6  # optional override for PDFs
```

Worker model **must be on `openai-compatible` engine** in v1 (use
openrouter or another openai-compatible proxy if you want a Claude or
GPT model). Same constraint as Dream-Mode. At server startup, somora
warn-checks worker capabilities and surfaces missing `image`/`pdf`
declarations clearly in the log — but does NOT hard-fail, so an
image-only worker is still usable for image analysis (PDF requests
will error per call instead).

**Caps:** 5 MB per image, 32 MB / 100 pages per PDF (matches upstream
provider ceilings). PDF render: max 20 pages by default, scale 1.5×
(configurable in code).

**Engine support:**
- claude-cli (Anthropic) — full polymorph support; images and rendered
  PDFs ride as native ImageBlock / DocumentBlock content
- codex-cli (OpenAI) — same MCP-image-content path; images forward
  natively, PDFs rasterise to per-page PNGs
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
2. `POST /chat/send` — body extension `attachments: [{hash, name,
   mime, size}]`. Server resolves refs, validates the active model's
   capabilities, refuses with a clear error if the model lacks
   `image` / `pdf` cap.
3. JSONL persists refs only on the `user_message` event — bytes never
   travel into JSONL or back out. History replay re-loads bytes from
   disk on demand.
4. Each engine adapter builds its native multimodal user-message
   shape: claude-cli inlines as `ContentBlockParam[]` with
   `ImageBlockParam` / `DocumentBlockParam`; codex-cli pipes images
   through `-i <PATH>` and rasterises PDFs to per-page PNGs into a
   sibling cache dir; openai-compatible produces an array-content
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
single-engine fleet can raise these.

### `pdfMode` — only on `openai-compatible` providers

```yaml
providers:
  openrouter:
    engine: openai-compatible
    pdfMode: native    # opt-in; default is 'rasterize'
```

- `claude-cli` providers: always native (Anthropic supports inline
  PDF). No knob.
- `codex-cli` providers: always rasterise (codex's `--image` accepts
  only images). No knob.
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

Out of scope for v1. Every uploaded file lands in `~/.somora/
attachments/<hash>.<ext>` and stays. After heavy use, orphaned
files (referenced only by JSONL sessions that have since been reset
or deleted) accumulate. Acceptable trade-off: disk is cheap, single-
user setup. A sweep tool may land later.

## Limits

| Tool | Cap | Notes |
|---|---|---|
| `file_read` | 200 000 chars per call | `offset`+`limit` are LINE counts (not bytes). When a result is truncated by line, the response includes `next_offset` — pass it as `offset` to continue. Byte-cap-truncated reads omit `next_offset` (the cut is mid-line). Missing files surface as `file_read: file_not_found at '<path>'`. Errors on binary, pointing at `analyze_file`. |
| `file_write` | none on input; 100 000 char result envelope | Atomic via tmp+rename. |
| `file_patch` | requires `old_string` to be unique unless `replace_all=true` | Match is byte-exact (no fuzzy). |
| `file_search` | 50 hits default, 500 max; 200 000 char result envelope | Needs `rg` (ripgrep) on the target machine. |
| `file_list` | 5000 entries per call (default 200) | Path resolution + read-policy identical to `file_read`. Missing dirs surface as `file_list: file_not_found at '<path>'`. |
| `analyze_file` | 5 MB image / 32 MB PDF | Local files only in v1; worker on openai-compatible engine. **Hidden from the model entirely when `config.vision.worker` is unset** (the same path-resolution + read-policy as `file_read` applies). |

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
