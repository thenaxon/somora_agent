# somora docs

somora runs AI agents on your own machine. They remember what you told
them, work together as a team, and you talk to them from the browser,
the phone or the terminal. This page shows where to start and what
each page is for.

## What somora is

- **Agents with memory.** Each agent has its own character, model and
  notes. Background phases turn finished conversations into notes and
  into a shared wiki.
- **Your models.** A Claude, ChatGPT or Grok subscription, a local model
  server or an API key. somora brings no model of its own.
- **Three clients.** A desktop in the browser, an app for the phone and
  a terminal client. All talk to the same server.
- **Real work.** Agents read and write files, run commands, search the
  web, drive a browser and hand work to each other.
- **Local first.** Conversations, notes and the wiki are plain files on
  your machine.

## Start here

```bash
curl -fsSL https://somora.ai/install.sh | bash
```

The installer sets everything up and starts an assistant that connects
a model, creates your first agent and sends it a test message. That
takes about ten minutes. [Setup](setup.md) explains each step.

## Choose your path

| I want to … | Open |
|---|---|
| chat from the browser or the phone | [Setup](setup.md#https-via-tailscale) for HTTPS, or run `somora setup access`. Then [Web client](web.md) and [Mobile app](mobile.md). |
| add a provider or a model | [Setup](setup.md#connect-models) and [Models](models.md) |
| create another agent | [Agents](agents.md) |
| have my agents know who is who | [Team](team.md) |
| let an agent do real work | [Tools](tools.md), then [File tools](files.md), [Resources](resources.md) and [tmux](tmux.md) |
| teach an agent a recipe | [Skills](skills.md) |
| decide what each agent may use | [Tools](tools.md), [MCP servers](mcp.md#per-agent-tool-control) and [Skills](skills.md#per-agent-visibility) |
| have an agent build software | [Builder agents](builder.md) |
| give agents long-term memory | [Memory](memory.md), [Wiki](wiki.md) and [Dream phases](dream-phases.md) |
| talk instead of type | [Voice](voice.md) and [Realtime voice](realtime-voice.md) |
| have agents make images or video | [Image generation](imagegen.md) and [Video generation](videogen.md) |
| have agents act on a schedule or when something happens | [Sentinel](sentinel.md) |
| chat with agents of other systems (OpenClaw, Hermes) | [External agents](external-agents.md) |
| have my agents hand work to OpenClaw or Hermes, or take work from them | [A2A](a2a.md) |
| use my agents from an editor such as Zed | [ACP](acp.md) |
| let a model judge items for scripts and checks | [Decision models](decisions.md) |
| know what is exposed and to whom | [Security](security.md) |
| build my own client | [HTTP API](api.md) |

## The words somora uses

| Word | Meaning |
|---|---|
| **agent** | A persona with its own instructions, model, notes and conversations. Lives in `~/.somora/agents/<name>/`. A chat agent talks and coordinates. A builder plans and writes software. |
| **session** | One conversation with one agent. Stored as a file, can be resumed and switched. |
| **engine** | The way somora reaches a model: `claude-cli` (Claude subscription), `codex-cli` (ChatGPT subscription), `grok-cli` (SuperGrok or Premium subscription) or `openai-compatible` (any server or API that speaks the OpenAI chat format). |
| **provider, model, alias** | `config.yaml` lists providers and the models on each. An alias is a short name for a model that works everywhere. |
| **memory** | An agent's own short-term notes. Recalled automatically for every message, together with the wiki and your vault. |
| **wiki** | The long-term knowledge base shared by all agents. Lives in a folder, usually inside your Obsidian vault. |
| **dream phases** | Background work. REM turns conversations into notes. Deep moves lasting notes into the wiki. Lucid reviews the wiki. |
| **project** | A working set of paths and notes pinned to a session, shown to the agent in every turn. |
| **resource** | Another machine reached over SSH. File, shell and tmux tools can target it. |
| **external agent** | An agent of another agent system (OpenClaw, Hermes, …) you chat with from somora. It keeps its own model, tools and memory. |
| **A2A** | The Agent2Agent standard for agents of different systems giving each other tasks. somora agents hand external agents work with it and take work from them. Between somora's own agents, `agent_ask` needs no standard. |
| **skill** | A Markdown how-to the agent loads when the situation calls for it. |
| **tool** | Something an agent can call: read a file, run a command, search the web, ask another agent. |
| **sentinel** | A trigger that starts an agent turn on a schedule, or when a small check script sees that something happened. |
| **decision model** | A small model that answers typed questions (yes/no, choice, score) about some data. Agents, scripts and Sentinel checks ask it. |

## After the first chat

1. **Create a second agent** with a different job: `somora setup agent`.
2. **Turn on memory and the wiki**: `somora setup memory`.
3. **Put the app on your phone**: [Mobile app](mobile.md).
4. **Write the team file** once you have two agents: [Team](team.md).
5. **Add a machine** an agent may work on: [Resources](resources.md).
6. **Pin a project** to a session: [Projects](projects.md).

## All pages

### Getting started

| Page | Reads like | When to open it |
|---|---|---|
| [Setup](setup.md) | Operator runbook | First install, the setup assistant, HTTPS, updates, every command and server setting |
| [Models](models.md) | Model reference | Models known to run with somora, per engine, with the config values that work |
| [Security](security.md) | Trust model | Who can reach the server, what agents may do, where credentials live |

### Clients

| Page | Reads like | When to open it |
|---|---|---|
| [Web client](web.md) | Browser client | The desktop in the browser, window by window |
| [Mobile app](mobile.md) | Mobile PWA | Installing on the phone, sessions and model, what it can and cannot do |
| [TUI display](display.md) | Terminal client | What the terminal client shows, and every slash command |
| [Voice](voice.md) | Dictation and spoken replies | The microphone in web and mobile, optional spoken answers |
| [Realtime voice](realtime-voice.md) | Talking to an agent | A standing call you can interrupt: the voice talks, the agent knows |

### Agents & team

| Page | Reads like | When to open it |
|---|---|---|
| [Agents](agents.md) | Persona and `agent.yaml` reference | Creating an agent, and every per-agent setting |
| [Team](team.md) | Org chart for agents | Telling every agent who is who and who to involve |
| [Builder agents](builder.md) | The builder kind | An agent that builds software: plan, Go, build, with a task panel and questions |
| [Projects](projects.md) | Concept and workflow | Pinning a working set to a session |
| [Sentinel](sentinel.md) | Trigger runtime | Waking agents on a schedule or when a check script sees a change |
| [External agents](external-agents.md) | Agents of other systems | Chatting with OpenClaw, Hermes and other ACP agents from somora |
| [A2A](a2a.md) | Work between systems | Your agents ask external agents or send them off as sub-agents, and take tasks from them, over the A2A standard |
| [ACP](acp.md) | somora in an editor | `somora acp` for Zed, JetBrains and other ACP clients, locally or over SSH |

### Memory

| Page | Reads like | When to open it |
|---|---|---|
| [Memory](memory.md) | Concept and settings | How agents remember, writing notes by hand, tuning recall |
| [Wiki](wiki.md) | Concept and settings | The shared knowledge base, its structure, editing by hand |
| [Dream phases](dream-phases.md) | Background workers | What REM, Deep and Lucid do, when they run and how to review them |
| [Compaction](compaction.md) | Context management | When and how a session is summarised, which model does it, what `contextWindow` controls per engine |

### Tools & integrations

| Page | Reads like | When to open it |
|---|---|---|
| [Tools](tools.md) | Tool catalog | Every tool an agent can have, and how to limit them per agent |
| [File tools](files.md) | File tools in depth | Working with `file_read`/`file_write`/`analyze_file` |
| [Image handling](image-handling.md) | How images travel | Which file a model sees and which one a tool gets |
| [Decision models](decisions.md) | Typed decisions | Asking a decision model yes/no, choice and score questions, with images |
| [Resources](resources.md) | SSH targets | Adding a remote machine |
| [tmux](tmux.md) | Multi-turn shell sessions | Driving long-running CLIs from agents |
| [Shared browser](browser.md) | Shared browser | A Chromium per agent profile that agents drive and you can take over for logins |
| [Language servers](lsp.md) | Language servers | A builder's writes come back with the compiler's errors |
| [MCP servers](mcp.md) | External MCP servers | Plugging third-party MCP tools into your agents |
| [Skills](skills.md) | Markdown skill format | Writing or installing skills |
| [Image generation](imagegen.md) | Text-to-image | Generating images from the web app or an agent |
| [Video generation](videogen.md) | Text-to-video | Job-based renders, and how an agent gets its result without waiting |

### Model tuning

| Page | Reads like | When to open it |
|---|---|---|
| [Thinking](thinking.md) | Reasoning depth | Per-engine thinking levels, session overrides |
| [Sampling](sampling.md) | Sampling parameters | temperature, top_p and friends per model, agent and session |
| [Prompt cache](cache-strategy.md) | Prompt-cache mechanics | Why the system prompt is ordered the way it is |

### Reference

| Page | Reads like | When to open it |
|---|---|---|
| [HTTP API](api.md) | HTTP and SSE reference | Building your own client or integration |
