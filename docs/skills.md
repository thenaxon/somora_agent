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
      bins: ["obsidian-cli>=1.4"]  # binaries that must be on PATH; an
                                   # optional version constraint (>=, <=,
                                   # ==, >, <) is enforced via `--version`
      config: [obsidian.vault_dir] # config keys that must be set
      env_vars:                    # env vars the skill needs at runtime —
        - OBSIDIAN_API_TOKEN       # set the values in ~/.somora/somora.env;
                                   # somora injects them automatically into
                                   # exec commands that invoke one of the
                                   # declared bins (and ONLY into those)
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
- `requires.bins` checked at scan time against PATH plus well-known
  user-install dirs (linuxbrew, homebrew, `~/.local/bin`, `~/go/bin`,
  `~/.cargo/bin`, `~/.npm-global/bin`, `~/bin`) so brew/cargo/go/npm
  binaries that aren't on the systemd-service PATH are still found.
  Missing → skill marked `unavailable` (still listed, with a reason).
  An entry may carry a version constraint (`"gog>=0.30"`); somora
  runs `<bin> --version` on the copy a spawned command would actually
  use (cached per binary until it changes on disk) and marks the
  skill `unavailable` with the found version + path when the
  constraint fails. Finding the SAME binary at multiple paths raises
  a warning naming every copy — two coexisting versions with
  incompatible state is exactly how the 2026-07-24 gog v0.12/v0.34
  keyring split-brain happened. Warnings show in `somora skill
  list` / `skill check` and the server log (`skills.bin_warning`).
- `requires.config` checked against the loaded config; missing →
  same `unavailable` treatment.
- `requires.env_vars` — availability-checked AND operational: set the
  values once in `~/.somora/somora.env` and somora injects them into
  local `exec` commands that visibly invoke one of the skill's
  declared bins. Commands that don't belong to the skill never see
  them (all skill-declared vars are stripped from exec children by
  default). Scoping details + limits below under "Secrets & env
  vars"; disable with `skills.envScoping: false` in config.yaml.

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

## Per-agent visibility

Skills are shared by every agent on the instance, but an individual
agent can be limited to a subset. Two ways to do that:

**The Abilities window in the web client** — the same matrix that
manages per-agent tools has a *skills* section below it: pick the
agent, click the eye on a skill to hide or show it. That writes an
exact-name `deny` list into the agent's `agent.yaml`, so a skill you
install next week is visible to that agent by default — hiding is the
exception, not a snapshot. Takes effect on the agent's next turn; no
restart.

**`agent.yaml` by hand** — same shape as `tools:`:

```yaml
# no section = agent sees all skills

# everything except these (what the web matrix writes)
skills:
  deny:
    - instagram-downloader

# only these — a hand-written policy; the web matrix shows it read-only
skills:
  allow:
    - github
    - skill-author

# the older list form still works and means the same as `allow:`
skills:
  - github
  - skill-author
```

`deny` beats `allow`; an empty `allow` (or the older empty `skills: []`)
means no restriction. Names that don't match any skill on disk are
warn-logged and ignored — typos don't break the agent.

Hidden is hidden everywhere: the skill is missing from the agent's
`<available_skills>` registry, from `skill_list`, and `skill` refuses
to activate it ("exists but is not allowed for agent …") — also when
another agent delegates work to it via `agent_ask`. Delegate to an
agent that has the skill instead.

HTTP: `GET /agents/:agent/skills` lists every skill with the agent's
`visible` flag; `PUT /agents/:agent/skills {deny, allow}` writes the
section (see [api.md](api.md)).

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
somora ships a dedicated resolver for it — pass any ClawHub URL
straight to `--from-url`. All of these shapes work:
`clawhub.ai/<owner>/skills/<slug>` (canonical web URL),
`clawhub.ai/<owner>/<slug>`, or the bare `clawhub.ai/<slug>` shortcut:

```
somora skill add gog --from-url https://clawhub.ai/steipete/skills/gog
```

Prefer the owner-qualified URL: ClawHub slugs are not unique across
owners, and for a contested slug the API answers a bare-slug lookup
with `409 AMBIGUOUS_SKILL_SLUG`. The resolver carries the owner from
the URL through both API calls; when you do hit the 409 (bare-slug URL
of a contested skill), the error lists every candidate URL so you can
re-run with the right one.

