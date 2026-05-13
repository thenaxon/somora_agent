# Projects

> Curated pointer-files that bind a chat session to a real-world thing
> you're working on — a piece of code, a renovation, a research thread —
> by listing every resource that belongs to it (Obsidian notes, local
> source dirs, GDrive URLs, remote-machine paths) and surfacing the
> list in the agent's prompt so it knows what matters.

Projects are an **opt-in** feature. The default `~/.somora/config.yaml`
has them disabled — flip them on with one line.

## What it is (and isn't)

A *project* in somora is not a workspace, not a new memory layer, and
not a place where content lives. It is a **manifest of pointers**: one
small Markdown+YAML file per project that lists where the relevant
files actually live, plus some metadata (name, color, description, tags).

When you pin a project to a chat session, that manifest gets injected
into the agent's system prompt so the agent has the canonical list of
"things that belong to this conversation". The agent still uses its
regular tools (`file_read`, `obsidian_get`, `web_fetch`, `resource_*`)
to actually open any of those pointers — projects just answer the
question *which pointers*.

## Why

Long-running work tends to scatter across the filesystem: source code
in `~/code/...`, notes in your Obsidian vault, research artifacts the
agent itself produced under `~/somoraworkspace/research/...`, a Drive
folder, maybe some logs on a remote machine. Without a pinned project
the agent has to be told "look here" every time, or it free-associates
based on whatever auto-injected memory hits surface.

With a pinned project the agent gets a stable, curated list of "this is
what belongs to the project we're talking about" up front — no
guesswork, no re-explaining, no memory-recall lottery for paths.

## Enable

Edit `~/.somora/config.yaml` and add a `projects:` block:

```yaml
projects:
  enabled: true
  entities:
    - slug: privat
      label: Privat
    - slug: enovom
      label: enovom GmbH
    # add as many as you need — these are YOURS to curate
```

Restart the server:

```bash
systemctl --user restart somora
```

