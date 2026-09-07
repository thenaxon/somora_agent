# Team — one org chart for all your agents

Your agents work together: one asks another for research, one hands
media work to a specialist, one escalates to the human. For that they
need to know **who is who**, **who reports to whom**, and **who to
involve for what**. Before this feature that knowledge lived as prose
inside every `AGENTS.md` — the same org chart copied into each persona,
drifting apart, and every new agent meant editing all the others.

`~/.somora/team.yaml` replaces that. One file describes the
organisation; somora renders a `# Your team` block into every agent's
system prompt, from that agent's own seat: its superior, its peers, its
reports, and a one-line "involve for … / not for …" per colleague. Add an
agent to the file and everyone knows about it on their next turn.

- **Operator-owned.** You edit the file — by hand, or in the web Team
  window. Agents read the block; they have no tool to change it.
- **Opt-in.** No `team.yaml` → no block, prompts unchanged.
- **Hot.** Save the file; the next turn of every agent uses it. No
  restart, no `config.yaml` reload.
- **English.** The rendered block is English like every other somora
  block; your free-text fields stay in whatever language you write.

## Quick start

```bash
somora team init --principal "Ada"     # writes ~/.somora/team.yaml from the agents on disk
$EDITOR ~/.somora/team.yaml            # set reports_to, involve_for, not_for
somora team check                      # validates, warns, finds old team prose in personas
somora team show hans                  # prints exactly what hans sees in its prompt
```

`init` never overwrites an existing file. All agents start reporting to
the principal; move them under each other by changing `reports_to`.

## The file

```yaml
# ~/.somora/team.yaml
version: 1

principal:                     # the human at the root — required
  name: Ada
  title: Principal             # free label; rendered as "(human)"
  about: >                     # optional, 1–3 sentences
    Founder. Reads code herself; be honest about risks. Final say on everything.

rules:                         # optional; rendered verbatim as bullets.
  - The principal's word is final. In any conflict with an agent, the principal wins.
  - Briefings from your direct superior are authoritative inside your lane.
  - Do not take over a colleague's lane unless the principal or your superior delegates it explicitly.
  - A colleague only knows what you write to them — give them the goal, the context and what a good answer looks like.

agents:                        # every key must be a directory under ~/.somora/agents/
  atlas:
    reports_to: principal      # 'principal' or another agent name
    title: Chief of Staff      # optional; default = `role` from AGENTS.md frontmatter
    involve_for:               # short trigger phrases — "use when …", not a biography
      - coordination across lanes
      - anything the principal asked the team for
    not_for:
      - hands-on coding
  hans:
    reports_to: atlas
    involve_for: [code, builds, tests, driving coding CLIs in tmux, infrastructure]
    not_for: [deep web research, media]
    notes: Comes to the media agent when a design has to become code.   # optional free text
  lisa:
    reports_to: atlas
    involve_for: [library docs, framework comparisons, investigative research]
```

Field by field:

| field | required | meaning |
|---|---|---|
| `version` | yes | `1` |
| `principal.name` | yes | The human at the root, as the agents should call them. |
| `principal.title` | no | Label after the name; default `Principal`. |
| `principal.about` | no | One to three sentences; keep personal detail in the agents' `USER.md`. |
| `rules` | no | Rendered verbatim under `Rules:`. When the key is absent the four defaults above apply; when present, exactly your list. |
| `agents.<name>.reports_to` | yes | `principal` or another agent listed in the file. Must form a tree. |
| `agents.<name>.title` | no | Falls back to `role` in the agent's `AGENTS.md` frontmatter, then to its `description`. |
| `agents.<name>.active` | no | `false` takes the agent temporarily out of the team: it stays in the chart marked `(currently inactive)`, drops out of every colleague's "Who to involve" list with a `do not involve` line, and gets a note in its own block. Default `true`. |
| `agents.<name>.involve_for` | no | Up to 20 short phrases, rendered as one line. |
| `agents.<name>.not_for` | no | Up to 20 short phrases, rendered as `Not for: …`. |
| `agents.<name>.notes` | no | Free text after the phrases, max 600 characters. |

