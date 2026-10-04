# Projects

A project is a small file that lists where the things for one piece of
work live: a source folder, a few notes, a Drive link, a path on another
machine. Pin a project to a chat session and the agent sees that list in
every turn, so you do not have to say "look here" again.

## What you get

- **One list per piece of work.** Local folders, notes, URLs and paths
  on remote machines sit side by side in one file.
- **The agent knows what matters.** The pinned project's list is part of
  the system prompt of that session.
- **A working directory per session.** A project can name a folder.
  Relative paths and shell commands of the session then run there.
- **The agent keeps the files.** You describe the project in the chat;
  the agent creates and updates the file with its project tools.
- **Nothing moves.** A project only points. Your files stay where they
  are, and the agent opens them with its normal tools.

Projects are off by default.

## Set it up

Add a `projects:` block to `~/.somora/config.yaml`:

```yaml
projects:
  enabled: true
  entities:
    - slug: privat
      label: Privat
    - slug: acme
      label: acme GmbH
```

Restart somora:

```bash
somora restart
```

On Linux `systemctl --user restart somora` does the same. Then tell the
agent about a project:

```
Make a new project Home cinema under Privat. The source code is in
~/code/home-cinema, the setup notes are in my vault under
Privat/Home cinema/Setup.md. Pin it.
```

The agent checks the entity with `entity_list`, creates the file with
`project_create` and pins it with `project_focus`. From the next turn on
it knows the list.

> **Note:** While `projects.enabled` is `false` or the block is missing,
> the feature is invisible: no slash commands, no chip in the chat
> header, no Project column in the Sessions window, no project tools,
> and every project route answers `503`.

## Entities

Every project belongs to exactly one entity, for example "Privat" or
"acme". You define the entities in `config.yaml`. Agents cannot add one.

The fixed list protects against misheard names. When dictation turns
"acme" into something else, the agent looks at `entity_list` and picks
the closest match. If it tries the wrong slug anyway, `project_create`
refuses with `unknown entity '<slug>' — available: privat, acme` and the
agent tries again.

With `enabled: true` and an empty `entities` list, no project can be
created. Entities are also a filter: `project_list` with
`entity: "privat"` returns only those projects.

## The project file

One file per project, `~/.somora/projects/<slug>.md`. The slug is
lowercase and matches `[a-z0-9_-]+`. The file is YAML frontmatter with
an empty body:

```yaml
---
slug: home-cinema
name: Home cinema
entity: privat
description: Receiver, beamer, acoustic treatment in the living room
color: "#4f46e5"
tags:
  - hardware
  - wip
created: 2026-04-15T10:23:00Z
updated: 2026-05-13T09:42:00Z
expires: null
archived: false
workdir: ~/code/home-cinema
paths:
  - ref: ~/code/home-cinema/
    label: Sourcecode
  - ref: ~/Documents/somora-vault/Privat/Home cinema/Setup.md
    label: Setup notes
  - ref: https://drive.google.com/drive/folders/xyz
    label: Drive folder
  - ref: gpu-box:/home/me/avr-logs/
    label: AVR logs
---
```

The files are readable and fit under version control. You rarely edit
them by hand, because the agent maintains them. Notes about a project
belong in a separate Markdown file that the project points to.

## Pointers

Each entry under `paths` is a `ref` and an optional `label`. The kind of
pointer is read from the shape of the `ref`. No type is stored.

| Shape of `ref` | Kind | The agent opens it with |
|---|---|---|
| `~/...` or `/...` | `local` | `file_read`, `file_list`, `file_search` |
| `<scheme>://...` such as `https://` or `gdrive://` | `url` | `web_fetch`, browser tools, a Drive skill if installed |
| `<resource-slug>:/...` | `resource` | `file_read` or `exec` with `target: "<resource-slug>"` |

A `ref` of any other shape is refused. For a `resource` pointer the part
before `:/` must be a slug under `resources` in `config.yaml`, otherwise
the write is refused with the list of known resources. Local paths and
URLs are not checked for existence, so a pointer may name a file that
does not exist yet.

A pointer without a label is shown with a derived one: the file or
folder name, or the host of a URL.

## Working directory

A project may name its working directory, usually the repository:

```yaml
workdir: ~/code/weather-station
```

The path must be absolute or start with `~/`. Pinning such a project
makes the folder the session's working directory:

- Relative paths in `file_read`, `file_write`, `file_patch`,
  `file_search`, `file_list` and `analyze_file`, and in image or video
  references, resolve there instead of the agent's workspace.
- `exec` runs there unless the call names a `cwd`.
- A builder agent shows the folder in its environment block and keeps
  its plan file there.
- Sub-agents spawned from the session inherit the pin and the folder.

A folder that does not exist yet is created when the project is pinned,
so you can name a new repository before its first file exists. Clearing
the pin restores the agent's workspace. Set the folder with
`project_create`, or with `project_update` and `set_field` on `workdir`.

