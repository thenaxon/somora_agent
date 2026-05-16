# somora docs — start here

A short guide so you don't have to read every page to get started.
somora is a **local-first gateway for personal AI agents with persistent
memory**. It runs as a long-lived service on your own machine, exposes
an HTTP+SSE API plus three first-party clients (TUI, web desktop,
mobile PWA), and lets you route conversations across Claude /
ChatGPT / any OpenAI-compatible model — all without giving up
ownership of the chat log, the memory layer, or your knowledge base.

## What is somora — in one paragraph

You define **agents** (personas with their own model, memory inbox, and
session). You talk to them from the TUI, the browser, or your phone.
The server orchestrates the actual LLM call against the engine you
configured (subscription or API), persists every message as JSONL,
and runs a three-phase background **dream system** that turns raw
session content into curated memory notes and a shared wiki over time.
All of that stays on your machine.

## Choose your path

You probably don't need every page below right away.

**I just want to try it.** Start with the [project README](../README.md)
quickstart — install prereqs, install somora from source, run `somora
init` + `somora server start`, then `somora tui`. ~10 minutes.

**I want to chat from the browser or my phone.** Read
[setup.md → HTTPS via Tailscale](setup.md#https-tailscale-required-for-the-web-client-at-scale)
to get a real cert, then open `https://<your-tailnet>.ts.net:18737/web/`
in the browser. The mobile PWA is the same URL with `/mobile/` — see
[mobile.md](mobile.md).

**I want to add a new provider / model.** [setup.md → Configuring
providers](setup.md#6-configuring-providers) plus the comment block in
[`config.example.yaml`](../config.example.yaml) is the full reference.

**I want my agent to do real work** — read files, run commands, search
the web, edit notes. The [tools overview](tools.md) lists the tool
families. [files.md](files.md), [resources.md](resources.md), and
[tmux.md](tmux.md) cover the heavy ones. [Skills](skills.md) are
markdown how-tos you install to teach an agent multi-step recipes.

**I want long-term memory + a shared knowledge base.** Read
[memory.md](memory.md) for the per-agent inbox, [wiki.md](wiki.md) for
the shared layer, and [dream-phases.md](dream-phases.md) for how
sessions automatically flow into both.

**I want to build a third-party client / integration.** [api.md](api.md)
is the HTTP+SSE contract — same surface the built-in clients use.

## Core concepts in one sentence each

- **agent** — a persona with its own `AGENTS.md`, memory inbox, default
  model, and chat sessions. Lives at `~/.somora/agents/<name>/`.
- **session** — a single chat thread with one agent. Persisted as JSONL,
  resumable, switchable mid-conversation.
- **engine** — the adapter that talks to an LLM backend. Three exist:
  `claude-cli` (Claude subscription), `codex-cli` (ChatGPT subscription),
  `openai-compatible` (any `/v1/chat/completions` endpoint — OpenRouter,
  Ollama, oMLX, LM Studio, …).
- **provider / model / alias** — `config.yaml` declares providers (with
  baseUrl + apiKey if needed) and models on each. An `alias` lets you
  refer to a model by short nickname anywhere.
- **memory** — three layers an agent reads from: its own per-agent
  inbox (`~/.somora/agents/<name>/memory/*.md`), the shared wiki, and
  the read-only Obsidian vault. Hybrid retrieval: vector + BM25.
- **wiki** — a curated long-term knowledge base shared across all
  agents. Lives under your Obsidian vault. Written by the dream system,
  editable by hand.
- **dream system** — three background phases. **REM** turns finished
  sessions into memory-inbox notes (per-agent). **Deep** promotes
  high-value notes into the shared wiki. **Lucid** cleans up the wiki
  on a slower cadence. See [dream-phases.md](dream-phases.md).
- **project** — an explicit pin of "files / paths / vault notes /
  research artifacts that belong to this chat session". Auto-injected
  into the agent's system prompt. See [projects.md](projects.md).
- **resource** — a configured SSH host. `file_*`, `exec`, and `tmux`
  tools dispatch against it via `target=<resource>`. See
  [resources.md](resources.md).
- **skill** — a markdown how-to (agentskills.io format) installed at
  `~/.somora/skills/<slug>/SKILL.md`. The agent loads the body on
  demand via the `skill` tool when it recognizes the situation.
- **tools** — the things an agent can call. Memory reads, wiki edits,
  file I/O, shell exec, tmux sessions, web search/fetch, sub-agent
  spawning, etc. See [tools.md](tools.md).

## Where to next

If you've installed somora and chatted with the default agent, the
high-value next steps in rough order:

1. **Create a second agent** with a different persona — copy the
   default `~/.somora/agents/<name>/AGENTS.md`, edit, restart.
2. **Configure a real provider** if you started on the subscription
   defaults — see [setup.md → Configuring providers](setup.md).
3. **Enable the wiki** by pointing somora at your Obsidian vault in
   `config.yaml`. The dream system then has somewhere to consolidate
   memory into. [wiki.md](wiki.md).
4. **Install your phone as a PWA** for chatting from anywhere on your
   tailnet. [mobile.md](mobile.md).
5. **Add an SSH resource** so an agent can read files and run commands
   on a remote machine. [resources.md](resources.md).
6. **Pin a project** to a session so the agent has a persistent
   working set. [projects.md](projects.md).

## Reference docs

| Doc | Reads like | When to open it |
|---|---|---|
| [setup.md](setup.md) | Operator runbook | First install; adding providers; HTTPS; mobile; ops |
| [api.md](api.md) | HTTP/SSE contract | Building a third-party client; debugging streaming |
| [tools.md](tools.md) | Tool catalog overview | Wondering what an agent can do |
| [files.md](files.md) | File-tool deep dive | Working with `file_read`/`file_write`/`analyze_file` |
| [memory.md](memory.md) | Concept + mechanics | Tuning recall, writing notes by hand |
| [wiki.md](wiki.md) | Concept + mechanics | Shared knowledge base, hand-curation |
| [dream-phases.md](dream-phases.md) | Background workers | REM/Deep/Lucid cadence + triggers |
| [projects.md](projects.md) | Concept + workflow | Pinning a working set to a session |
| [resources.md](resources.md) | SSH-target config | Adding a remote machine |
| [skills.md](skills.md) | Markdown skill format | Writing or installing skills |
| [tmux.md](tmux.md) | Multi-turn shell sessions | Driving long-running CLIs from agents |
| [web.md](web.md) | Browser client | Web-UI specifics + HTTPS notes |
| [mobile.md](mobile.md) | Mobile PWA | iOS/Android install, scope |
| [security.md](security.md) | Trust model | Network posture, sandbox stance |
