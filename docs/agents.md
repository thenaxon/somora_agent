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
mkdir -p ~/.somora/agents/lisa
cat > ~/.somora/agents/lisa/AGENTS.md <<'EOF'
---
name: lisa
description: Engineering-minded research assistant
icon: 🌼
---

- Be precise. Quote sources when you have them.
- Don't speculate beyond what's in your memory or the conversation.
- You are Lisa, not Hans.
EOF
```

The next `/agents` call from the CLI lists her — no server restart needed.

### Identity goes in AGENTS.md frontmatter

```yaml
---
name: lisa            # must match the directory name
description: ...      # one-line — shown by `/agents`
icon: 🌼              # optional emoji shown in CLI prompts and listings
---
```

### Operator config goes in agent.yaml

```yaml
# ~/.somora/agents/lisa/agent.yaml
model: opus           # alias OR provider/modelId
fallback: gpt55       # used when primary fails before producing any output

# Optional: Obsidian vault as a recall source
obsidian:
  vault: ~/Documents/Vault/
  readOnlyPaths:      # paths the agent should not write to
    - private/
    - work/clients/

# Optional: dream-mode (background memory consolidation)
dream:
  enabled: true
  model: gemma        # required when enabled — no fallback (intentional)
  idleMinutes: 30
  chunkTokens: 50000
  chunkTimeoutMs: 120000
```

The split between `AGENTS.md` (identity + behavioural rules, agent-editable)
and `agent.yaml` (operator config, you-edit-only) is intentional. When the
agent later gains the ability to update its own persona, it'll be limited to
`AGENTS.md`/`SOUL.md`/`USER.md` — `agent.yaml` stays under your control.

### Persona in three files

| File       | Role                                                                  |
| ---------- | --------------------------------------------------------------------- |
| `AGENTS.md` | Behavioural rules. "Reply concisely." "Use tools when asked, don't preface." |
| `SOUL.md`   | Voice / character. "I'm Lisa. I speak in short sentences. I have dry humour." |
| `USER.md`   | Static context about you. "User is Maria. Lives in Berlin. Two cats." |

All three are concatenated into the system prompt. Edit them in place; the
loader re-reads on every turn — no restart needed.

### Naming rules

Agent directory names must match `^[A-Za-z0-9_-][A-Za-z0-9_.-]*$`. No
spaces, no slashes. Lowercase is the convention.

## Switching agents and sessions

```
/agents                       — list all configured agents
/agent lisa                   — switch to lisa, drop into her main session
/agent lisa some-topic        — switch to lisa, session named "some-topic"

/sessions                     — list sessions of the current agent
/session some-topic           — switch to that session (newest match)
/new daily-2026-05-02         — create + switch to a new session
/main                         — back to the agent's main session
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
