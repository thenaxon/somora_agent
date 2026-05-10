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
      env_vars:                    # env vars the skill needs at runtime —
        - OBSIDIAN_API_TOKEN       # somora does NOT auto-inject these,
                                   # the skill tool surfaces the list so
                                   # the agent + you know what to set
                                   # before invoking the skill's commands
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
- `requires.bins` checked at scan time. Hybrid lookup: a fast
  `which` first, then a stat-based scan of well-known user-install
  dirs (linuxbrew, homebrew, `~/.local/bin`, `~/go/bin`,
  `~/.cargo/bin`, `~/bin`) so brew/cargo/go binaries that aren't on
  the systemd-service PATH are still found. Missing → skill marked
  `unavailable` (still listed, with a reason).
- `requires.config` checked against the loaded config; missing →
  same `unavailable` treatment.
- `requires.env_vars` is documentation only — somora does NOT
  auto-inject these. The `skill` tool surfaces the list as
  `requires_env_vars` so the agent knows what to ask the user for
  (or look up in a personal secrets store) before running the
  skill's commands. Equivalent of OpenClaw's MCP-server `env`
  block, kept opt-in until somora has a first-class secrets store.

When a skill is `available: false`, the `skill` tool prepends a
warning header to the body so the agent doesn't blindly run
commands that the environment can't execute. The body still ships
in full — useful as reading material to reason about whether to
install the missing dep or run via `exec({target: <other-host>})`.

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

### Importing an existing ClawHub / OpenClaw skill

somora has no auto-installer for ClawHub today; bring a skill in
manually:

1. The raw `SKILL.md` for OpenClaw-published skills lives at
   `https://raw.githubusercontent.com/openclaw/openclaw/main/skills/<name>/SKILL.md`.
   Fetch it with `web_fetch` or curl.
2. Adapt the frontmatter to somora's namespace: somora reads only
   `metadata.somora.*`, so move OpenClaw's `requires` / `when_to_use`
   into a `metadata.somora` block. Leaving the original
   `metadata.openclaw.*` next to it is fine — it's ignored.
3. `file_write` the result to `~/.somora/skills/<slug>/SKILL.md`.
   The slug must equal the dirname AND the frontmatter `name`.
4. If the skill has scripts/ or assets/, fetch those into the same
   folder.
5. Hit the `skill` tool with the slug — body comes back live. If
   `available: false`, install the missing bin (or set the env vars
   from `requires_env_vars`) and call again.

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

## Providing credentials to skills

Many skills wrap CLIs that expect credentials in env vars
(`<TOOL>_TOKEN`, `<TOOL>_ACCOUNT`, etc.). somora deliberately has no
internal secrets store — the right place for service-level
credentials is the OS service manager:

**Linux / systemd (recommended):**

1. Put the variables in `~/.config/systemd/user/somora.env` and
   tighten permissions:

   ```bash
   cat > ~/.config/systemd/user/somora.env <<'EOF'
   MYSKILL_TOKEN=<your-token-here>
   MYSKILL_ACCOUNT=<you@example.com>
   EOF
   chmod 600 ~/.config/systemd/user/somora.env
   ```

2. Reference the file from the unit (the leading `-` makes the
   service start cleanly when the file is missing — useful for
   fresh setups):

   ```ini
   # ~/.config/systemd/user/somora.service
   [Service]
   EnvironmentFile=-%h/.config/systemd/user/somora.env
   ```

3. `systemctl --user daemon-reload && systemctl --user restart somora`

The somora process inherits these vars at startup and `exec`-spawned
subprocesses inherit `process.env`, so every skill on every agent
sees them automatically — no per-call boilerplate, no in-band
secret-passing.

**macOS / launchd** is the equivalent: drop the variables into your
`~/Library/LaunchAgents/<somora>.plist`'s `EnvironmentVariables`
dict, then `launchctl unload && load`.

**Why we DON'T put credentials in `config.yaml`:** that file is
designed to be readable / sharable / git-trackable for support
purposes. Keeping it secret-free means you can paste it into a bug
report without redacting. Service-level env-files separate the two
concerns cleanly.

`requires.env_vars` in the skill frontmatter documents WHAT the
skill needs. The `EnvironmentFile` provides the actual values. The
`skill` tool surfaces the env-var names back to the agent so it can
ask the user for any that aren't set.

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

If you find yourself adding "the operator wants X" to a skill body,
it belongs in memory instead. If you find yourself adding "use these
N tools in this sequence" to a tool description, it should probably
be a skill.

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