`entities` is a **controlled vocabulary** — projects belong to one
entity (e.g. "Privat" or "enovom"), and the agent must pick from this
list at create time. See [Entities](#entities-the-controlled-vocabulary)
below for why this matters.

When `projects.enabled` is `false` (or the block is missing
altogether), the entire feature is invisible — no slash commands, no
chip in the chat header, no Project column in the Sessions browser,
no project tools in the agent's tool list, all `/projects/*` HTTP
routes return 503. Toggle the flag any time without other config
changes.

## Storage layout

```
~/.somora/
└── projects/
    ├── heimkino.md
    ├── steuern-2025.md
    ├── enovom-website.md
    └── ...
```

One file per project, named `<slug>.md`. Slug is lowercase
kebab-case: `[a-z0-9_-]+`. The file holds pure YAML frontmatter with
an empty body — by design. Notes that *belong to* a project go in
separate Markdown files referenced as pointers, not inside the
project file itself.

Example `~/.somora/projects/heimkino.md`:

```yaml
---
slug: heimkino
name: Heimkino
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
paths:
  - ref: ~/code/heimkino-config/
    label: Sourcecode
  - ref: ~/Documents/somora-vault/Heimkino/Setup.md
    label: Setup notes
  - ref: https://drive.google.com/drive/folders/xyz
    label: Drive folder
  - ref: mac-studio:/Users/n/heimkino-logs/
    label: AVR logs
---
```

Files are user-readable + git-able, but you typically don't edit them
by hand — the agent maintains them via the project tools (see below).

## Entities — the controlled vocabulary

Each project must belong to exactly one entity, and the entity slug
must match one of the entries you configured in
`config.projects.entities`. Agents cannot extend the entity list via
tools — only you can, by editing `config.yaml`.

This is the **voice-input safety net**: when you say something like
"create a new project Heimkino as an enovom project" and the
transcription comes back fuzzy ("enofhom" because the mic didn't
hear clearly), the agent calls `entity_list` first, sees the actual
options (`privat`, `enovom`, `firma2`, …), and picks the closest
match instead of inventing a new phantom category. If it does call
`project_create` with the misspelled slug anyway, the tool rejects
with `unknown entity 'enofhom' — available: privat, enovom, firma2`
so the agent retries.

Entities also give you a free filter axis. `project_list({entity:
'privat'})` returns only your private projects; the same query in
the web Sessions browser narrows the dropdown.

## Pointer types

Paths in a project file are scheme-inferred — there is **no `type`
field stored on disk**. Whatever you put in `ref` gets classified at
read time:

| Prefix shape | Inferred type | Agent uses |
|---|---|---|
| `~/...` or `/...` | `local` | `file_read`, `file_list`, `file_search` |
| `<scheme>://...` (https, gdrive, ftp, …) | `url` | `web_fetch`, GDrive skill, browser tools |
| `<resource-slug>:/...` | `resource` | `file_read({target:'<resource>'})`, `exec({target:'<resource>'})` |

Examples:

```yaml
paths:
  - ref: ~/code/heimkino                  # local — file_list to drill in
  - ref: /mnt/naxon/recordings/heimkino   # local
  - ref: https://drive.google.com/...     # url
  - ref: mac-studio:/Users/me/foo.log     # resource — must match config.resources
  - ref: spiderman:/home/me/checkpoints   # resource
```

For `resource` paths, the prefix before `:/` must match a slug in
`config.resources`. At write time the tool rejects unknown resource
slugs with the list of available targets. For `local` and `url`
paths there's no existence check — paths can point at things that
don't exist yet (planned files, etc.).

### Why scheme-inferred and not stored

A single `add_path` operation accepts any of the three shapes. Adding
a new pointer type later — say a custom `gdrive://` scheme with smart
caching — is a parser change in one file, not a frontmatter migration
across every existing project. The trade-off: a literal local path
with a colon-slash in the middle would be ambiguous; in practice
nobody hits that.

## Soft-delete (archive)

Projects you don't actively use anymore go in the **archive** state
instead of being hard-deleted. Set `archived: true` (via the
`project_update` tool with the `archive` op) and the project:

- disappears from `project_list` by default,
- disappears from the project switcher in the chat-header chip,
- disappears from the slash-command autocomplete,
- still resolves by slug if you `project_get` it directly,
- keeps showing up in any session that had it pinned *before*
  archive — the pin keeps working, an ⚠ marker appears in the chip.

Pass `includeArchived: true` to surface them. Archived projects can
be restored at any time with the `unarchive` op.

Hard delete is **not** exposed through any tool — if you really want
a project file gone, `rm ~/.somora/projects/<slug>.md`. Deliberate
choice: agents shouldn't be able to silently wipe the only manifest
linking a session to its real-world work.

## Pinning a project to a session

Each session has at most one pinned project at a time. The pin is
stored in the session's meta file (`session.meta.json`) and survives
restarts, model switches, and archive/unarchive on the project.

Three ways to pin / unpin:

| How | Surface | When to use |
|---|---|---|
| `/projekt <slug>` (or `/project <slug>`) | TUI + web slash popup | You know which project. |
| Click the chip / folder button | Web chat-header | Browse + pick from the switcher popover. |
| Agent calls `project_focus` tool | Mid-turn, autonomously | The agent realises the conversation is about project X and pins it for context continuity. |

Clear the pin the same way: `/projekt unlink`, the Unlink button in
the switcher, or `project_focus({slug: null})` from the agent.

### What happens when you pin

1. `session.meta.json` gains `projectSlug: "<slug>"` and
   `projectLinkedAt: "<ISO>"`.
2. A `project_switched` event is appended to the session's JSONL log
   for forensics ("from which turn onwards did this session see the
   Heimkino context?").
3. On the **next** chat turn, the project file is rendered into the
   system prompt:

   ```
   ## Active Project: Heimkino

   **Entity:** privat
   **Description:** Receiver, beamer, acoustic treatment in the living room
   **Tags:** hardware, wip

   **Pointers:**
   - `[local]`    ~/code/heimkino-config/ — Sourcecode
   - `[local]`    ~/Documents/somora-vault/Heimkino/Setup.md — Setup notes
   - `[url]`      https://drive.google.com/drive/folders/xyz — Drive folder
   - `[resource]` mac-studio:/Users/n/heimkino-logs/ — AVR logs

   When the user asks about this project, treat the pointers above as
   the canonical list of relevant resources. Use your standard tools
   (file_read for [local], web_fetch/browser tools for [url], resource
   tools for [resource]) to access them on demand — do not assume
   their contents from memory.
   ```

Re-pinning the same project is a noop — `previousSlug === currentSlug`
short-circuits without writing a new event.

### Prompt-cache impact

The project block sits in the **stable** part of the system prompt,
*after* the skills registry and *before* the per-turn memory
ephemeral context. That ordering matters:

- `selfPointer` and `persona.systemPrompt` are session-stable.
- `skillsBlock` changes only when SKILL.md files change (rare).
- `projectBlock` changes only when you `/projekt` switch (rare).
- `ephemeralContext` (memory recall) changes every turn.

Each layer being placed in increasing-volatility order means a
project switch only invalidates from this point onward; everything
above stays cached. A typical Anthropic prompt cache survives the
switch with just one extra cache breakpoint to recompute.

The `codex-cli` engine drops `systemPrompt` on resumed sessions
(codex remembers it internally from session-start), so somora
inlines the project block via the user-message-prefix path on
codex-resume — the model sees it either way, with a small
duplication cost only in the first turn after a pin.

## CRUD via the agent

The agent owns the project files. You can sit in the chat and say:

> "Make a new project Heimkino as a Privat project, source code is at
> `~/code/heimkino`, the Drive folder is `<url>`, the setup notes are
> in my Obsidian vault under `Privat/Heimkino/Setup.md`. Pin it."

… and the agent calls, in order: `entity_list` (to confirm it
heard "Privat" right), `project_create` (with all four pointers in
the same call), `project_focus` to pin the new project.

Three weeks later: "Add `~/research/atmos-comparison.md` to the
Heimkino project." The agent calls `project_update` with a single
`add_path` op.

### Multi-op updates

`project_update` accepts an `ops` array applied **transactionally** —
either all ops validate and a single write happens, or nothing is
written. Useful for batch edits in one round-trip:

```json
{
  "slug": "heimkino",
  "ops": [
    { "op": "add_path", "ref": "~/research/atmos.md", "label": "Atmos notes" },
    { "op": "set_field", "field": "description", "value": "Updated wording" },
    { "op": "set_tags", "tags": ["hardware", "wip", "avr"] }
  ]
}
```

Supported ops:

| `op` | Required fields | Effect |
|---|---|---|
| `set_field` | `field`, `value` (nullable) | Update `name`/`description`/`color`/`expires`; `value: null` clears optional fields (cannot clear `name`). |
| `add_path` | `ref`, `label?` | Append a pointer; scheme + resource cross-check. |
| `remove_path` | `ref` | Remove by exact ref match. |
| `set_tags` | `tags: string[]` | Replace the full tag array. |
| `archive` | `reason?` | Soft-delete. |
| `unarchive` | — | Restore. |

Slug and entity are **not mutable** in v1. To change either, delete
the project file and recreate it (any pinned sessions just lose
their pin — same as hard-delete).

## UI

### TUI

| Surface | When |
|---|---|
| `/projekt <slug>` / `/project <slug>` | Pin a project. |
| `/projekt unlink` (or `off` / `clear` / `-`) | Clear the pin. |
| `/projekt` (no arg) | Print status of the currently-pinned project: entity, description, tags, pointer list. |
| `/projects` | List all configured projects with entity + path count. |
| Chip in the chat header (next to mem/tools toggles) | When a project is pinned. Shows `📁 <name>`, ⚠ if archived. Hidden when nothing's pinned. |
| `[slug]` annotation in `/sessions` rows | Where a session has a pinned project. |

### Web

| Surface | When |
|---|---|
| ProjectChip in chat-header-actions (left of ••• button) | Always visible when the feature is enabled; ghost-folder button when nothing's pinned, color-pill with name when pinned. |
| Click chip → Switcher popover | List of projects grouped by entity, search box, Unlink button when currently pinned. |
| `/projekt <slug>` / `/project <slug>` in the slash popup | Autocomplete from `/projects`. |
| `/projekt unlink` row in the slash popup | First row, always reachable. |
| Project column in the Sessions browser | Color-coded chip per row when a session has a pinned project. |
| Live SSE update | The chip refreshes within ~100ms of any client setting/clearing a pin via slash, switcher, or HTTP — including cross-client (TUI pinned, web sees the chip change). Agent-side tool focus changes also refresh, but only at the end of the turn (MCP children have no SSE channel). |

## Building integrations — HTTP API

All UI is built on top of a thin HTTP+SSE surface, same set both
TUI and web consume. See [api.md](api.md#projects) for the full
reference. The shape is:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/projects/feature` | Boolean feature-flag probe (always 200). |
| `GET` | `/projects/entities` | Curated entity vocabulary. |
| `GET` | `/projects` | List projects (filterable by entity / tag / includeArchived). |
| `GET` | `/projects/:slug` | Full project file content. |
| `POST` | `/projects` | Create. |
| `PATCH` | `/projects/:slug` | Multi-op update. |
| `GET` | `/agents/:agent/sessions/:session/project` | Current pin for a session (returns full project). |
| `POST` | `/agents/:agent/sessions/:session/project` | Set the pin. |
| `DELETE` | `/agents/:agent/sessions/:session/project` | Clear the pin. |

All `/projects/*` routes return `503` when `projects.enabled` is
false. Clients should probe `/projects/feature` once at boot to
decide whether to surface the feature at all.

## What's deliberately not in v1

- **Project create/edit in the web UI.** Agent-via-chat is the
  intended authoring surface; the web is read + switch only. A form
  builder may come in v1.x.
- **Color picker / icon picker.** Set `color: "#..."` in the file
  directly or ask the agent to `project_update set_field color`.
- **TODO list inside the project file.** Free-form notes belong in a
  separate `<slug>-notes.md` that's referenced as a pointer.
- **Multi-step hierarchies.** Entities and projects are flat. No
  sub-projects, no nested entities. Tags handle cross-cutting
  classification.
- **Auto-archive on `expires`.** The `expires` field is stored for
  your reference; no background job ever flips a project to archived
  based on it.
- **Hard delete tool.** `rm` the file manually if you really mean it.
- **Slug rename.** Would break pinned-session references. Workaround:
  delete + recreate (pinned sessions just lose the pin).
- **GDrive resolver.** Drive URLs are stored as plain `url` pointers;
  the agent uses an installed GDrive skill (if any) to actually fetch
  them. somora doesn't ship its own GDrive client.

## Reference: file fields

| Field | Required | Type | Notes |
|---|---|---|---|
| `slug` | yes | string | `[a-z0-9_-]+`, unique, mirrors filename. |
| `name` | yes | string | Display name, any characters. |
| `entity` | yes | string | Must match `config.projects.entities[].slug`. |
| `description` | no | string | Free text. |
| `color` | no | string | CSS color, e.g. `#4f46e5`. |
| `tags` | no | string[] | Free vocabulary. |
| `created` | yes | ISO timestamp | Set by `project_create`. |
| `updated` | yes | ISO timestamp | Bumped on every `project_update`. |
| `expires` | no | ISO date string \| null | Pure metadata. |
| `archived` | yes | boolean | Soft-delete flag. |
| `archivedAt` | no | ISO timestamp | Set by the `archive` op. |
| `archiveReason` | no | string | Set by the `archive` op. |
| `paths` | yes | `{ref, label?}[]` | Pointer list. Default `[]`. |
