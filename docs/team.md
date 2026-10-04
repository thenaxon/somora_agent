# Team

The team file tells every agent who is who: the human at the top, the
other agents, who reports to whom and who to involve for what. You
describe the organisation once, and somora writes it into each agent's
prompt from that agent's own seat.

## What you get

- **One org chart for all agents.** One file, `~/.somora/team.yaml`,
  instead of the same "who is who" text copied into every persona.
- **A view from each seat.** Every agent sees its superior, its peers,
  its reports and one line per colleague: involve for this, not for
  that.
- **Changes without a restart.** Save the file and every agent uses it
  on its next turn.
- **An editor in the web client.** Drag cards to change who reports to
  whom, and see the exact text an agent gets before you save.
- **You stay in charge.** You edit the file. Agents read the block and
  have no team tool to change it.
- **Off until you want it.** Without a `team.yaml` there is no block and
  prompts stay as they are.

## Set it up

In the web client, open the **team** tile. Without a file the window
asks for your name and creates one from the agents on disk.

Or in a terminal:

```bash
somora team init --principal "Karl"    # writes ~/.somora/team.yaml from the agents on disk
$EDITOR ~/.somora/team.yaml            # set reports_to, involve_for, not_for
somora team check                      # validates, warns, finds old team text in personas
somora team show bea                   # prints the block bea gets
```

`init` never overwrites an existing file. Every agent starts out
reporting to you, with the default rules written out so you can edit
them. Change `reports_to` to move agents under each other.

The setup assistant offers the same step once you have two or more
agents: `somora setup team`.

## The team file

```yaml
# ~/.somora/team.yaml
version: 1

principal:                     # the human at the root, required
  name: Karl
  title: Principal             # free label, shown as "(human)"
  about: >                     # optional, one to three sentences
    Founder. Reads code; be honest about risks. Final say on everything.

rules:                         # optional, shown word for word as bullets
  - The principal's word is final. In any conflict with an agent, the principal wins.
  - Briefings from your direct superior are authoritative inside your lane.
  - Do not take over a colleague's lane unless the principal or your superior delegates it explicitly.
  - A colleague only knows what you write to them — give them the goal, the context and what a good answer looks like.

agents:                        # every key is a folder under ~/.somora/agents/
  ada:
    reports_to: principal      # 'principal' or another agent name
    title: Chief of Staff      # optional, default is `role` from AGENTS.md
    involve_for:               # short trigger phrases, not a biography
      - coordination across lanes
      - anything the principal asked the team for
    not_for:
      - hands-on coding
  bea:
    reports_to: ada
    involve_for: [code, builds, tests, driving coding CLIs in tmux, infrastructure]
    not_for: [deep web research, media]
    notes: Comes to the media agent when a design has to become code.   # optional free text
  cleo:
    reports_to: ada
    involve_for: [library docs, framework comparisons, investigative research]
```

The four rules shown are the defaults. They apply when the `rules` key
is missing. When the key is present, exactly your list is used.

