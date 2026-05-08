# Agents

An **agent** is a distinct personality somora can chat as. You can have
many; each has its own memory, its own model preferences, and its own
optional Obsidian vault binding.

## Anatomy

```
~/.somora/agents/<name>/
├── AGENTS.md           ← required. behavioural rules + identity (frontmatter)
├── SOUL.md             ← optional. voice / personality
├── USER.md             ← optional. what the agent knows about you
├── agent.yaml          ← optional. operator-config (model, dream, vault)
├── memory/             ← agent-managed knowledge (markdown notes + sqlite index)
│   ├── *.md
│   ├── memory.db (+ -wal, -shm)
│   └── .dreams/        ← idle-trigger findings, awaiting your review
└── sessions/           ← chat history (jsonl + meta json per session)
    ├── main.jsonl
    └── 20260501-143022_some-slug.jsonl
```

## Creating a new agent

The minimum is an agent directory with an `AGENTS.md`. Everything else is
optional.

```bash
mkdir -p ~/.somora/agents/<your-agent>
cat > ~/.somora/agents/<your-agent>/AGENTS.md <<'EOF'
---
name: <your-agent>
description: Engineering-minded research assistant
icon: 🌼
---

- Be precise. Quote sources when you have them.
- Don't speculate beyond what's in your memory or the conversation.
- You are who the operator configured you as — stick to the
  description above and the SOUL.md voice.
EOF
```

The next `/agents` call from the CLI lists the new agent — no server
restart needed.

### Identity goes in AGENTS.md frontmatter

```yaml
---
name: <your-agent>    # must match the directory name
description: ...      # one-line — shown by `/agents`
icon: 🌼              # optional emoji shown in CLI prompts and listings
---
```

### Operator config goes in agent.yaml

```yaml
# ~/.somora/agents/<your-agent>/agent.yaml
model: opus           # alias OR provider/modelId
fallback: gpt55       # used when primary fails before producing any output

# Optional: cross-engine thinking depth (off|low|medium|high)
# Per-session override via /thinking <level>. Only applies to models with
# the `reasoning` capability — see thinking.md.
thinking: medium

# Optional: per-agent workspace override. Default cwd for the file_* tools.
# Falls back to config.workspace.default (~/somoraworkspace) when unset.
workspace:
  path: ~/<your-agent>-workspace

# Optional: hide remote resources from this agent. By default every
# resource defined in config.yaml is visible. See resources.md.
resources:
  deny: ['production-db']

# Optional: dream-mode (background memory consolidation)
dream:
  enabled: true
  model: gemma        # required when enabled — no fallback (intentional)
  idleMinutes: 30
  chunkTokens: 50000
  chunkTimeoutMs: 120000
```

The split between `AGENTS.md` (identity + behavioural rules, agent-editable)
and `agent.yaml` (operator config) is intentional but not enforced as a
hard limit — the agent **can** edit `agent.yaml` via the `file_*` tools,
the path-blacklist allows it. The convention is: persona-content evolves
in the .md files, operator-config evolves in .yaml. Agents can self-edit
both today; future Skills-layer guidance will steer them toward the right
file for each kind of change.

### Self-edit and cross-agent edit

Each agent gets a small self-pointer block prepended to its system prompt
at every turn. It tells the agent its name, where its persona files
live, the workspace path, the global config location, and which remote
resources are configured. This means the agent can run e.g.:

```
file_write({ path: "~/.somora/agents/<your-agent>/USER.md", content: "...", mode: "overwrite" })
file_read({ path: "~/.somora/agents/<your-agent>/agent.yaml" })
file_patch({ path: "~/.somora/config.yaml", old_string: "...", new_string: "..." })
```

…to update its own state without you having to dictate paths.

**Cross-agent editing is intentionally allowed.** One agent can rewrite
another's `AGENTS.md`, adjust their `agent.yaml`, or add notes to
their memory. Agents shape each other in this design, not just
themselves. The only files in `~/.somora/agents/<*>/` that stay
off-limits are the `sessions/` dirs (append-only conversation logs
managed by somora's storage layer). See `files.md` for the full
write blacklist.

To learn more about somora's own architecture, agents can call
`somora_docs_list` and `somora_docs_read` — those tools serve the
contents of this `docs/` directory.

### Persona in three files

| File       | Role                                                                  |
| ---------- | --------------------------------------------------------------------- |
| `AGENTS.md` | Behavioural rules. "Reply concisely." "Use tools when asked, don't preface." |
| `SOUL.md`   | Voice / character. "I speak in short sentences. I have dry humour." |
| `USER.md`   | Static context about you. "User is Maria. Lives in Berlin. Two cats." |

All three are concatenated into the system prompt. Edit them in place; the
loader re-reads on every turn — no restart needed.

### Naming rules

Agent directory names must match `^[A-Za-z0-9_-][A-Za-z0-9_.-]*$`. No
spaces, no slashes. Lowercase is the convention.

## Switching agents and sessions

```
/agents                          — list all configured agents
/agent <name>                    — switch to <name>, drop into its main session
/agent <name> some-topic         — switch to <name>, session named "some-topic"

/sessions                        — list sessions of the current agent
/session some-topic              — switch to that session (newest match)
/new daily-2026-05-02            — create + switch to a new session
/main                            — back to the agent's main session
```

`main` is a magic name — every agent always has one, you can't delete it.
Use `/reset YES` to archive the current main and start fresh while keeping
the old content as an archived session you can resume any time.

## Per-session model overrides

Each agent has a default model from `agent.yaml`. You can override per
session:

```
/model                        — show what's effectively used now
/model gemma                  — use gemma for this session only
/model default                — drop the override, fall back to agent default
/models                       — list every configured model with its alias
```

Overrides are stored in the session's meta-file and survive across server
restarts.

## Programmatic agent creation

If you want to script agent creation, the directory layout is the contract.
Drop the files into `~/.somora/agents/<name>/` and they're picked up on the
next `GET /agents` request.

The HTTP API:

```
GET    /agents                                   list agents
GET    /agents/:agent/sessions                   list sessions
POST   /agents/:agent/sessions    {slug}         create session
POST   /agents/:agent/sessions/:session/reset    archive + reset (spawns dream if configured)
GET    /agents/:agent/memory/notes               list memory notes
GET    /agents/:agent/memory/search?q=…          hybrid recall (debug)
POST   /agents/:agent/tools/:name                invoke a tool directly (debug)
```

See [memory.md](memory.md) for memory-layer specifics and
[dream-mode.md](dream-mode.md) for the dream system.
