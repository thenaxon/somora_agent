# somora 🐨

> A local-first runtime for personal AI agents — multiple personas with
> persistent memory, a shared long-term wiki, and the ability to switch
> between Claude, ChatGPT, and any OpenAI-compatible LLM mid-conversation.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: active dev](https://img.shields.io/badge/status-active%20dev-green.svg)](#status)
[![Node ≥20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](#requirements)

## What is somora?

A small server you run on your machine that hosts one or more AI **agents**,
each with its own personality, memory, and configuration. You chat with them
via a CLI; they remember things across sessions; they can use the same tool
surface (memory, files, web, exec, tmux) regardless of which LLM you point
them at.

What makes it different:

- **Local-first.** All data — config, memory, sessions, the wiki — lives in
  `~/.somora/` on your machine. Nothing leaves your laptop unless you point
  an engine at a cloud provider.
- **Multi-agent.** Configure as many personas as you want — each with a
  distinct character, separate memory inbox, and own model preferences.
  All agents share one long-term wiki of consolidated knowledge.
- **Multi-engine.** One conversation can flip between Claude Opus (via your
  Claude subscription), GPT-5.5 (via your ChatGPT subscription), or any
  local model exposing an OpenAI-compatible endpoint (Ollama, LM Studio,
  vLLM, oMLX). Conversation history carries over.
- **Memory that compounds.** Three-phase background consolidation: agents
  notice new facts during conversation, accumulate them privately, then
  promote stable knowledge to a shared Obsidian-vault wiki. The wiki is
  cleaned up periodically by a separate worker.
- **Tools, not magic.** Every capability — recall, file edits, shell
  commands, web fetches, sub-agent spawning — is a typed tool the agent
  can call. The same registry feeds all three engines via either an
  in-process loop or per-turn MCP child processes.

## Architecture at a glance

```
[your terminal] ─► CLI/TUI ─► HTTP+SSE ─► somora-server ─► engine adapter
                                              │              ├─ claude-cli       (Claude subscription)
                                              │              ├─ codex-cli        (ChatGPT subscription)
                                              │              └─ openai-compatible (any /v1/chat/completions)
                                              │
                                              ├─ Memory layer (per-agent)
                                              │   ~/.somora/agents/<name>/memory/*.md
                                              │   indexed: SQLite + sqlite-vec + FTS5 (hybrid retrieval)
                                              │
                                              ├─ Wiki layer (shared, optional)
                                              │   <obsidian-vault>/<wiki-subfolder>/
                                              │   personen/ projekte/ wissen/ orte/ …
                                              │   index.md auto-regenerated, monthly logs
                                              │
                                              ├─ Tool registry
                                              │   memory_*, dream_*, file_*, exec, tmux, web_*,
                                              │   spawn_subagent, somora_docs_*, skill, resource_*,
                                              │   time_now, analyze_file
                                              │
                                              └─ Three-phase dream system
                                                  REM   (per-agent, session → memory inbox)
                                                  Deep  (platform, memory inbox → shared wiki)
                                                  Lucid (platform, wiki cleanup)
```

## Memory model — three layers

| Layer | Where | What | Who writes |
|---|---|---|---|
| **Inbox** | `~/.somora/agents/<name>/memory/*.md` | Short-term, agent-private. Un-consolidated facts. | Agent (via tools) or REM (automatic extraction from sessions). |
| **Wiki** | `<vault>/<wiki-subfolder>/*.md` | Long-term, shared across all agents. The single source of truth for stable facts. | Deep (consolidates from inboxes); Lucid (periodic cleanup); you (manually in Obsidian). |
| **Vault** | rest of your Obsidian vault | Read-only context. Not maintained by somora. | You (in Obsidian). Agents read it, never write. |

When you ask an agent a question:
1. **Auto-injection** runs hybrid search (vector + BM25) across all three
   layers. Top hits prepend to the system prompt as `<memory-context>`. The
   agent doesn't need to call a search tool to recall relevant facts.
2. The agent can also call `memory_search` / `memory_get` explicitly for
   deeper digs; `file_read` for vault paths outside the wiki.

## Three-phase dream system

Background consolidation runs in three phases, each with its own job, model,
and cadence:

| Phase | Job | Scope | Trigger | Worker | Approval |
|---|---|---|---|---|---|
| **REM** | Session → Memory inbox | Per-agent | `/reset` or 30 min idle | small/local (e.g. gemma) | ✓ you approve each finding |
| **Deep** | Memory inbox → Wiki | Platform | every 12h or `dream_run({phase:'deep'})` | strong (e.g. opus) | ✗ auto-applies |
| **Lucid** | Wiki cleanup | Platform | every 7d or `dream_run({phase:'lucid'})` | strong (e.g. opus) | ✓ you approve each finding |

After Deep promotes a memory file to the wiki, the source memory file is
**deleted** — wiki is canonical, the inbox stays a clean queue. Lucid runs
weekly over the wiki and surfaces structured findings (contradictions, stale
claims, dead refs, missing pages) for you to review.

See [docs/dream-phases.md](docs/dream-phases.md) for the full mechanic.

## Multi-engine, mid-conversation

You can change the model anywhere in a conversation. History carries over,
the new engine just picks up the thread.

```
> /model opus           # Anthropic Claude Opus 4.7 (1M context window)
> ... chat ...
> /model gpt55          # OpenAI GPT-5.5 (Codex CLI subscription)
> ... chat continues with full context ...
> /model gemma4big      # local Ollama / mlx model
```

Engines:

| Engine | Auth | Use when |
|---|---|---|
| `claude-cli` | Claude Code binary in `~/.local/bin/claude` (subscription) | Best quality on Anthropic stack, no API key needed. |
| `codex-cli` | `codex` binary on PATH (ChatGPT subscription) | Strong reasoning, ChatGPT subscription cost. |
| `openai-compatible` | Any baseUrl + apiKey config | Local models, OpenRouter, any OpenAI-shaped endpoint. |

## Status

Active development. Customer-facing for early testers. Phase 4 (memory + wiki
+ dream-system v2) feature-complete:

| Capability | claude-cli | codex-cli | openai-compatible |
|---|:-:|:-:|:-:|
| Chat | ✓ | ✓ | ✓ |
| Memory auto-injection | ✓ | ✓ | ✓ |
| Memory tools (read + write) | ✓ via MCP | ✓ via MCP | ✓ in-process |
| Wiki layer (shared) | ✓ | ✓ | ✓ |
| Three-phase dreams | ✓ | ✓ | ✓ |
| Tool surface (40+ tools) | ✓ via MCP | ✓ via MCP | ✓ in-process |
| Skills (markdown how-tos) | ✓ | ✓ | ✓ |
| Multimodal (images, PDFs) | ✓ | ✓ | model-dependent |
| Sub-agent spawning | ✓ | ✓ | ✓ |
| SSH-resource exec | ✓ | ✓ | ✓ |

## Requirements

- **Node ≥20** — uses native `node:sqlite` plus `better-sqlite3`.
- **At least one LLM backend.** Pick what you have:
  - Claude Code binary (Claude subscription) — for `claude-cli` engine.
  - Codex CLI binary (ChatGPT subscription) — for `codex-cli` engine.
  - Any OpenAI-compatible HTTP server — Ollama, LM Studio, vLLM, oMLX, OpenRouter, etc.
- **Optional: Obsidian vault** for the wiki + read-only vault recall source.

## Quickstart

### Install (production / from npm tarball)

```bash
git clone https://github.com/<your-account>/somora_agent.git somora
cd somora
npm install -g .
somora server start    # registers as a systemd user service
somora tui             # chat with the default agent
```

See [docs/setup.md](docs/setup.md) for first-run config and provider setup.

### Develop

```bash
git clone https://github.com/<your-account>/somora_agent.git somora
cd somora
npm install
npm run dev:server   # terminal A
npm run dev:cli      # terminal B
```

First run creates `~/.somora/config.yaml` and a default agent. Edit
`config.yaml` to add your providers — see [docs/setup.md](docs/setup.md).

## Configuration

Three files matter, all optional except `config.yaml`:

| File | Scope | What it controls |
|---|---|---|
| `~/.somora/config.yaml` | Server-global | LLM providers, models, compaction, memory tuning, wiki settings, dream-phase Deep/Lucid models + cadence, agent-loop limits, SSH resources, web API keys, TUI display |
| `~/.somora/agents/<name>/agent.yaml` | Per-agent | model + fallback, REM phase config (worker model, idle minutes, chunk sizes), workspace override, resource deny-list, skills allow-list |
| `~/.somora/agents/<name>/{AGENTS,SOUL,USER}.md` | Per-agent | Persona — behavioural rules (`AGENTS.md`), voice (`SOUL.md`), what the agent knows about you (`USER.md`) |

See [docs/setup.md](docs/setup.md) for `config.yaml` reference and
[docs/agents.md](docs/agents.md) for creating new agents.

## Slash commands (TUI)

```
/help                          show available commands
/agents                        list configured agents
/agent <name> [session]        switch to another agent
/sessions                      list sessions for the current agent
/session <slug-or-id>          switch to a session
/new <slug>                    create + switch to a new session
/main                          back to the agent's main session
/reset                         preview reset of current session
/reset YES                     archive + start fresh; spawns REM if enabled
/models                        list configured models with aliases
/model                         show effective model for this session
/model <alias-or-ref>          override model for this session
/model default                 clear override
/thinking <off|low|medium|high>  reasoning depth (where the model supports it)
/show <memory|tools> on|off    toggle TUI display of memory-injection / tool-calls
/verbose <memory|tools|system> on|off  more detail per turn
/quit, /exit                   leave somora
```

## Tool surface

Agents see ~40 tools across 12 toolsets. The same registry feeds all three
engines (in-process for openai-compatible, MCP-child per-turn for claude-cli
and codex-cli) — same tool surface regardless of model.

| Toolset | Examples | Purpose |
|---|---|---|
| memory | `memory_search`, `memory_get`, `memory_write`, `memory_edit`, `memory_delete`, `memory_list` | Read/write memory across all three layers (memory + wiki + vault). |
| dream | `dream_list`, `dream_get`, `dream_apply`, `dream_dismiss`, `dream_run` | Inspect findings from REM/Lucid; trigger Deep/Lucid manually. |
| file | `file_read`, `file_write`, `file_patch`, `file_search`, `file_list`, `analyze_file` | Generic filesystem I/O — local or any configured SSH resource. |
| exec | `exec`, `process` | One-shot shell + background jobs, local or SSH. |
| tmux | `tmux` | Persistent multi-turn terminal sessions for TUIs (claude/codex/vim/REPLs). |
| web | `web_search`, `web_fetch` | Brave-API search + Mozilla-Readability fetch. |
| agents | `spawn_subagent`, `subagent_*`, `agent_ask` | Sub-agent orchestration; ask another agent something. |
| skills | `skill` | Activate a Markdown how-to from `~/.somora/skills/`. |
| docs | `somora_docs_list`, `somora_docs_read` | Read somora's own documentation. |
| resources | `resource_list`, `resource_test` | Discover/probe configured SSH targets. |
| time | `time_now` | Current date/time/timezone. |

See [docs/tools.md](docs/tools.md) for the full surface.

## Documentation

- [docs/setup.md](docs/setup.md) — install, providers, first run
- [docs/agents.md](docs/agents.md) — creating agents, persona files, model overrides
- [docs/memory.md](docs/memory.md) — how the memory inbox works, vault integration, retrieval
- [docs/wiki.md](docs/wiki.md) — the shared long-term wiki layer
- [docs/dream-phases.md](docs/dream-phases.md) — REM / Deep / Lucid in detail, the approval loop
- [docs/tools.md](docs/tools.md) — full tool reference with descriptions
- [docs/skills.md](docs/skills.md) — markdown how-tos the agent can activate
- [docs/files.md](docs/files.md) — file_* tools, multimodal `analyze_file`
- [docs/tmux.md](docs/tmux.md) — long-lived terminal sessions for TUIs
- [docs/resources.md](docs/resources.md) — SSH targets, exec routing
- [docs/thinking.md](docs/thinking.md) — reasoning-depth surface across engines
- [docs/display.md](docs/display.md) — TUI display toggles
- [docs/cache-strategy.md](docs/cache-strategy.md) — prompt-cache mechanics
- [docs/security.md](docs/security.md) — what's locked down per engine

## License

[MIT](LICENSE).

---

🐨 *somora — patient, slow, with very good memory.*
