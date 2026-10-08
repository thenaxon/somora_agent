# Skills

A skill is a Markdown file that tells an agent how to do one recurring
task with the tools it already has. The agent sees a short list of all
skills, loads the full text of one when a task fits, and then does the
work itself. A skill never runs anything on its own.

## What you get

- **Procedures written once.** "How we ship a release" or "how a daily
  note looks" lives in one file instead of being explained in every chat.
- **A small prompt.** Only name and description of each skill are in the
  prompt. The full text is loaded when it is needed.
- **A portable format.** The folder with a `SKILL.md` follows the
  [agentskills.io specification](https://agentskills.io/specification),
  so skills move between somora and other agent tools.
- **Honest availability.** A skill names the programs, settings and
  variables it needs. If one is missing, the agent is told why.
- **Scoped credentials.** A variable a skill declares reaches only the
  commands that call that skill's programs.
- **Per agent control.** Hide a skill from one agent with a click.

## Try it

Create a skill from the default template:

```bash
somora skill add release-notes \
  --description "Draft the weekly release summary in our format"
```

Open `~/.somora/skills/release-notes/SKILL.md` and replace the
placeholder steps with your procedure. Then check it:

```bash
somora skill check release-notes
```

On its next turn the agent lists the skill and loads it when you ask for
release notes. No restart is needed.

You can also ask an agent to write the skill. The built in skill
`skill-author` teaches every agent to use this command line.

## When a skill is the right place

Use a skill for a repeated procedure with steps that are not obvious.
Other things belong elsewhere:

| Layer | Holds | Example |
|---|---|---|
| Tool description | How one tool works | The parameters of `tmux send` |
| **Skill** | A workflow over several steps | "Create the pane, send the prompt, wait until idle, capture the output" |
| Persona (`AGENTS.md`) | Voice and character, always on | "Answers tersely, in German" |
| Memory | What the user prefers | "No emoji in commit messages" |

A skill describes structure. When a skill and a remembered preference
disagree on style, the preference wins. "The user wants X" belongs in
memory, not in a skill.

## Where skills live

```
~/.somora/skills/
├── release-notes/
│   ├── SKILL.md            ← the text the agent loads
│   ├── BOOTSTRAP.md        ← optional one-time setup notes, not loaded
│   ├── scripts/            ← optional helpers, run with exec
│   ├── references/         ← optional reference text, read with file_read
│   └── assets/             ← optional templates and images
└── daily-note/
    └── SKILL.md
```

All agents of the instance share this folder. The folder name is the
skill's name. Files are read again on every turn, so an edit or a new
skill takes effect on the agent's next turn.

## How an agent finds a skill

Every turn the system prompt carries a list of the skills this agent may
use:

```xml
<available_skills>
  <skill>
    <name>release-notes</name>
    <description>Draft the weekly release summary in our format</description>
    <when_to_use>When the user asks for release notes or a weekly summary</when_to_use>
  </skill>
  <skill unavailable="missing bin: gh">
    …
  </skill>
</available_skills>
```

When a task fits, the agent calls `skill({name: "release-notes"})`. That
returns the body of `SKILL.md`, and the agent follows it with its normal
tools.

A long session can lose the list, and some engines fix the prompt when
the session starts. `skill_list` returns the same list fresh from disk.

When the list grows past `skills.maxSkillsInPrompt` entries or
`skills.maxPromptChars` characters, it switches to one line per skill
(`name: description`, without `when_to_use`). If that is still too long,
the list is cut in alphabetical order and ends with a marker that says
how many skills are hidden.

## Writing a skill

```markdown
---
name: release-notes
description: Draft the weekly release summary in our format
license: MIT
compatibility: macOS, Linux
metadata:
  somora:
    when_to_use: When the user asks for release notes or a weekly summary
    requires:
      bins: ["gh>=2.40"]
      config: [obsidian.vault]
      env_vars: [GH_TOKEN]
    tags: [release, weekly]
---

# Release notes

Step by step instructions for the agent. Refer to files in scripts/,
references/ and assets/ by relative path.
```

### Frontmatter fields

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Lowercase letters, digits and single hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`), at most 64 characters. Must equal the folder name. |
| `description` | yes | What the skill does and when to use it. At most 1024 characters. Shown in the list. |
| `homepage` | no | Link to the skill's home. At most 500 characters. |
| `license` | no | License name. At most 200 characters. |
| `compatibility` | no | Free text on where the skill works. At most 500 characters. |
| `allowed-tools` | no | Accepted for compatibility with the specification. somora does not enforce it. |
| `disable-model-invocation` | no | `true` or `false`. Accepted for compatibility. somora does not act on it. |
| `metadata` | no | Free extension point. Other tools' blocks, such as `metadata.openclaw`, are kept and ignored. |
| `metadata.somora.when_to_use` | no | The signals that should make the agent pick this skill. At most 2000 characters. Shown in the list. |
| `metadata.somora.requires.bins` | no | Programs the skill needs, each optionally with a version: `"gh>=2.40"`. Operators: `>=`, `<=`, `==`, `>`, `<`. |
| `metadata.somora.requires.config` | no | Keys of `config.yaml` that must be set, in dotted form: `obsidian.vault`. |
| `metadata.somora.requires.env_vars` | no | Environment variables the skill needs. |
| `metadata.somora.tags` | no | Free labels, returned by `skill` and `skill_list`. |

> **Warning:** Unknown keys are not ignored. A key at the top level that
> is not in this table, or an unknown key under `metadata.somora`, makes
> the whole skill fail to load. Put anything of your own under
> `metadata.<your-namespace>`.

A skill that fails to load is skipped and logged. The other skills are
not affected. Reasons: no `SKILL.md`, broken YAML, an invalid field, or
a `name` that differs from the folder name.

### Requirements

somora checks `requires` on every turn. A skill with an unmet
requirement stays in the list, marked `unavailable` with the reason.
When the agent loads it anyway, the body starts with a warning. The
agent can still read it to decide whether to install what is missing or
to run the commands on another host with `exec({target: ...})`.

| Requirement | Met when |
|---|---|
| `bins` | The program is found on the server's `PATH` or in a common user install folder: Homebrew and Linuxbrew, `~/.local/bin`, `~/go/bin`, `~/.cargo/bin`, `~/.npm-global/bin`, `~/bin`. |
| `bins` with a version | The first copy found also answers `<bin> --version` with a version that satisfies the constraint. If no version can be read, the skill stays available and a warning is shown. |
| `config` | The key holds a non-empty text, a number, `true`, or a section. |
| `env_vars` | The variable is set and not empty in the server's environment. |

If the same program is found in several places, somora warns and names
every copy. The first one found is the one that runs. Two versions of
one tool with different stored state are a common cause of confusing
errors.

### Body checks

The body lands in the agent's context word for word, so anything that
reads like an instruction is followed like one. somora checks the body
for patterns that mislead agents. An error marks the skill
`unavailable`. A warning is only reported.

| Rule | Level | What it catches |
|---|---|---|
| `setup-section-in-body` | error | A heading that starts with "Setup", such as `## Setup on this host`. One-time setup belongs in `BOOTSTRAP.md` next to `SKILL.md`, which is not loaded. |
| `eval-brew-shellenv-in-body` | error | `eval $(brew shellenv)` in a code block. Agents would put it in front of every command. |
| `export-env-in-body` | error | `export KEY=...` in a code block. Declare the variable in `requires.env_vars` instead. |
| `html-document-in-body` | error | `<!DOCTYPE html>` or `<html>` in the first 50 lines: a downloaded web page, not a skill. |
| `env-prefix-cmd-in-body` | warning | `KEY=value command ...` in a code block. |
| `body-too-large` | warning | More than 200 lines. Move reference material into separate files. |

The three code rules apply inside fenced code blocks only. A sentence
that mentions the pattern, for example "do not export the token", is
fine.

## Installing skills

`somora skill add <slug>` takes a skill from one of three sources. It
checks the body first, writes the folder in one step, and then confirms
that the skill really loads. If it does not, nothing is left on disk and
a skill that was there before is restored.

| Source | Command |
|---|---|
| A template | `somora skill add <slug> --template <name> --description "<text>"` |
| A local file | `somora skill add <slug> --from-file ./SKILL.md` |
| A URL | `somora skill add <slug> --from-url <url>` |

The templates:

| Template | For |
|---|---|
| `default` | A plain procedure. Used when no source is named. |
| `cli-wrapper` | A skill around a command line tool. Comes with a `BOOTSTRAP.md` for setup notes. |
| `api-wrapper` | A skill that calls an HTTP API. |

A plain URL must return the Markdown file itself, at most 100 KB. A web
page is rejected. With `--from-file` and `--from-url` the `name` in the
file must match the slug you give.

### From ClawHub

[ClawHub](https://clawhub.ai) is a public skill registry. Pass a skill's
page address to `--from-url`:

```bash
somora skill add <slug> --from-url https://clawhub.ai/<owner>/skills/<slug>
```

`clawhub.ai/<owner>/<slug>` and `clawhub.ai/<slug>` work too. Prefer the
address with the owner: slugs are not unique on ClawHub. For a slug that
several owners use, the short form fails with `409 AMBIGUOUS_SKILL_SLUG`
and the error lists the candidate addresses.

What happens:

1. somora asks ClawHub for the skill and its latest version. A skill
   that ClawHub has blocked as malware is refused.
2. The bundle is downloaded (at most 50 MB, 60 seconds) and unpacked.
   Only text files are kept. Paths that point outside the skill folder
   are dropped.
3. Requirements written for other tools (`metadata.openclaw`,
   `metadata.clawdbot`, `metadata.clawdis`) are copied to
   `metadata.somora.requires`. The original block stays, so the file
   remains valid in both worlds.
4. The usual checks run and the folder is written.

Use ClawHub's own slug as the local name. When ClawHub limits requests
(`429`), the error says how long to wait.

## Built in skills

somora ships two skills and copies them to `~/.somora/skills/` when the
server starts:

| Skill | Teaches |
|---|---|
| `skill-author` | Writing and installing skills with `somora skill`. |
| `builder-handover` | Handing a coding task to a builder agent. |

A new somora version may bring a newer text. What happens to your copy
at server start:

| Your copy | Result |
|---|---|
| Missing | It is created. |
| Unchanged since somora wrote it | It is updated silently. |
| Edited by you | It is left alone. The log says so (`skills.builtin_user_edited`). |
| Was there before somora tracked it | It is kept and taken as the baseline. |

`somora skill update <slug>` replaces your copy with the shipped one,
edits included. somora remembers what it wrote in
`~/.somora/.skill-seed-state.json`.

## Per agent visibility

Every agent sees every skill unless you limit it.

**In the web client.** The Abilities window has a skills section below
the tools. Pick the agent and click the eye next to a skill. This writes
the skill's name into a `deny` list in the agent's `agent.yaml`. A skill
you install later is visible by default. The change applies on the
agent's next turn.

The eye on the section switches all skills. Off writes `*` under
`deny`, so a skill you install later stays off too. A skill switched on
after that goes under `allow`, as an exception.

**By hand in `agent.yaml`.** Use one of these forms:

```yaml
# everything except these (what the web client writes)
skills:
  deny:
    - instagram-downloader
```

```yaml
# only these (what the web client writes)
skills:
  deny:
    - "*"
  allow:
    - github
    - skill-author
```

```yaml
# only these, older form; still works
skills:
  allow:
    - github
    - skill-author
```

```yaml
# short form, means the same as allow
skills:
  - github
  - skill-author
```

| Rule | Effect |
|---|---|
| No `skills` section | The agent sees all skills. |
| `deny` and `allow` both name a skill | `deny` wins. |
| `*` under `deny` | Every skill off, except those named under `allow`. |
| Empty `allow`, or `skills: []` | No restriction. |
| A name that matches no skill | Ignored and logged (`skills.gating_unknown`). |

A [builder](builder.md) agent starts the other way round. It is offered
no skill until its `allow` names one, so its prompt stays short. The
Abilities window shows every skill off for a builder. Click to allow.

Hidden means hidden everywhere: the skill is missing from the list in
the prompt and from `skill_list`, and `skill` refuses to load it. This
also holds when another agent passes work on with `agent_ask`. Ask an
agent that has the skill instead.

## Credentials for skills

Many skills wrap a program that expects a token in an environment
variable. somora has no secrets store of its own. Put the values in
`~/.somora/somora.env`:

```bash
cat > ~/.somora/somora.env <<'EOF'
MYTOOL_TOKEN=<your-token>
MYTOOL_ACCOUNT=<you@example.com>
EOF
chmod 600 ~/.somora/somora.env
somora server restart
```

The file has one `KEY=value` per line. Lines starting with `#` are
comments. It is read once at server start. A variable that is already
set in the server's environment keeps its value. `SOMORA_ENV_FILE`
points somora at a different file.

On Linux an `EnvironmentFile=` line in the systemd unit works as well.
`somora init` and `somora update` keep such lines when they rewrite the
unit.

Skill credentials do not go into `config.yaml`: the programs a skill
calls read environment variables, not somora's configuration.

### Which command sees which variable

`requires.env_vars` says what a skill needs. With `skills.envScoping`
on, somora uses that to keep credentials away from unrelated commands:

- Every variable that any skill declares is removed from commands the
  `exec` tool starts on the somora host.
- A command that names one of a skill's `requires.bins` gets that
  skill's variables back. `mytool sync` sees `MYTOOL_TOKEN`. `ls` does
  not, and neither do other skills' commands.
- All words of the command are checked, so `cd x && mytool sync`
  matches.
- An `env` parameter on the `exec` call always wins.

The limits:

| Case | What to do |
|---|---|
| A script calls the program only indirectly | Name the program in the command, or pass the variable with the `env` parameter of `exec`. |
| The skill declares `env_vars` but no `bins` | Nothing can match, so the variables stay removed. Declare the bins. |
| tmux panes and commands on remote hosts | Not covered. A remote host uses its own environment. |

`skills.envScoping: false` switches this off. Every command then
inherits the server's full environment.

## Settings

In `config.yaml`. The values shown are the defaults.

```yaml
skills:
  maxSkillsInPrompt: 150
  maxPromptChars: 18000
  maxSkillFileBytes: 256000
  envScoping: true
```

| Setting | Default | Meaning |
|---|---|---|
| `skills.maxSkillsInPrompt` | `150` | Above this many skills the list in the prompt uses the one-line form. |
| `skills.maxPromptChars` | `18000` | Size limit of the list in characters. Over it: one-line form, then cut. |
| `skills.maxSkillFileBytes` | `256000` | Size check for a `SKILL.md` when it is loaded. A larger file is logged as `skill.restat_failed`. The body is still returned. |
| `skills.envScoping` | `true` | Declared variables reach only commands that call the skill's programs. `false` gives every command the full environment. |

Per agent, in `agent.yaml`: the `skills` section described under
[Per agent visibility](#per-agent-visibility).

## Commands

The commands work on the files in `~/.somora/skills/` and do not need a
running server.

| Command | What it does |
|---|---|
| `somora skill list` | Lists the available skills, with warnings. |
| `somora skill list --all` | Also lists unavailable skills with the reason. |
| `somora skill list --available-only` | Lists available skills only, even together with `--all`. |
| `somora skill check <slug>` | Full report for one skill: body checks, requirements, warnings. Exit code 0 when healthy, 1 when unavailable or not loadable. |
| `somora skill add <slug>` | Installs a skill. See the options below. |
| `somora skill update <slug>` | Replaces a built in skill with the shipped version. |
| `somora skill remove <slug> --yes` | Deletes the skill folder. Without `--yes` it only says what it would delete. A built in skill comes back at the next server start. |

Options of `somora skill add`:

| Option | Meaning |
|---|---|
| `--template <name>` | `default`, `cli-wrapper` or `api-wrapper`. |
| `--description <text>` | The description, for a template. |
| `--from-file <path>` | Take a local `SKILL.md`. Wins over `--template`. |
| `--from-url <url>` | Take a file from a URL or a skill from ClawHub. Wins over both. |
| `--force` | Overwrite a skill that exists. |
| `--yes` | Write even when the body checks report warnings. Errors always stop the install. |

## Tools

| Tool | What it does |
|---|---|
| `skill({name})` | Loads one skill. Returns `name`, `description`, `body` and `available`, plus `when_to_use`, `unavailable_reason`, `requires_env_vars` and `tags` when present. |
| `skill_list({})` | Lists the skills the agent may use, fresh from disk: `skills` with name, description, `when_to_use`, `available`, `unavailable_reason` and `tags`, and `count`. |

`skill` fails with a message that names the usable skills when the name
is unknown ("skill 'x' not found. Available: ...") or hidden from the
agent ("skill 'x' exists but is not allowed for agent 'y'").

## Routes

| Route | What it does |
|---|---|
| `GET /agents/:agent/skills` | Every installed skill with `available` and the agent's `visible` flag, plus the agent's `gating`. |
| `POST /agents/:agent/skills/toggle` | One click: body `{names, visible, group?}`. The server writes the rules. |
| `PUT /agents/:agent/skills` | Body `{deny: [...], allow: [...]}`. Rewrites only the `skills` section of the agent's `agent.yaml`. Two empty lists remove the section. |

## Troubleshooting

**The skill is not in the list.** Run `somora skill check <slug>`. If it
says the loader skipped the file, look in the server log for
`skills.frontmatter_invalid`, `skills.frontmatter_parse_failed`,
`skills.name_mismatch`, `skills.no_skill_md` or `skills.read_failed`.
The usual cause is an unknown frontmatter key or a `name` that differs
from the folder.

**The skill is unavailable.** `somora skill list --all` shows the
reason: a missing program, a version that is too old, a missing setting
or variable, or a failed body check (`skills.lint_errors` in the log).

**A program asks for a variable that is set.** The command did not name
the skill's program, so the variable was removed. The `exec` result then
carries a `hint` that says so. Call the program directly in the command.
The log line `exec.skill_env_injected` records every command that did
get variables.

**Two copies of one program.** `somora skill check <slug>` and the log
line `skills.bin_warning` name every copy. Remove the old one.

**The env file is readable by others.** The log shows
`env_file.permissions`. Run `chmod 600 ~/.somora/somora.env`.

**One agent does not see a skill.** Check the `skills` section of its
`agent.yaml`, or the Abilities window.

## See also

- [Tools](tools.md): all tools, and how tool visibility works
- [Agents](agents.md): everything in `agent.yaml`
- [Builder](builder.md): the agent kind that starts without skills
- [Memory](memory.md): where user preferences belong
- [Web client](web.md): the Abilities window
- [API](api.md): the skill routes in detail
- [agentskills.io specification](https://agentskills.io/specification):
  the format skills follow
