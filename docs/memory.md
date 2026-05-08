# Memory

Each agent has its own memory store. Memory is **plain Markdown files on
disk**, indexed by SQLite (with `sqlite-vec` for ANN and FTS5 for BM25)
for fast hybrid retrieval.

## Mental model

```
~/.somora/agents/<name>/memory/
├── auto.md                  ← user-written notes, indexed automatically
├── projects.md
├── routines.md
├── memory.db (+ -wal, -shm) ← derived index, rebuilt from .md if deleted
└── .dreams/                 ← background findings (see dream-mode.md)
    └── processed/           ← resolved dreams (audit trail)
```

The Markdown files are the source of truth. The SQLite index is derived
— delete `memory.db*` and it rebuilds from the `.md` files on next run.
Files survive `git`, `vim`, `rsync`, anything. The agent reads them
through the same pipeline regardless of who wrote them (you, the agent
itself via tools, or a sync from another machine).

## How retrieval works

Two paths flow into every chat turn:

1. **Auto-inject** (always on, no tool call needed): the runtime takes the
   last few turns of conversation, runs them as a hybrid query against the
   memory index, takes the top-N hits, and prepends them as a
   `<memory-context>` block to the system prompt for that turn. The agent
   sees relevant notes whether or not it thinks to search.

2. **Tools** (agent-driven, on demand): `memory_search`, `memory_get`,
   `memory_list`. The agent decides when it needs to dig deeper than the
   auto-injected snippet — typically when the user asks something the
   pre-injected context didn't cover.

Both paths share the same retrieval implementation: vector similarity
(local embeddings via ONNX, default `Xenova/all-MiniLM-L6-v2`) fused with
BM25 over an FTS5 index. Min-max normalisation per-modality, then
weighted sum (default 0.7 vector + 0.3 BM25).

## Writing memory

Three ways:

1. **You edit `~/.somora/agents/<name>/memory/<slug>.md` directly.** A
   chokidar file-watcher re-indexes within ~1.5 s of save. The agent
   sees your edit on the next turn. Works with `vim`, VSCode, Obsidian,
   any editor that does atomic-rename writes.

2. **The agent writes it via tool.** `memory_write` (create or replace),
   `memory_edit` (modify existing, fail if missing), `memory_delete`
   (remove). Slugs are limited to lowercase `[a-z0-9_-]` so the agent
   can never accidentally write outside the memory directory.

3. **Through dream-mode review.** When the agent dreams over a session,
   findings often boil down to "the user said X; should I update memory
   note Y?" You step through them with the agent and the underlying
   write happens via the same `memory_*` tools.

## File format

```markdown
---
description: Apartment notes
tags: [home, logistics]
created: 2026-04-15T10:00:00Z
updated: 2026-05-01T18:42:00Z
---

I live in a flat in Linz. Two cats: Mau and Bo. Landlord contact:
Frau Huber, +43 …

Storage: cellar locker B-12, key in kitchen drawer.
```

Frontmatter is optional but `description` is shown by `memory_list`. The
write tools manage `created`/`updated` automatically.

## Obsidian vault as a read source

Configure in `agent.yaml`:

```yaml
obsidian:
  vault: ~/Documents/Vault/
```

Vault notes are indexed alongside the agent's own memory. Recall hits
return them too, marked `vault/<slug>` instead of `memory/<slug>`. The
agent CANNOT write to the vault — `memory_write` is hard-scoped to its
own memory directory; vault writes happen only through Dream-B/C
(server-side workers, no agent-direct path).

A few notes on the vault integration:

- Dotfile directories (`.obsidian/`, `.trash/`, `.git/`) are skipped
  automatically.
- Slugs are derived as path-with-`--` separators:
  `Projects/Personal/Travel.md` → `Projects--Personal--Travel`.
- The same hybrid retrieval applies across both memory and vault.

## Tool surface

```
memory_search(query, limit?, minScore?)        hybrid recall, both sources
memory_get(reference)                           full content of one note
memory_list(filter?)                            list own memory notes
memory_write(slug, content, frontmatter?)       create or replace own-memory note
memory_edit(slug, content)                      modify existing note (fails if missing)
memory_delete(slug)                             remove own-memory note (idempotent)
```

`memory_get` accepts the exact reference string returned by
`memory_search` — `memory/auto`, `vault/Projects--Personal--Travel`, etc.
Pass it through verbatim; no parsing needed.

The tools are exposed three ways:

- For `claude-cli` and `codex-cli` engines: as a local stdio MCP server
  (`src/mcp/server.ts`).
- For `openai-compatible` engines: as in-process function definitions
  via the agent's tool-call loop.

## Debug endpoints

Useful when something looks off:

```bash
curl 'http://127.0.0.1:18737/agents/<your-agent>/memory/notes' | jq '.count'
curl 'http://127.0.0.1:18737/agents/<your-agent>/memory/search?q=apartment&minScore=0' | jq '.hits'
```

These return the raw indexed state — you can see exactly what would be
auto-injected for a given query, including per-modality scores
(`vecScore`, `bm25Score`) and the chunk text that matched. Helpful when a
recall feels off ("the agent didn't see X even though I wrote about it
yesterday") to confirm whether the issue is at the index level or higher.
