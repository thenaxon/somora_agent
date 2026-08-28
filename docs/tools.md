# Tools

somora exposes tools to the agent through a single registry. Every
tool is **engine-agnostic**: claude-cli + codex-cli see them via an
MCP server somora spawns per turn, openai-compatible sees them
in-process. The model never knows which path it's on.

## Tool families

| Toolset | Tools | Purpose |
|---|---|---|
| `memory` | `memory_search`, `memory_get`, `memory_list`, `memory_write`, `memory_edit`, `memory_delete` | Read/write across the three layers — agent memory inbox, shared wiki, read-only vault. Hybrid retrieval (vector + BM25) with per-source boost. |
| `dream` | `dream_list`, `dream_get`, `dream_apply`, `dream_dismiss`, `dream_run`, `dream_review` | Inspect findings from REM (per-agent) and Lucid (platform-wide); trigger Deep/Lucid via `dream_run({phase: 'deep'\|'lucid'})`. `dream_review({dream_id, action:'start'\|'end'})` opens/closes a conversational wiki-edit loop for a Lucid run. See `dream-phases.md`. |
| `wiki` | `wiki_edit`, `wiki_create`, `wiki_delete` | Loop-scoped wiki write tools. Only exposed to the agent currently holding the active `dream_review` loop; otherwise hidden. `wiki_edit` mutates body and/or `related:`/`sources:` frontmatter. Per-turn cap of 3 wiki_* calls keeps the model from batch-editing without user check-in. See `dream-phases.md`. |
| `time` | `time_now` | Current date/time/timezone — model never hallucinates "today". |
| `web` | `web_search`, `web_fetch` | Search via Brave + fetch web pages as Markdown (Mozilla Readability + SSRF guards). |
| `file` | `file_read`, `file_write`, `file_patch`, `file_search`, `file_list`, `analyze_file` | Generic filesystem I/O — local or against any configured SSH resource via `target=...`. `analyze_file` is the multimodal companion: dispatches images/PDFs to the configured `vision.worker` — a single model or an ordered chain tried until one answers — and returns a text description (see `files.md`). |
| `exec` | `exec`, `process` | One-shot shell commands (sync + background) on local or any SSH resource. Hard-blacklisted destructive patterns; per-resource `allowBlocked` opt-in lets dedicated agent-workstations whitelist admin commands like `sudo …` or `systemctl reboot` (see `resources.md`). Background jobs are fully detached (survive somora/MCP restarts until they finish or are killed) and disk-tracked with poll/log/kill via `process` — poll verifies real process liveness (exit-code file + PID probe), never a stale in-memory state. |
| `tmux` | `tmux` | Persistent multi-turn terminal sessions (claude/codex/vim/REPLs). One typed tool with `action: create | send | capture | list | kill` against `target: local | <ssh-resource>`. See `tmux.md` for shell-vs-TUI patterns, `wait_mode` choices, `multiline_safe`, `include_ansi`, and the auto-suggestion safety rule. |
| `agents` | `spawn_subagent`, `spawn_subagents`, `subagent_status`, `subagent_result`, `subagent_list`, `subagent_cancel`, `agent_ask` | Agent-to-agent orchestration. `spawn_*` create sealed sub-sessions for delegated work; `subagent_*` poll/collect results; `subagent_cancel` aborts a running spawn tree (cascades to child-spawns, disk artifacts untouched). Finished async subs wake their parent with a `[subagent attention]` turn unless spawned with `attention:false` or the result was already fetched. Child spawns count against the parent persona's concurrent cap (4), with the last slot reserved for top-level spawns so an orchestrator sub can never lock its own agent out. `agent_ask` posts a live question into another agent's existing session (request-response: the target's normal reply flows back as the tool result). Blocking A2A waits are deadlock-guarded — the server tracks who waits on whom and rejects any call that would close a wait cycle (even across chains of 3+ agents) with an instructive error instead of letting both sessions hang. See `agents.md`. |
| `media` | `media_list` | Find images and video generated earlier, newest first, with an optional `type` filter. Its own toolset because the gallery is shared: a video-only install still needs to list what it made. |
| `video` | `video_generate`, `video_status`, `video_models` | Job-based text-to-video. `video_generate` returns immediately and the agent is woken when the render lands — it never waits. Global concurrency cap; the caller that finds it full is refused with the numbers rather than queued. `reference_images` takes paths and the order means something (one = opening frame, two = opening and closing). Hidden unless `videoGen` is configured. See `videogen.md`. |
| `image` | `image_generate`, `image_models` | Text-to-image against a configured image model, plus an index over everything generated. Specs (`aspect_ratio`, `resolution`, `quality`, `n`, …) are real request fields, validated against what the selected model actually accepts; the prompt is passed through verbatim. Returns paths and metadata rather than bytes — `return_image: true` opts into the image entering the agent's context. `reference_images` takes file paths (image-to-image); several may be combined. `image_models` lists the configured handles and what each one accepts. Hidden unless `imageGen` is configured. See `imagegen.md`. |
| `docs` | `somora_docs_list`, `somora_docs_read` | Read somora's own documentation (this directory). |
| `resources` | `resource_list`, `resource_test` | Discover and probe configured remote SSH targets. |
| `mcp` | `mcp__<server>__*` | Tools imported from external [MCP servers](mcp.md) configured in `mcp.servers`. Discovered at runtime, schema-sanitized, namespaced per server, and gateable per agent like any built-in tool. |
| `skills` | `skill`, `skill_list` | Activate a Markdown skill ("how to do task X with our tools"), or list all skills available to the agent. Skills live at `~/.somora/skills/<slug>/SKILL.md` (agentskills.io format). The system prompt carries a name+description registry; `skill` loads the full body on demand, `skill_list` re-fetches the registry fresh from disk (useful when an engine froze the system prompt at session start). See `skills.md`. |

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
  exposed, etc.)
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
- `memory.md` — per-agent memory inbox + retrieval mechanics
- `wiki.md` — shared long-term wiki layer
- `dream-phases.md` — REM/Deep/Lucid background consolidation
- `resources.md` — SSH targets that file_* / exec / tmux dispatch to
- `skills.md` — Markdown skill system + per-agent allow-list
- `files.md` — file_* tools + multimodal `analyze_file`
- `tmux.md` — shell-vs-TUI session patterns + capture/send modes