What the resolver does end-to-end:

1. Detects the ClawHub host and routes through the resolver instead
   of the plain fetch path.
2. Hits `GET https://clawhub.ai/api/v1/skills/<slug>[?owner=<owner>]`
   for the canonical slug + latest version + moderation status.
   Refuses the install if ClawHub has the skill flagged as
   malware-blocked.
3. Downloads the zipped bundle via
   `GET https://clawhub.ai/api/v1/download?slug=<canonical>[&owner=…]`
   (50MB hard cap, 60s timeout).
4. Unpacks the ZIP with path-sanitization (no `..`, no absolute
   paths, text-file allowlist), strips the common top-level folder,
   keeps `SKILL.md` plus any text sub-resources (BOOTSTRAP.md,
   scripts/, references/, etc.).
5. Translates ClawHub-shape frontmatter to `metadata.somora.*` so
   somora's loader picks up the `requires.bins` / `env_vars` runtime
   checks. All three namespaces found in the wild are recognized —
   `metadata.openclaw.*` plus the legacy `metadata.clawdbot.*` and
   `metadata.clawdis.*`. The original block stays in place; the file
   remains valid in both ecosystems.
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

## The `skill_list` tool

Companion read-only tool: `skill_list({})` — no arguments. Returns the
same catalogue as the `<available_skills>` prompt block (name,
description, `when_to_use`, availability, tags), fetched fresh from disk
and filtered by the calling agent's allow-list.

Why it exists: CLI engines compact their own context; a long-running
session can lose the registry that way — and skills added after session
start may not appear until the next turn. `skill_list` is the on-demand answer:
call it before concluding that no suitable skill exists, then activate
with `skill({name})`.

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

**Why skill credentials go in env vars, not `config.yaml`:** skill
subprocesses are spawned by the `exec` tool and they don't read
`config.yaml` at all — they read environment variables the same way
they would when you run them by hand in a shell. Service-level env-
files (systemd `EnvironmentFile=`, launchd `EnvironmentVariables`)
are the natural fit and let you rotate creds without restarting on a
code change. (Provider API keys for openai-compatible LLMs are a
separate story — those live in `config.yaml` because that's where
somora's own engine reads them. See `config.example.yaml` for the
posture.)

`requires.env_vars` in the skill frontmatter declares WHAT the skill
needs. The `EnvironmentFile` / `~/.somora/somora.env` provides the
actual values. From there, somora scopes them by program name:

- Every env var declared by ANY skill is **stripped** from spawned
  local `exec` children by default.
- A command that visibly invokes one of a skill's `requires.bins`
  gets exactly **that skill's** vars injected back. `gog drive sync`
  sees `GOG_*`; `ls` and every other skill's commands don't.
- Matching scans all command tokens, so compound commands
  (`cd x && gog sync`) work. The log line `exec.skill_env_injected`
  records every match.

Known limits: a script that calls the bin only *indirectly* doesn't
match — invoke the bin visibly or pass the var explicitly via the
exec `env` parameter (an explicit `env` always wins). When such a
command fails and its output names one of the stripped vars, the exec
result carries a `hint` saying exactly that, so the bin's own "set
VAR" message isn't mistaken for a broken bootstrap. A skill that
declares `env_vars` but no `bins` can never match — declare the
bins. tmux panes (interactive, no command to match at create time)
and remote exec (remote host's own env) are not covered. The
`skill` tool surfaces the env-var names back to the agent so it can
ask the user for any that aren't set. Opt out entirely with
`skills.envScoping: false` (restores full-inheritance behavior).

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
  envScoping: true           # skill-declared env vars only reach exec commands
                             # that invoke the skill's bins (see "Secrets & env
                             # vars"); false = legacy full inheritance
```

Defaults mirror OpenClaw's battle-tested numbers. When the registry
exceeds either cap, somora falls back to compact format
(`name: description` per line, no `<when_to_use>`); on continued
overflow it hard-truncates alphabetically with a marker comment.

## Cross-references

- `tools.md` — tool registration architecture (single source via
  `registerAllTools()`)
- `memory.md` — the layer that handles user-specific preferences
- `agents.md` — how agent.yaml is loaded
- [agentskills.io spec][1] — the external standard somora aligns
  with