All fields with their limits are listed under
[File reference](#file-reference).

## What an agent sees

The block for `bea` from the file above. The titles `Engineer` and
`Researcher` come from `role` in those agents' `AGENTS.md`.

```
# Your team

Org chart (you are marked with ←):
Karl — Principal (human): Founder. Reads code; be honest about risks. Final say on everything.
└── ada — Chief of Staff
    ├── bea — Engineer  ← you
    └── cleo — Researcher

Your superior: ada — escalate there first; ada's briefings are authoritative inside your lane. The principal (Karl) has the final say over everyone.
Your peers (same superior): cleo.
Your reports: none.

Who to involve — via agent_ask; their reply comes back to your session:
- ada (Chief of Staff): coordination across lanes; anything the principal asked the team for. Not for: hands-on coding.
- cleo (Researcher): library docs; framework comparisons; investigative research.

Rules:
- The principal's word is final. In any conflict with an agent, the principal wins.
- Briefings from your direct superior are authoritative inside your lane.
- Do not take over a colleague's lane unless the principal or your superior delegates it explicitly.
- A colleague only knows what you write to them — give them the goal, the context and what a good answer looks like.
```

The block is English, like every block somora writes. Your own text
stays in the language you wrote it in. A colleague without
`involve_for`, `not_for` and `notes` is listed by name and title only.

### Where the block sits

The block comes right after the persona (`SOUL.md`, `AGENTS.md`,
`USER.md`) and before the tool reminder, the wiki overview, the skills,
the session and the project blocks. Sub-agent turns and turns started
by a sentinel carry the same block as a normal chat turn.

The text only changes when `team.yaml` or the set of agents changes.
Between those changes it is identical on every turn, so it does not
disturb prompt caching.

### Agents missing on one side

| Situation | What happens |
|---|---|
| An agent folder exists, but the agent is not in the file | It appears in every block under `Not in the org chart yet`. Its own block tells it to treat the principal as its superior. |
| The file names an agent that has no folder | It is skipped with a warning. Its reports attach to the nearest superior that exists. |

### Taking an agent out for a while

Set `active: false`. The agent stays in the chart, marked
`(currently inactive)`. It leaves every colleague's "Who to involve"
list, and a `do not involve` line tells them to go one level up
instead. Its own block says that it is marked inactive and should not
pull colleagues in unless asked.

### Builders

A [builder](builder.md) is listed like any other agent. Its line under
"Who to involve" adds one sentence: hand over a complete order in one
message with `builder_dispatch` and wait for the report, with no
check-ins in between.

A builder's own prompt gets a compact block: the principal, the names
and titles of the active colleagues it can consult with `agent_ask`,
and the rules. It has no org chart and no involve lines, because a
builder's context belongs to the repository.

> **Note:** `somora team show` always prints the full block and does
> not add the builder sentence. The draft preview in the Team window
> leaves that sentence out too. For the text a turn really sends, use
> `GET /team/preview/:agent` or the Full prompt tab of the Agent window.

## Writing good involve lines

Agents pick a colleague from one short description, so write triggers,
not a biography: `library docs and framework comparisons`, not
`an experienced researcher with a journalist's mindset`. Character and
voice belong in that agent's own persona.

Keep it short. Every agent carries the block in every turn.
`somora team check` and the preview in the Team window warn when a
block is longer than `promptBudgets.teamBlockChars`, 3000 characters by
default. It is a warning only. Nothing is cut off.

## Move team text out of the personas

If your `AGENTS.md` files contain an org chart or a "who is who"
section, remove it. Two versions in one prompt confuse the model.

1. Run `somora team check`. It lists personas that still contain tree
   drawings or team headings.
2. Compare `somora team show <name>` with the persona text.
3. Move what you would miss into `involve_for`, `not_for` or `notes`.
4. Delete the section from the persona.

Keep personal facts about yourself in `USER.md`. The team file carries
only your name, your title and a short `about`.

## The Team window

Open the **team** tile in the web client.

| Part | What it does |
|---|---|
| **Org chart** (left) | You at the top, one card per agent with its icon and colour. Drag a card onto another card, or onto your own, to change who it reports to. Dropping an agent under one of its own reports is refused. |
| **Not in the chart** (below the chart) | Agents on disk that are missing from the file, each with an **add** button. |
| **Form** (right) | For you: name, title, about and the rules, one per line. For an agent: title, reports to, the **active** switch, "involve for" and "not for" as chips, notes, and **remove**. |
| **Preview** (bottom) | The block the selected agent would get, rendered on the server from your unsaved draft, with its character count against the budget. It follows the card you click. A selector shows any other agent. |

Good to know:

- Enter or a comma adds a chip.
- **remove** takes the agent out of the chart only. The agent itself
  stays, and its reports move up one level.
- An empty rules field means the four default rules.
- **Save** checks the draft like the server checks the file, writes it
  in one step and keeps a backup of the previous version.
- **Discard** returns to the file on disk.
- When the file on disk is invalid, the window lists the problems and
  asks you to fix the file by hand.

## What a block costs

The Agent window shows the size of the team block next to the persona,
the full prompt and the tool schemas, in characters and estimated
tokens. Open it with a right-click on the agent tile, then
**Configure…**. Its **Full prompt** tab shows the system prompt as the
next turn would send it, split into parts. The team block is one of
them.

`GET /agents/:agent/prompt-preview` returns the same as JSON. The part
with the key `team` is the block.

## File reference

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | `1` |
| `principal.name` | yes | The human at the root, as the agents should call them. Up to 80 characters. |
| `principal.title` | no | Label after the name. Default `Principal`. Up to 80 characters. |
| `principal.about` | no | One to three sentences, up to 600 characters. Keep personal detail in the agents' `USER.md`. |
| `rules` | no | Up to 20 rules of up to 300 characters each, shown word for word under `Rules:`. Key missing: the four defaults. Key present: exactly your list. |
| `agents.<name>.reports_to` | yes | `principal` or another agent in the file. Must form a tree. |
| `agents.<name>.title` | no | Up to 80 characters. Falls back to `role` in the agent's `AGENTS.md` frontmatter, then to its `description`, then to its name. |
| `agents.<name>.active` | no | `false` takes the agent out of the team for a while. Default `true`. |
| `agents.<name>.involve_for` | no | Up to 20 phrases of up to 200 characters each, shown as one line. |
| `agents.<name>.not_for` | no | Up to 20 phrases of up to 200 characters each, shown as `Not for: …`. |
| `agents.<name>.notes` | no | Free text after the phrases, up to 600 characters. |

A file is refused when it has an unknown `reports_to`, a reporting
cycle, an agent that reports to itself, or an unknown key. The message
names the field and the reason.

While the file is invalid the server keeps the last valid team. If it
has not loaded a valid one since it started, there is no block.

**Save** in the web client keeps the previous five versions next to the
file as `team.yaml.bak-<timestamp>`. An edit by hand makes no backup.

## Settings

The budgets live in `config.yaml`. The values shown are the defaults.

```yaml
promptBudgets:
  teamBlockChars: 3000
  personaFileChars: 8000
  personaTotalChars: 14000
```

| Setting | Default | Meaning |
|---|---|---|
| `promptBudgets.teamBlockChars` | `3000` | Warn when one agent's team block is longer than this. Minimum 500. |
| `promptBudgets.personaFileChars` | `8000` | Warn when one of `AGENTS.md`, `SOUL.md`, `USER.md` is longer than this. Minimum 500. |
| `promptBudgets.personaTotalChars` | `14000` | Warn when the three persona files together are longer than this. Minimum 1000. |

All three are warnings shown as counters. Nothing is ever cut off. A
new value applies after a config reload, without a restart.

## Commands

| Command | What it does |
|---|---|
| `somora team init [--principal <name>]` | Writes `~/.somora/team.yaml` from the agents on disk. Refuses when the file exists. Without `--principal` the name is `Principal`. |
| `somora team check` | Validates the file, prints warnings and the block size per agent, and lists personas that still contain team text. |
| `somora team show <name>` | Prints the full `# Your team` block for that agent. |
| `somora setup team` | The same first file, as a step of the setup assistant. Needs two or more agents. |

## Routes

| Route | What it does |
|---|---|
| `GET /team` | The file, the resolved tree and the warnings. |
| `PUT /team` | Replaces the file. Validated, written in one step, previous version backed up. An invalid document answers `400` and writes nothing. |
| `POST /team/init` | Creates the first file from the agents on disk. Body `{"principal": "<name>"}` is optional. Answers `409` when a file exists. |
| `POST /team/preview` | Renders a draft for one agent. Body `{file, agent}`. Nothing is written. |
| `GET /team/preview/:agent` | The block that agent gets from the saved file. |
| `GET /team/check` | Validation, warnings and the block size per agent. |

## Troubleshooting

**Agents do not see a change.** The file is probably invalid, and the
server kept the last valid team. Run `somora team check`. It names the
field and the reason. The server log has one `team.invalid` line per
broken version of the file, and `team.loaded` when a file was accepted.

**A new agent is missing from the blocks.** The list of agents on disk
is read again every 30 seconds. After that the agent shows up under
`Not in the org chart yet` until you add it to the file.

**An agent talks about two different org charts.** Its persona still
contains old team text. See
[Move team text out of the personas](#move-team-text-out-of-the-personas).

**A block is over the budget.** Shorten `involve_for`, `not_for` and
`notes`, or raise `promptBudgets.teamBlockChars`.

## See also

- [Agents](agents.md): persona files and the Agent window
- [Builder](builder.md): the coding agent and its compact team block
- [Web client](web.md): tiles and windows
- [Setup](setup.md): the setup assistant and its team step
- [API](api.md): the team routes and the prompt preview in detail