> **Note:** A builder session keeps its pin while a turn runs there.
> Unpinning or switching is refused until the turn is over.

## Pinning a project

A session has at most one pinned project. The pin is stored in the
session's meta file (`<session>.meta.json`, fields `projectSlug` and
`projectLinkedAt`). It survives restarts and model switches.

| How | Where | To clear |
|---|---|---|
| `/projekt <slug>` or `/project <slug>` | TUI and web | `/projekt unlink` |
| Click the folder button or the chip | Web chat header | **Unlink** in the popover |
| The agent calls `project_focus` | During a turn | `project_focus` with `slug: null` |

What happens on a pin:

1. The session's meta file gets the slug and the time.
2. A `project_switched` event is written to the session log, with the
   old slug, the new slug and who switched (`tool` or `slash_command`).
3. From the next turn on, the project is part of the system prompt.

Pinning the project that is already pinned does nothing.

### What the agent sees

```
## Active Project: Home cinema

**Entity:** privat
**Description:** Receiver, beamer, acoustic treatment in the living room
**Tags:** hardware, wip

**Pointers:**
- `[local]` ~/code/home-cinema/ — Sourcecode
- `[local]` ~/Documents/somora-vault/Privat/Home cinema/Setup.md — Setup notes
- `[url]` https://drive.google.com/drive/folders/xyz — Drive folder
- `[resource]` gpu-box:/home/me/avr-logs/ — AVR logs

When the user asks about this project, treat the pointers above as the
canonical list of relevant resources. Use your standard tools (file_read
for [local], web_fetch / browser tools for [url], resource tools for
[resource]) to access them on demand — do not assume their contents from
memory.
```

An `**Expires:**` line appears when the project has an expiry, and an
`**⚠ Archived:**` line when it was archived after the pin.

### Prompt cache

The project block is the last part of the system prompt, after the
persona, the skills and the session block. A project switch therefore
leaves everything before it cached. Recalled memory changes every turn
and travels with the message, not in the system prompt.

On the `codex-cli` engine a resumed thread also gets the block in front
of the user message, so the model sees a new pin at once.

## Changing a project

Ask the agent: "Add `~/research/atmos-comparison.md` to the Home cinema
project." It calls `project_update` with one `add_path` operation.

`project_update` takes a list of operations and applies all of them or
none:

```json
{
  "slug": "home-cinema",
  "ops": [
    { "op": "add_path", "ref": "~/research/atmos.md", "label": "Atmos notes" },
    { "op": "set_field", "field": "description", "value": "Updated wording" },
    { "op": "set_tags", "tags": ["hardware", "wip", "avr"] }
  ]
}
```

| `op` | Fields | Effect |
|---|---|---|
| `set_field` | `field`, `value` | Sets `name`, `description`, `color`, `expires` or `workdir`. `value: null` clears the field. `name` cannot be cleared. |
| `add_path` | `ref`, `label` (optional) | Adds a pointer. Refused when the `ref` is already listed. |
| `remove_path` | `ref` | Removes the pointer with exactly this `ref`. |
| `set_tags` | `tags` | Replaces all tags. |
| `archive` | `reason` (optional) | Archives the project. |
| `unarchive` | none | Restores it. |

Slug and entity cannot be changed. To change one, delete the file and
create the project again. Sessions that had it pinned lose the project
context.

## Archiving and deleting

A project you no longer use is archived, not deleted. An archived
project:

- is left out of `project_list`, the web switcher and the slash command
  suggestions, unless `includeArchived: true` is passed,
- still answers `project_get` by slug,
- stays pinned where it was pinned, marked with ⚠ in the TUI chip and
  the Sessions window.

No tool deletes a project, so an agent cannot wipe the list that ties a
session to your work. To delete one, remove the file yourself:
`rm ~/.somora/projects/<slug>.md`.

## In the clients

### TUI

| Command or element | What it does |
|---|---|
| `/projekt <slug>`, `/project <slug>` | Pins a project. |
| `/projekt unlink` (also `off`, `clear`, `-`) | Clears the pin. |
| `/projekt` | Shows the pinned project: entity, description, tags, pointers. |
| `/projects` | Lists all projects with entity, number of paths and tags. |
| Chip in the header | `📁 <name>` while a project is pinned, with ⚠ if it is archived. |
| `/sessions` | Rows of sessions with a pin end in `📁 <slug>`. |

### Web

| Element | What it does |
|---|---|
| Folder button in the chat header | Shown while nothing is pinned. Opens the switcher. |
| Chip in the chat header | The project's name in its color. Opens the switcher. |
| Switcher | Projects grouped by entity, a search box, and **Unlink** for the pinned one. |
| `/projekt`, `/project` in the slash popup | Suggests `unlink` first, then the projects. |
| Project column in the Sessions window | The pinned project per session, in its color. |

The chip updates right away on every client when a pin is set or cleared
by a command, the switcher or a route. A pin the agent sets with
`project_focus` shows up when its turn ends.

