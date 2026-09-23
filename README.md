<p align="center">
  <img src="docs/images/somora-hero.png" alt="somora — agent runtime. Run. Rest. Dream. Agents that dream of what they did and never forget." />
</p>

# somora 🐨

> **Your AI team. Shared memory. Your choice of models.**
>
> Run personal AI agents on your own machine, switch between Claude, ChatGPT,
> Grok and local models in the middle of a conversation, and let the agents
> turn what they learn into a shared long-term wiki while they sleep.
> Run. Rest. Dream.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: active dev](https://img.shields.io/badge/status-active%20dev-green.svg)](#status)
[![Node ≥22](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](#requirements)

## See it

![somora web screenshot — browser desktop with multi-window chat, agent dock, and tmux app](docs/images/somora-web-2026-05-23.png)

<table>
  <tr>
    <td width="66%" valign="top">
      <img src="docs/images/somora-tui-2026-05-23.png" alt="somora TUI screenshot — terminal multi-agent chat with memory injection and tool calls" />
    </td>
    <td width="34%" valign="top">
      <img src="docs/images/somora-mobile-2026-05-23.png" alt="somora mobile PWA screenshot — avatar row at the top, A2A reply from one agent quoting two others, paperclip + camera + mic + send input bar at the bottom" />
    </td>
  </tr>
</table>

Browser desktop, terminal, and installable phone app — all talking to the
same local server, the same agents, the same memory.

## Why somora

- **A personal agent team.** Configure as many agents as you want, each
  with its own character, private memory, model preferences, and tool
  permissions. A `team.yaml` tells every agent who reports to whom. Agents
  delegate to each other: one spawns a sub-agent for a task, another asks a
  colleague a question mid-turn, and an answer that arrives after the turn
  ended still reaches the one who asked.
- **Knowledge that compounds.** Agents notice facts while you chat, keep
  them privately, and a background dream cycle promotes stable knowledge
  into a shared Obsidian wiki — with your approval where it matters. What
  one agent learns today, another can use next week.
- **Any model, one conversation.** Flip between Claude (your Claude
  subscription), ChatGPT (your ChatGPT subscription), Grok, or any
  OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, OpenRouter) with a
  slash command. History and tools carry over; the same tool registry
  feeds all four engines.
- **Yours.** Config, agent memory, sessions and attachments live in
  `~/.somora/`; the shared wiki lives in your Obsidian vault; workspace
  files and generated media in your configured workspace. Which models and
  which external services your agents talk to is your configuration, not a
  default.

## What is somora?

A small server you run on your machine that hosts your agents. You chat
with them from the terminal, the browser, or your phone; they remember
things across sessions; they use the same typed tools — memory, files
(numbered reads, tolerant patches, filtered search), web, shell, tmux,
attachments, sub-agents — regardless of which LLM you point them at. Everything an agent is asked to do — a question from you, a
question from another agent, a sub-agent, a scheduled trigger, a voice
call — goes through one queue per session that you can see and take back
from in every client.

## Two kinds of agents

Every agent is one of two kinds, chosen when it is created and never
changed. Most of your agents are **chat agents**. A **builder** is the
one you give a repository to.

| | Chat agent | Builder |
|---|---|---|
| **What it is for** | Talking, thinking, remembering, orchestrating: the assistant you ask, the analyst, the coordinator | Building software in a repository: plan, edit, run, test, report |
| **Its prompt** | Its persona (`AGENTS.md`, `SOUL.md`, `USER.md`), your team, the wiki map, memory recall | Harness rules, an environment block, the repository's own `AGENTS.md`/`CLAUDE.md`; no persona, no memory recall |
| **Tools** | The whole programme, gated per agent | A short coding set: files, shell, task list, questions, helpers, colleagues, search |
| **Turns** | A few rounds; the loop stops at 30 tool calls | Hours; hundreds of rounds, compaction mid-turn, a task list you watch |
| **Memory** | Notices facts, dreams them into notes and the wiki | Reads memory, never writes it; does not dream |
| **Works in** | Its workspace | The pinned project's folder, and only there |
| **Window** | Chat | Chat plus a task panel: mode, plan → Go, tasks, questions, running time |
| **Made how** | `somora agent create`, or an agent creates one | The same, with `kind: builder` — fixed for life |

You can talk to a builder directly — describe the project, let it plan,
press Go — or let a chat agent hand it the order in one call and be
woken with the report. The hand-over procedure ships as a skill. Details
in [docs/builder.md](docs/builder.md); chat agents in
[docs/agents.md](docs/agents.md).

On top of chat and memory, each optional and off until configured:

- **Skills** — Markdown how-tos an agent can activate, with declared
  binaries and secrets that somora checks and injects
  ([docs/skills.md](docs/skills.md)).
- **Media generation** — point somora at an image or video endpoint and
  both you and your agents can make pictures and film; results land in
  your workspace and in one gallery ([docs/imagegen.md](docs/imagegen.md),
  [docs/videogen.md](docs/videogen.md)).
- **Shared browser** — a real Chromium per agent that the agent drives and
  you can watch and take over in the web client: sign in, pass a 2FA
  prompt, hand back, and the agent continues in the same tab
  ([docs/browser.md](docs/browser.md)).
- **Talking to an agent** — a standing, interruptible voice call in the
  web client: a realtime model does the talking, the agent does the
  knowing, and a long answer is read out when it lands
  ([docs/realtime-voice.md](docs/realtime-voice.md)). Separate from
  dictation and spoken replies ([docs/voice.md](docs/voice.md)).
- **Projects** — bind a session to a real-world thing via a manifest of
  pointers the agent sees in its prompt ([docs/projects.md](docs/projects.md)).
- **Sentinel** — time-based triggers (`at` / `every` / `daily` / `cron`)
  that wake an agent on a schedule ([docs/sentinel.md](docs/sentinel.md)).
- **External MCP servers** — one config entry, all engines see the tools,
  gateable per agent ([docs/mcp.md](docs/mcp.md)).
- **Builders** — agents of a second kind that are coding harnesses: a
  short coding tool set, harness rules instead of a persona, long turns,
  a task panel with the plan, the task list and the questions they ask
  you. Describe a project, let the builder plan, press Go — or let
  another agent hand over the order in one call and be woken with the
  report; one builder per folder at a time, and the hand-over procedure
  ships as a skill ([docs/builder.md](docs/builder.md)).
- **Steering** — type into a running turn instead of behind it: the
  model reads your message at its next step and changes course, on every
  engine ([docs/api.md → Steering](docs/api.md#steering)).

## Requirements

Hard:

- **Node ≥22.13** — uses native `node:sqlite` plus `better-sqlite3`. On an
  older Node every `somora` command stops with the upgrade steps.
- **tmux** — for the `tmux` tool (long-lived terminal sessions for agents)
  and the web tmux app.
- **At least one LLM backend:** the Claude Code binary (Claude
  subscription, engine `claude-cli`); a ChatGPT subscription (engine
  `codex-cli` — Codex is bundled, `somora codex login`); the Grok Build CLI
  (SuperGrok/Premium, engine `grok-cli`); or any OpenAI-compatible HTTP
  server (Ollama, LM Studio, vLLM, oMLX, OpenRouter, …).

Optional: an **Obsidian vault** for the shared wiki and read-only vault
recall; **Tailscale** for HTTPS to the web and mobile clients
(`tailscale cert`, needed for HTTP/2 and the microphone, screen-share and
clipboard APIs); **ripgrep** for `file_search`; **Chromium or Chrome** for
the shared browser.

[docs/setup.md](docs/setup.md) is the full install walkthrough,
[docs/models.md](docs/models.md) lists the models known to run with somora
and their tested config blocks.

## Quickstart

> somora is installed **from source** — there is no npm registry release
> yet. `npm pack` + tarball install is the supported path; updates come via
> `somora update`.

### Already using a coding agent? Let it set up somora.

If you already run Claude Code, Codex CLI or another AI agent with
terminal access to your machine, hand it the setup. It reads the docs,
does the install and configuration below, and gets you a complete
instance — model providers, agents, a team, memory, skills, resources —
not just a running server. Copy this into your agent:

```text
Set up somora for me from the official repository:
https://github.com/thenaxon/somora_agent

Read the current README, then docs/setup.md, docs/models.md,
docs/agents.md, docs/team.md, docs/resources.md and docs/skills.md.
Inspect my environment, then install and configure somora using the
supported install method from the README (npm pack + tarball).

Aim for a complete, useful setup, not just a running server:
- Help me choose model providers and connect the CLI logins or API
  access I already have. Use the documented model configurations
  (engine, reasoning mapping, context window, capabilities, sampling,
  fallback) from docs/models.md — don't guess model IDs.
- Set up my agents and a coherent team with clear roles and
  delegation rules (docs/agents.md, docs/team.md), including one
  builder agent for coding work if I have a repository to work in
  (docs/builder.md).
- Configure the features that fit me: memory and the dream phases,
  skills, projects, scheduled tasks (sentinel), the shared browser, and
  image, video or voice generation where I have a backend for it. Explain
  optional features and what they need rather than silently skipping them.
- Connect the machines and services I want as resources
  (docs/resources.md).
- Ask concise questions for missing preferences, credentials or
  decisions.
- Verify: the server is healthy, a chat turn answers on the
  configured model, tools run, and every integration you set up
  works. Summarise what works and what still needs my input.

Preserve unrelated services and configuration. Ask before making
disruptive changes. Never invent model IDs, credentials, resources or
configuration options that the docs don't describe.
```

### By hand

```bash
# 1. Prereqs (see docs/setup.md for details per OS)
sudo apt install tmux ripgrep         # Debian/Ubuntu
# brew install tmux ripgrep           # macOS

# 2. Install somora from source — npm pack builds the web clients, then
#    the tarball is installed globally (a bare `npm install -g .` falls
#    into npm's link semantics on some setups and leaves a broken install)
git clone https://github.com/thenaxon/somora_agent.git somora
cd somora
npm install -g "$(npm pack | tail -1)"
# apply the package overrides inside the installed copy (npm honours
# `overrides` only for a root project, not for a globally installed one)
(cd "$(npm root -g)/somora" && npm install --omit=dev --no-audit --no-fund)

# 3. Log in to at least one LLM backend (pick one or more)
npm install -g @anthropic-ai/claude-code  &&  claude login   # Claude subscription
somora codex login                        # ChatGPT subscription; Codex is bundled
# local models: run Ollama / LM Studio / oMLX and add the endpoint to
# ~/.somora/config.yaml after step 4

# 4. First-run setup + start
somora init                    # creates ~/.somora/ and registers the systemd unit
somora server start            # starts the unit (auto-starts on login)
somora tui                     # the default agent is created on first run
```

Once you have more than one agent, `somora team init --principal "<your
name>"` writes `~/.somora/team.yaml` so every agent knows who is who — or
arrange it in the **team** tile of the web client
([docs/team.md](docs/team.md)). The web client, providers and Tailscale
HTTPS are in [docs/setup.md](docs/setup.md); hacking on somora itself in
its [contributor section](docs/setup.md#develop-from-a-checkout-contributors).

## Status

Active development. Open to early testers. The core surface (memory +
wiki + dream system + web + tmux + mobile) is feature-complete and used
daily:

| Capability | claude-cli | codex-cli | grok-cli | openai-compatible |
|---|:-:|:-:|:-:|:-:|
| Chat (streaming) | ✓ | ✓ | ✓ | ✓ |
| Memory auto-injection | ✓ | ✓ | ✓ | ✓ |
| Memory tools (read + write) | ✓ via MCP | ✓ dynamic tools | ✓ via MCP | ✓ in-process |
| Wiki layer (shared) | ✓ | ✓ | ✓ | ✓ |
| Three-phase dreams | ✓ | ✓ | as chat model only¹ | ✓ |
| Tool surface | ✓ via MCP | ✓ dynamic tools | ✓ via MCP | ✓ in-process |
| Skills (markdown how-tos) | ✓ | ✓ | ✓ | ✓ |
| Multimodal attachments (image, PDF) | ✓ native | ✓ image native, PDF rasterized | text only | ✓ image; PDF native or rasterized per provider |
| Image + video generation² | ✓ via MCP | ✓ dynamic tools | ✓ via MCP | ✓ in-process |
| Sub-agents, agent-to-agent questions, follow-ups | ✓ | ✓ | ✓ | ✓ |
| SSH-resource exec | ✓ | ✓ | ✓ | ✓ |

¹ grok-cli has no one-shot path, so it cannot serve as a dream or
compaction *worker* — configure those on another engine.

² Off until an `imageGen` / `videoGen` block exists. Verified end-to-end
against a self-hosted OpenAI-shaped endpoint; the hosted providers
(OpenAI images/video, Google Veo) are implemented to their published
shapes but **not yet tested against a live account**.

## Architecture at a glance

```
   you (terminal · browser · phone)   another agent   a voice call   a timer
                    │                       │              │            │
        TUI / Web / Mobile PWA           agent_ask     realtime      sentinel
                    │                       │              │            │
                    └──── HTTP + SSE · WebSocket ──────────┴────────────┘
                                          ▼
   somora-server
   │
   ├─ Turn dispatch — one entry for every turn, whoever started it
   │    one queue per session, first come first served · Stop reaches every turn
   │    work ledger: what runs, what waits, what is arriving · wakes when
   │    late results land · follow-ups to whoever asked · visible in every client
   │
   ├─ Engines           claude-cli · codex-cli · grok-cli · openai-compatible
   │    one tool registry for all four (in-process · MCP child · Codex dynamic tools)
   │
   ├─ Tools             memory · dream · wiki · file · exec + tmux · web · agents
   │                    skills · sentinel · browser · image · video · media · projects
   │                    + external MCP servers — every tool gateable per agent
   │
   ├─ Memory            ~/.somora/agents/<name>/memory/*.md   per agent, private
   │  Wiki              <obsidian-vault>/<wiki-subfolder>/    shared, long-term
   │  Vault             the rest of the vault                 read-only context
   │                    hybrid retrieval (SQLite + sqlite-vec + FTS5), one index per source
   │
   ├─ Dream system      REM  session → memory   ·   Deep  memory → wiki   ·   Lucid  wiki review
   │
   ├─ Sentinel          ~/.somora/sentinel/triggers.json — time-based fires as agent turns
   │
   ├─ Optional          realtime voice call · Chromium per agent · image + video generation
   │
   └─ Storage           sessions as JSONL · attachments content-addressed · config.yaml
                        all under ~/.somora/
```

## Clients

Three first-party clients, all hitting the same local server:

| Client | Launch | What you get |
|---|---|---|
| **TUI** | `somora tui` | Terminal multi-agent chat with full keyboard control, the session's queue (`/queue`), memory and tool detail toggles. |
| **Web** | `https://<host>.<tailnet>.ts.net:18737/web/` | A browser desktop: one window per agent, drag-and-drop attachments and screenshots, tmux app and shell terminal, Wiki Explorer with link graph, Media gallery, Sessions browser, the agent's Chromium window, server log, Abilities matrix (which tools and skills each agent may use), Team and Agent windows, a queue badge per session (what runs, what waits, what is arriving — take back or stop from there), dictation and spoken replies, and a voice window for a live call. HTTPS required; LAN-trust, no auth. [docs/web.md](docs/web.md) |
| **Mobile (PWA)** | `…:18737/mobile/`, then "Add to Home Screen" | The phone app: avatar row to switch agent, one chat per agent, the same queue sheet, voice input and spoken replies, photo/PDF attachments via the native picker. [docs/mobile.md](docs/mobile.md) |

Anything else can talk to the server the same way the clients do:
[docs/api.md](docs/api.md) is the HTTP + SSE + WebSocket reference.

## Documentation

Start at [docs/index.md](docs/index.md): what somora is, which page to read
for which goal, and every concept in one sentence.

- **Get running:** [setup](docs/setup.md) · [models](docs/models.md) · [agents](docs/agents.md) · [team](docs/team.md) · [security](docs/security.md)
- **Memory and knowledge:** [memory](docs/memory.md) · [wiki](docs/wiki.md) · [dream phases](docs/dream-phases.md) · [compaction](docs/compaction.md) · [cache strategy](docs/cache-strategy.md)
- **What agents can do:** [tools](docs/tools.md) · [builders](docs/builder.md) · [files](docs/files.md) · [tmux](docs/tmux.md) · [resources](docs/resources.md) · [skills](docs/skills.md) · [MCP servers](docs/mcp.md) · [projects](docs/projects.md) · [sentinel](docs/sentinel.md) · [browser](docs/browser.md) · [image generation](docs/imagegen.md) · [video generation](docs/videogen.md)
- **Clients and API:** [web](docs/web.md) · [mobile](docs/mobile.md) · [TUI display](docs/display.md) · [voice](docs/voice.md) · [realtime voice](docs/realtime-voice.md) · [API](docs/api.md)
- **Models in detail:** [thinking](docs/thinking.md) · [sampling](docs/sampling.md)

## License

[MIT](LICENSE).

---

🐨 *somora — patient, slow, with very good memory.*
