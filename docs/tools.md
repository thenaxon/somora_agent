# Tools

somora exposes tools to the agent through a single registry. Every
tool is **engine-agnostic**: claude-cli + codex-cli see them via an
MCP server somora spawns per turn, openai-compatible sees them
in-process. The model never knows which path it's on.

## Tool families

| Toolset | Tools | Purpose |
|---|---|---|
| `memory` | `memory_search`, `memory_get`, `memory_list`, `memory_write`, `memory_edit`, `memory_delete` | Read/write the agent's persistent memory (Markdown notes + indexed vault). |
| `dream` | `dream_list`, `dream_get`, `dream_apply`, `dream_dismiss` | Inspect and act on findings produced by Dream-Mode (see `dream-mode.md`). |
| `time` | `time_now` | Current date/time/timezone — model never hallucinates "today". |
| `web` | `web_search`, `web_fetch` | Search via Brave + fetch web pages as Markdown (Mozilla Readability + SSRF guards). |
| `obsidian` | `obsidian_write`, `obsidian_move`, `obsidian_delete` | Vault-aware writes; `obsidian_move` rewrites `[[wikilinks]]` across the whole vault. |
| `file` | `file_read`, `file_write`, `file_patch`, `file_search`, `file_list`, `analyze_file` | Generic filesystem I/O — local or against any configured SSH resource via `target=...`. `analyze_file` is the multimodal companion: dispatches images/PDFs to a configured `vision.worker` and returns a text description (see `files.md`). |
| `exec` | `exec`, `process` | One-shot shell commands (sync + background) on local or any SSH resource. Hard-blacklisted destructive patterns; background jobs disk-tracked with poll/log/kill via `process`. See `tools.md` body + `exec-design.md`. |
| `tmux` | `tmux` | Persistent multi-turn terminal sessions (claude/codex/vim/REPLs). One typed tool with `action: create | send | capture | list | kill` against `target: local | <ssh-resource>`. See `tmux.md` for shell-vs-TUI patterns, `wait_mode` choices, `multiline_safe`, `include_ansi`, and the auto-suggestion safety rule. |
| `agents` | `spawn_subagent`, `spawn_subagents`, `subagent_status`, `subagent_result`, `subagent_list`, `agent_ask` | Agent-to-agent orchestration. `spawn_*` create sealed sub-sessions for delegated work; `subagent_*` poll/collect results; `agent_ask` posts a live question into another agent's existing session. See `agents.md`. |
| `docs` | `somora_docs_list`, `somora_docs_read` | Read somora's own documentation (this directory). |
| `resources` | `resource_list`, `resource_test` | Discover and probe configured remote SSH targets. |
| `skills` | `skill` | Activate a Markdown skill ("how to do task X with our tools"). Skills live at `~/.somora/skills/<slug>/SKILL.md` (agentskills.io format). The system prompt carries a name+description registry; the tool loads the full body on demand. See `skills.md`. |

## Definition shape

A tool is a `ToolDefinition` (see `src/tools/types.ts`) with:

- `name` — globally unique (also the MCP method / OpenAI function name)
- `toolset` — grouping tag
- `description` — what the LLM sees in the tool list. Long-form
  preferred: descriptions are policy, not just API docs ("use this
  INSTEAD of running `cat` via exec").
- `inputSchema` — Zod schema for runtime validation
- `jsonSchema` — JSON Schema for MCP / OpenAI tool definitions
- `handler(input, ctx)` — receives validated input + a `ToolContext`
  (`{ agent, getMemoryManager, config }`)
- `available?(ctx)` — optional runtime probe; tools that fail are
  hidden from the model entirely (no API key → no `web_search`
  exposed, no vault → no `obsidian_*`, etc.)
- `maxResultSizeChars?` — cap on the JSON-stringified result;
  default 100 000 (≈25–35k tokens)

The registry truncates oversized results to a `{ truncated, preview,
hint, … }` marker so a runaway tool can't blow context.

## Where tools are wired

Two `ToolRegistry` instances exist by necessity:

- **In-process registry** in `src/server/index.ts` — used by the
  openai-compatible engine's agent-loop and by HTTP debug endpoints
  (`GET /tools`).
- **MCP child-process registry** in `src/mcp/server.ts` — spawned per
  turn by claude-cli and codex-cli (different process, separate
  memory).

Both populate from a single `registerAllTools(registry)` function in
`src/tools/index.ts`. Adding a new tool bundle = ONE new
`registerMany()` line there; both engine surfaces pick it up. The
two registries are physically separate (process boundary) but the
code that fills them is shared, so the effective tool set is
identical across all three engines.

## Background reading

- `display.md` — `/show` and `/verbose` toggles for the TUI
- `thinking.md` — cross-engine thinking depth control
- `memory.md` — how the memory layer works
- `resources.md` — SSH targets that file_* / exec / tmux dispatch to
- `skills.md` — Markdown skill system + per-agent allow-list
- `tmux.md` — shell-vs-TUI session patterns + capture/send modes
- `research/tool-architecture.md` — comparative study of OpenClaw and
  hermes-agent that informed our design
