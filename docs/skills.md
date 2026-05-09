# Skills

A **skill** is a Markdown document that tells the agent *how to do
task X with our tools*. It's pure instruction text — the agent reads
it and then performs the work itself with the regular tools (`file_*`,
`exec`, `tmux`, `web`, …). A skill never executes anything by itself.

Use skills for **repeated procedures** with non-obvious steps:
"how to make an Obsidian daily note in our format", "how to format a
payment-orchestration comparison", "how to ship a release". Avoid
them for one-off recipes — those live better in tool descriptions or
plain conversation.

## Mental model

```
~/.somora/skills/
├── obsidian-daily-note/
│   ├── SKILL.md            ← the body the agent reads
│   ├── scripts/            ← optional helpers (run via exec)
│   ├── references/         ← optional reference text (read via file_read)
│   └── assets/             ← optional templates / images
├── payment-comparison/
│   └── SKILL.md
└── …
```

The folder + `SKILL.md` shape follows the [agentskills.io
specification][1] — the same standard Claude Code, Cursor, Goose,
OpenHands and OpenClaw use, so skills are portable across tools.
somora-specific extras live under `metadata.somora.*` so strict
agentskills.io validators stay green.

[1]: https://agentskills.io/specification

## How an agent finds and uses a skill

Two pieces of system-prompt furniture:

1. **Registry** — every turn, somora renders an `<available_skills>`
   XML block listing each skill's `name`, `description`, and (when
   present) `when_to_use`. This block sits in the cached prefix so
   the agent always knows what's installed without paying tokens
   per turn.

   ```xml
   <available_skills>
     <skill>
       <name>obsidian-daily-note</name>
       <description>Create a daily note in the Obsidian vault following our conventions</description>
       <when_to_use>When user asks for "daily note", "heute", or wants to log something</when_to_use>
     </skill>
     …
   </available_skills>
   ```

2. **`skill` tool** — the agent calls `skill({name:"obsidian-daily-note"})`
   to load the full `SKILL.md` body into its context, then follows the
   instructions step by step using the normal tools. The body is loaded
   on demand, so adding skills doesn't bloat the prompt.

A skill the agent doesn't know it needs stays at registry-only cost
(~80 tokens per skill in cached prefix).

## Frontmatter schema

```yaml
---
name: obsidian-daily-note          # required, [a-z0-9-], ≤64, must equal dirname
description: Create a daily note   # required, ≤1024 chars; what + when in one sentence
license: MIT                       # optional (agentskills.io)
compatibility: macOS, Linux        # optional, ≤500 chars (agentskills.io)
allowed-tools: file_write tmux     # optional, agentskills.io experimental
metadata:
  somora:                          # somora-specific extras (free-form per spec)
    when_to_use: When user says "daily", "heute", or "log this"
    requires:
      bins: [obsidian-cli]         # binaries that must be on PATH
      config: [obsidian.vault_dir] # config keys that must be set
    tags: [obsidian, daily-routine]
---

# Body in Markdown

Step-by-step instructions to the agent. Reference scripts/, references/,
assets/ as relative paths — the agent reads them with file_read or
runs them with exec as needed.
```

Validation at scan time:

- `name` matches `^[a-z0-9]+(-[a-z0-9]+)*$` and equals the parent dir
- `description` ≤ 1024 chars
- `requires.bins` checked via `which`; missing → skill marked
  `unavailable` (still listed, with a reason)
- `requires.config` checked against the loaded config; missing →
  same `unavailable` treatment

Skills that fail to parse (broken YAML, name/dirname mismatch) are
warn-logged and silently skipped — the rest of the registry stays
intact.

## Per-agent allow-list

`agent.yaml`:

```yaml
# Variant 1 — no list = agent sees all skills
agent:
  name: <your-agent>

# Variant 2 — explicit allow-list = only these
agent:
  name: <your-agent>
  skills:
    - obsidian-daily-note
    - payment-comparison
```

An empty `skills: []` is treated the same as no list (lenient): the
agent gets all skills. To deny ALL skills, omit them from disk
entirely or use a list with one harmless name and remove it.

Allow-list entries that don't match any skill on disk are warn-logged
and ignored — typos don't break the agent.

## Creating a skill

Either hand-write a `SKILL.md` under `~/.somora/skills/<slug>/` or
ask the agent to do it — the `skill` tool's description teaches the
agent the path and schema, so a one-shot prompt like:

> Build me a `release-notes` skill that drafts our weekly release
> summary in the format we usually use.

is enough for the agent to `file_write` the right file in the right
place. After the file lands, the skill appears in `<available_skills>`
on the **next turn** — no server restart needed.

## The `skill` tool

Single tool: `skill({name})`. Returns:

```ts
{
  name: "obsidian-daily-note",
  description: "...",
  when_to_use?: "...",
  body: "<full markdown body>",
  available: true,
  unavailable_reason?: "missing bin: op",
  tags?: ["obsidian", "daily-routine"]
}
```

Errors with a clear message when:

- The name isn't in the registry → "skill 'X' not found. Available: …"
- The name exists but is filtered out for the calling agent → "skill 'X'
  exists but is not allowed for agent 'Y'. Allowed: …"
- The body file exceeds `config.skills.maxSkillFileBytes` (default 256
  KB) → size error

## Layer separation — what is and isn't a skill

| Layer | Scope | Example |
|---|---|---|
| **Tool description** | Mechanics of one tool, per-call safety | `tmux send` parameters, "never blindly press Enter on auto-suggestions" |
| **Skill** | Multi-step workflow / pattern | "How to spawn codex via tmux: create → send with multiline_safe → wait_idle → capture" |
| **Persona** (`AGENTS.md`) | Always-on voice / character | "Answers tersely, backend perspective, German" |
| **Memory** | User preferences / facts | "User prefers minimal commits, no emoji" |

Conflict resolution at the style level: **Memory > Skill** (user-
specific stylistic preferences override skill defaults). Skills should
describe STRUCTURE; memory layers STYLE on top. Persona is always-on
and shapes voice through everything.

If you find yourself adding "Rene wants X" to a skill body, it
belongs in memory instead. If you find yourself adding "use these N
tools in this sequence" to a tool description, it should probably be
a skill.

## Configuration

`config.yaml`:

```yaml
skills:
  maxSkillsInPrompt: 150     # registry caps before falling back to compact format
  maxPromptChars: 18000      # char budget for the rendered registry
  maxSkillFileBytes: 256000  # per-SKILL.md size cap on activation
```

Defaults mirror OpenClaw's battle-tested numbers. When the registry
exceeds either cap, somora falls back to compact format
(`name: description` per line, no `<when_to_use>`); on continued
overflow it hard-truncates alphabetically with a marker comment.

## Cross-references

- `private/skills-design.md` — full design rationale + what's in
  Phase X scaffold vs deferred
- `tools.md` — tool registration architecture (single source via
  `registerAllTools()`)
- `memory.md` — the layer that handles user-specific preferences
- `agents.md` — how agent.yaml is loaded
- [agentskills.io spec][1] — the external standard somora aligns
  with
