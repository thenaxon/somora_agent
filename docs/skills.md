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
  `~/.cargo/bin`, `~/.npm-global/bin`, `~/bin`) so brew/cargo/go/npm
  binaries that aren't on the systemd-service PATH are still found.
  Missing → skill marked `unavailable` (still listed, with a reason).
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

## Body linter (anti-pattern detection)

Skill bodies land in the agent's context verbatim whenever the
`skill` tool activates a skill, so anything written like an
instruction gets followed like an instruction. The loader runs a
**body linter** before exposing a skill to the agent. Lint errors
mark the skill `unavailable` (the body still ships, but with a
warning header so the agent doesn't blindly act on it).

Rules:

| Rule | Severity | What it catches |
|---|---|---|
| `setup-section-in-body` | error | `## Setup on this host` etc. — operator-only setup belongs in a `BOOTSTRAP.md` sibling (not loaded), not in the agent's per-turn context |
| `eval-brew-shellenv-in-body` | error | `eval $(brew shellenv)` inside fenced code blocks — agents reflexively prepend it to every command. PATH belongs in the somora launch environment, not the skill body |
| `export-env-in-body` | error | `export KEY=...` inside fenced code blocks — declare in `metadata.somora.requires.env_vars` and set via `~/.somora/somora.env` or the systemd EnvironmentFile |
| `env-prefix-cmd-in-body` | warning | `KEY=value cmd ...` inline snippets — same family as above, but soft-flagged |
| `html-document-in-body` | error | `<!DOCTYPE html>` / `<html>` at the body start — happens when `--from-url` pointed at a marketplace landing page; the body would be unusable HTML |
| `body-too-large` | warning | >200 lines — the body lands in every turn that uses the skill; split into sub-resources |

Linter is fence-aware: rules tagged `codeBlocksOnly` only fire inside
fenced blocks (since prose mentions of a pattern are usually
documentation, often in a "do NOT do X" sentence).

The bundled `gog` skill is the clean reference — `SKILL.md` is
usage-only, `BOOTSTRAP.md` next to it carries the one-time setup
notes (read on demand via `file_read`, not as ambient context).

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

## Creating a skill — the `somora skill` CLI

The recommended path is the bundled `somora skill` CLI, which
pre-flights the same body-linter the loader uses, writes atomically,
and verifies the result with the loader before printing success.

```
somora skill list [--all] [--available-only]
somora skill check <slug>
somora skill add <slug> [--template <name>] [--description <text>]
                        [--from-url <url>] [--from-file <path>]
                        [--force] [--yes]
somora skill update <slug>          # force re-seed of a built-in
somora skill remove <slug> [--yes]
```

### `somora skill add` — three sources

**From a template** — `default`, `cli-wrapper`, or `api-wrapper`:

```
somora skill add release-notes --template default \
  --description "Draft a weekly release summary in our format"
```

`cli-wrapper` is for skills that orchestrate a command-line tool
(includes a `BOOTSTRAP.md` sibling skeleton for operator notes).
`api-wrapper` is for HTTP-API skills.

**From a local file** — useful when you already have a `SKILL.md`:

```
somora skill add my-skill --from-file ./SKILL.md
```

**From a URL** — see next section for ClawHub; for any other URL the
CLI sniffs the response for HTML and rejects landing pages before
writing.

After a successful `add`, the loader-verification step confirms the
new skill is actually loadable (not just that bytes landed on disk).
Failures roll the change back so you never end up with a half-broken
skill folder.

### Agent flow

Either run the commands yourself or let the agent do it — the
bundled `skill-author` skill (a Skill-for-Skills) teaches every agent
to use this CLI instead of hand-writing `SKILL.md` with the `Write`
tool. After a `skill add`, the new skill appears in
`<available_skills>` on the **next turn** — no server restart
needed.

### Importing a ClawHub skill

[ClawHub](https://clawhub.ai) is OpenClaw's public skill registry.
somora ships a dedicated resolver for it — pass any
`clawhub.ai/<owner>/<slug>` URL straight to `--from-url`:

```
somora skill add github --from-url https://clawhub.ai/steipete/github
```

What the resolver does end-to-end:

1. Detects the ClawHub host and routes through the resolver instead
   of the plain fetch path.
2. Hits `GET https://clawhub.ai/api/v1/skills/<slug>` for the
   canonical slug + latest version + moderation status. Refuses the
   install if ClawHub has the skill flagged as malware-blocked.
3. Downloads the zipped bundle via
   `GET https://clawhub.ai/api/v1/download?slug=<canonical>` (50MB
   hard cap, 60s timeout).
4. Unpacks the ZIP with path-sanitization (no `..`, no absolute
   paths, text-file allowlist), strips the common top-level folder,
   keeps `SKILL.md` plus any text sub-resources (BOOTSTRAP.md,
   scripts/, references/, etc.).
5. Translates `metadata.openclaw.*` frontmatter to `metadata.somora.*`
   so somora's loader picks up the `requires.bins` / `env_vars`
   runtime checks. The original `metadata.openclaw` stays in place;
   the file remains valid in both ecosystems.
6. Runs the normal pre-flight lint + atomic write + post-write
   loader verification.

The resolver honors ClawHub's rate limits (30 anonymous req/min on
the download endpoint) — a `429` response surfaces the `Retry-After`
value in the error message.

### Updating a built-in skill

somora ships some skills bundled in its own package — currently
`skill-author` (the Skill-for-Skills). On server start, the
content-hash bootstrap seeds these into `~/.somora/skills/<slug>/`
the first time, then on each restart compares the on-disk SHA-256
against the recorded seeded-hash in
`~/.somora/.skill-seed-state.json`:

| User dir state | State-file hash | Action |
|---|---|---|
| Doesn't exist | — | **Seed** — copy template, record hash |
| Matches state-file (unedited) | matches | **Silent update** — overwrite with new template, record new hash |
| Doesn't match state-file (edited) | mismatched | **Leave alone** — warn-log with pointer to `somora skill update <slug>` |
| Exists but no state-file entry | adopted | **Adopt** — record current hash as baseline, no overwrite |

To force-re-seed a built-in (overwriting your local edits):

```
somora skill update skill-author
```

To add a new built-in to somora itself: drop a folder under
`templates/skills/<slug>/` in the somora repo, bump the version,
release. The bootstrap rolls it out to every user on next server
start.

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