Creating and editing happens in the chat, through the agent. The web
client only shows and switches. The mobile app has no project controls.

## What projects do not do

- **No nesting.** Entities and projects are flat. Use tags to group
  across entities.
- **No expiry job.** `expires` is information for you and the agent.
  Nothing archives a project when the date passes.
- **No rename.** The slug is fixed, because sessions refer to it.
- **No Drive client.** A Drive link is a plain `url` pointer. The agent
  needs a skill or the browser to open it.
- **No color picker.** Ask the agent to set `color`, or edit the file.

## Settings

```yaml
projects:
  enabled: false
  entities: []
```

| Setting | Default | Meaning |
|---|---|---|
| `projects.enabled` | `false` | Master switch for tools, commands, routes and UI. |
| `projects.entities` | `[]` | The entities a project may belong to. |
| `projects.entities[].slug` | none | Identifier, `[a-z0-9_-]+`. Stored in each project as `entity`. |
| `projects.entities[].label` | none | Display name. |

In scripts and tool errors the list is named `config.projects.entities`.

## File fields

| Field | Required | Type | Notes |
|---|---|---|---|
| `slug` | yes | string | `[a-z0-9_-]+`, same as the file name. |
| `name` | yes | string | Display name. |
| `entity` | yes | string | One of the configured entity slugs. |
| `description` | no | string | Free text. |
| `color` | no | string | CSS color, for example `#4f46e5`. |
| `tags` | no | string[] | Free words. Default `[]`. |
| `created` | yes | ISO timestamp | Set on creation. |
| `updated` | yes | ISO timestamp | Set on every update. |
| `expires` | no | ISO date or `null` | Information only. |
| `archived` | no | boolean | Default `false`. |
| `archivedAt` | no | ISO timestamp | Set by `archive`. |
| `archiveReason` | no | string | Set by `archive` when a reason is given. |
| `paths` | no | list of `{ref, label?}` | The pointers. Default `[]`. |
| `workdir` | no | string | Working directory, absolute or `~/...`. |

## Tools

All six belong to the `projects` toolset and exist only while the
feature is enabled.

| Tool | Parameters | What it does |
|---|---|---|
| `entity_list` | none | Returns the configured entities. |
| `project_list` | `entity`, `tag`, `includeArchived` | Lists projects with their fields and the number of paths, not the paths. |
| `project_get` | `slug` | Returns one project in full. |
| `project_create` | `slug`, `name`, `entity`, optional `description`, `color`, `tags`, `expires`, `paths`, `workdir` | Creates the file. Refused when the slug exists or the entity is unknown. |
| `project_update` | `slug`, `ops` | Applies the operations above. |
| `project_focus` | `slug` or `null` | Pins a project to the current session, or clears the pin. |

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/projects/feature` | `{enabled, entityCount}`. Always answers `200`. |
| `GET` | `/projects/entities` | The entities. |
| `GET` | `/projects` | Lists projects. Query: `entity`, `tag`, `includeArchived=true`. |
| `GET` | `/projects/:slug` | One project in full. |
| `POST` | `/projects` | Creates a project. `slug`, `name` and `entity` are required. |
| `PATCH` | `/projects/:slug` | Applies `ops`, same operations as `project_update`. |
| `GET` | `/agents/:agent/sessions/:session/project` | The session's pin with the full project. |
| `POST` | `/agents/:agent/sessions/:session/project` | Sets the pin: `{"slug": "<slug>"}`. `null` clears it. |
| `DELETE` | `/agents/:agent/sessions/:session/project` | Clears the pin. |

All routes except `/projects/feature` answer `503` while the feature is
off. A client asks `/projects/feature` once at start to decide whether
to show anything. Setting or clearing a pin over a route sends a
`project` event on the session's stream.

## Troubleshooting

**The agent has no project tools, `/projekt` is unknown.**
`projects.enabled` is `false`, or somora was not restarted after the
change. Clients ask for the feature once at start: reload the web page
or restart the TUI.

**`no entities configured in config.projects.entities`.** Add at least
one entity to `config.yaml`.

**`pinned slug '<slug>' but project file is missing on disk`.** The
file was deleted while a session had it pinned. The agent gets no
project block, and the server log shows `project.focused_but_missing`.
Clear the pin with `/projekt unlink` or create the project again.

**`unknown resource '<slug>' in path ...`.** The part before `:/` is
not a resource in `config.yaml`. Add the resource or use a local path.

**The working directory is ignored.** `workdir` must be absolute or
start with `~/`. Another value is skipped, and the log shows
`project.workdir_not_absolute`.

**`the builder is working in project '<slug>' right now`.** Stop the
builder's turn, then unpin or switch.

## See also

- [API](api.md#projects): request and response bodies of every route
- [Builder](builder.md): how a builder agent uses the project folder
- [Tools](tools.md): the file and shell tools that follow the working
  directory
- [Web client](web.md): the chat header and the Sessions window
- [Resources](resources.md): the remote machines a `resource` pointer
  can name
