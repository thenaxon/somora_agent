# somora 🐨

> Local-first gateway for personal AI agents with persistent memory across
> Claude, ChatGPT (Codex CLI), and any OpenAI-compatible LLM.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Status: active dev](https://img.shields.io/badge/status-active%20dev-green.svg)](#status)
[![Node ≥20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](#requirements)

Somora runs as a small local server you talk to. You define one or more
**agents** (Hans, Lisa, …) — each is a distinct persona with its own
memory, its own configuration, and the ability to switch between LLM
backends mid-conversation. Memory is plain Markdown on disk + an SQLite
index. Nothing leaves your machine unless you point the engine at a
cloud provider.

```
[your terminal] ─► CLI ─► HTTP+SSE ─► somora-server ─► engine adapter
                                          │              ├─ claude-cli      (Anthropic via Claude Code subscription)
                                          │              ├─ codex-cli       (OpenAI via ChatGPT subscription)
                                          │              └─ openai-compatible (any /v1/chat/completions endpoint)
                                          │
                                          ├─ memory layer (SQLite + sqlite-vec + FTS5)
                                          │   ├─ ~/.somora/agents/<name>/memory/*.md
                                          │   └─ optional: Obsidian vault as read source
                                          │
                                          ├─ tool registry (memory_*, dream_*)
                                          │   exposed via in-process loop or local MCP server
                                          │
                                          └─ dream-mode (idle background memory consolidation)
```

## What Hans can do today

- **Chat across three LLM backends** — Anthropic Claude (subscription auth via
  Claude Code binary), OpenAI ChatGPT (subscription via Codex CLI), and any
  OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, etc.). Switch on the
  fly with `/model opus`, `/model gpt55`, `/model gemma`. Conversation history
  carries over.

- **Persistent memory you control** — your agent's memory is plain Markdown
  files under `~/.somora/agents/<name>/memory/`. Edit them with `vim` or let
  the agent write them via tools. They're indexed for hybrid (vector + BM25)
  retrieval. Relevant snippets are auto-injected into every turn — the agent
  doesn't need to explicitly call a search tool to recall context.

- **Optional Obsidian vault as a recall source** — point an agent at an
  Obsidian vault and its notes become searchable alongside the agent's own
  memory. Read-only by default; write paths are configurable per agent.

- **Tool surface (memory_*, dream_*)** — agents can search, read, write,
  edit, and delete their own memory through tools. The same surface is
  exposed three ways: as an in-process tool loop for OpenAI-compatible
  models, as an MCP server for claude-cli and codex-cli.

- **Dream-mode background consolidation** — after `idleMinutes` of no chat
  activity, an agent can run an LLM extraction over its session transcripts
  and surface candidate memory updates as **findings**. You review them with
  the agent step-by-step (`dream_list` → `dream_apply` / `dream_dismiss`).
  Nothing is auto-written to memory without your explicit approval.

- **Manual session reset** — `/reset YES` archives the current session and
  starts fresh. If dream-mode is enabled, the archived range gets a
  same-shape extraction, so memory-worthy facts get a chance to migrate
  before the conversation grows beyond the model's window.

## Status

Active development. Phase 2 is feature-complete:

| Capability                 | claude-cli (opus) | codex-cli (gpt-5.5) | openai-compatible (gemma, …) |
| -------------------------- | :---------------: | :-----------------: | :--------------------------: |
| Chat                       |         ✓         |          ✓          |              ✓              |
| Memory read (auto-inject)  |         ✓         |          ✓          |              ✓              |
| Memory write (tools)       |    ✓ via MCP      |     ✓ via MCP       |       ✓ via agent-loop      |
| Dream tools                |    ✓ via MCP      |     ✓ via MCP       |       ✓ via agent-loop      |
| Compaction                 | provider-internal |  provider-internal  |       somora-managed        |
| Vault recall source        |         ✓         |          ✓          |              ✓              |

## Requirements

- **Node ≥20** (uses native `node:sqlite` plus the `better-sqlite3` build).
- **An LLM backend.** Any one of these is enough; you can mix:
  - **Claude Code** binary in `~/.local/bin/claude` (Claude subscription) —
    enables the `claude-cli` engine.
  - **Codex CLI** binary in `~/.npm-global/bin/codex` or on PATH (ChatGPT
    Plus/Pro/Business subscription) — enables the `codex-cli` engine.
  - **An OpenAI-compatible HTTP server** — Ollama, LM Studio, vLLM, oMLX,
    etc. Enables the `openai-compatible` engine.

## Quickstart

```bash
git clone https://github.com/<your-account>/somora_agent.git somora
cd somora
npm install
npm run dev:server   # terminal A
npm run dev:cli      # terminal B
```

First run creates `~/.somora/config.yaml` with sensible defaults. Edit it to
add your providers — see [docs/setup.md](docs/setup.md) for the full guide.
The CLI greets you with the default agent (Hans). Type `/help` to see the
slash commands.

## Configuration

Three layers, each optional except the server config:

| File                                       | Purpose                                              |
| ------------------------------------------ | ---------------------------------------------------- |
| `~/.somora/config.yaml`                    | server-wide: providers, models, compaction, memory, agent-loop |
| `~/.somora/agents/<name>/agent.yaml`       | per-agent: model, fallback, dream config, vault path |
| `~/.somora/agents/<name>/{AGENTS,SOUL,USER}.md` | persona: rules, voice, what the agent knows about you |

See [docs/setup.md](docs/setup.md) for `config.yaml` and
[docs/agents.md](docs/agents.md) for setting up new agents.

## Documentation

- [docs/setup.md](docs/setup.md) — install, providers, first run
- [docs/agents.md](docs/agents.md) — creating agents, persona files, model overrides
- [docs/memory.md](docs/memory.md) — how memory works, how to write notes, Obsidian integration
- [docs/dream-mode.md](docs/dream-mode.md) — what dreams are, triggers, the review loop
- [docs/security.md](docs/security.md) — what's locked down in each engine adapter

## Slash commands

```
/help                          show available commands
/agents                        list configured agents
/agent <name> [session]        switch to another agent
/sessions                      list sessions for the current agent
/session <slug-or-id>          switch to a session
/new <slug>                    create + switch to a new session
/main                          back to the agent's main session
/reset                         preview reset of current session
/reset YES                     archive + start fresh; spawns a dream if enabled
/models                        list configured models with aliases
/model                         show effective model for this session
/model <alias-or-ref>          override model for this session
/model default                 clear override
/quit, /exit                   leave somora
```

## License

[Apache License 2.0](LICENSE). See also [NOTICE](NOTICE).

---

🐨 *somora — patient, slow, with very good memory.*