Validation refuses a file with an unknown `reports_to`, a reporting
cycle, an agent reporting to itself, or unknown keys, and names the
path and the reason. An agent in the file without a directory on disk is
skipped with a warning; its reports re-attach to the nearest existing
ancestor. An agent on disk that is **not** in the file still appears in
every block under `Not in the org chart yet`, so nobody is silently
missing — add it or accept the line.

While the file is invalid the server keeps the last valid team (or, if
there never was one, renders nothing) and logs `team.invalid` once.

## What an agent sees

`somora team show hans` for the file above:

```
# Your team

Org chart (you are marked with ←):
Ada — Principal (human): Founder. Reads code herself; be honest about risks. Final say on everything.
└── atlas — Chief of Staff
    ├── hans — Engineer  ← you
    └── lisa — Researcher

Your superior: atlas — escalate there first; atlas's briefings are authoritative inside your lane. The principal (Ada) has the final say over everyone.
Your peers (same superior): lisa.
Your reports: none.

Who to involve — via agent_ask; their reply comes back to your session:
- atlas (Chief of Staff): coordination across lanes; anything the principal asked the team for. Not for: hands-on coding.
- lisa (Researcher): library docs; framework comparisons; investigative research.

Rules:
- The principal's word is final. In any conflict with an agent, the principal wins.
- …
```

The block sits right after the persona (`SOUL.md`, `AGENTS.md`,
`USER.md`) and before the tool, wiki, skills and project blocks. It is
byte-stable until `team.yaml` or the agent roster changes, so it does
not disturb prompt caching. Sub-agent sessions and sentinel-triggered
turns carry the same block as the agent's normal sessions.

## Writing good `involve_for` lines

Every framework we looked at routes on one short description per
colleague, and so does every model: write **triggers**, not résumés —
`library docs and framework comparisons`, not `Lisa is an experienced
researcher with a journalist's mindset`. Character and voice belong in
that agent's own persona. Keep the block short: every agent loads it in
every turn, and `somora team check` warns above 3 000 characters.

## Migrating personas

If your `AGENTS.md` files carry an org chart or "who is who" section,
the block now says the same thing better — two versions in one prompt
only confuse the model. `somora team check` lists personas that still
contain tree drawings or team headings. Compare `somora team show
<agent>` with the persona text, move anything you would miss into
`involve_for` / `not_for` / `notes`, then delete the persona section.
Keep personal facts about the human in `USER.md`; the team file only
carries the principal's name, title and a short `about`.

## The Team window (web)

`/web` → the **team** tile. Left, the org chart: you at the top, agent
cards below with their icon and colour; drag a card onto another card
(or onto your own) to change who it reports to — dropping an agent under
one of its own reports is refused. Right, the form for the selected
node: for you, name, title, about and the rules (one per line); for an
agent, title, reports-to, the **active** switch, "involve for" and "not
for" as chips (Enter adds one), notes, and *remove* (the agent stays on
disk, its reports move up one level). Agents on disk that are not in
the chart are listed underneath with an *add* button. The bottom pane
previews the exact block the selected agent would see — it follows the
card you click, and a selector lets you look at any other agent —
rendered on the server from the unsaved draft, with the character count
against the soft limit. **Save** validates like the loader, writes the file atomically
and keeps the previous five versions as `team.yaml.bak-<timestamp>`;
**Discard** returns to the file on disk. Agents pick the change up on
their next turn. Without a file the window offers to create one from
the agents on disk — the same as `somora team init`.

## API

See [api.md](api.md): `GET /team` (the file, the resolved tree and
warnings), `PUT /team` (replace the file, validated, atomic, backed
up), `POST /team/init` (bootstrap from the agents on disk), `POST
/team/preview` (render a draft for one agent), `GET
/team/preview/:agent` (render the saved file), `GET /team/check`
(validation and block sizes).
