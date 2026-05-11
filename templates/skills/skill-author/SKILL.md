---
name: skill-author
description: How to create or update a somora skill correctly — always use the somora skill CLI, never write SKILL.md directly.
metadata:
  somora:
    when_to_use: When the user asks you to create, install, or update a somora skill (whether self-written or sourced from a URL). Also when editing an existing skill where you want to verify it before reload.
    tags: [meta, authoring]
---

# Authoring somora skills

When the user asks you to create a new skill, **always use the somora skill CLI**. Do not write SKILL.md files directly with the Write tool — the CLI pre-flights the lint that would otherwise reject your file at load time.

## Create a new skill from scratch

Pick a template based on what the skill does:

- `cli-wrapper` — orchestrates an installed command-line tool (e.g. wraps `gh`, `op`, `gog`)
- `api-wrapper` — calls an HTTP API
- `default` — everything else

Then run:

```
somora skill add <slug> --template <template-name> --description "<one-line>"
```

## Install a skill from a URL

### Direct markdown URL

```
somora skill add <slug> --from-url <https-url-to-raw-SKILL.md>
```

The CLI downloads, sniffs for HTML (rejects landing pages), lints, and only writes if everything passes.

### ClawHub marketplace

ClawHub (`https://clawhub.ai`, repo `openclaw/clawhub`) is OpenClaw's public skill registry. Pass any `clawhub.ai/<owner>/<slug>` web URL directly — somora detects it, downloads the ZIP via ClawHub's public API, extracts sub-resources, and translates `metadata.openclaw.*` frontmatter to `metadata.somora.*` automatically.

```
somora skill add github --from-url https://clawhub.ai/steipete/github
```

If ClawHub has the skill flagged as malware-blocked, the install refuses with a precise reason. Rate-limit errors (429) surface the `Retry-After` value so the user knows when to retry.

If lint fails, **do not** work around it by writing the file manually — fix the source SKILL.md instead.

## Verify a skill before reload

```
somora skill check <slug>
```

Exits 0 if healthy, 1 if lint errors. Run this after manual edits before relying on the skill in agent flows.

## Update a built-in skill

If somora ships a new version of a built-in (e.g. this `skill-author` skill itself), and the user's local copy is unedited, the update is applied silently on server start. If the user has edited their copy, somora preserves the edit. To force-overwrite a user copy with the bundled version:

```
somora skill update <slug>
```

## Remove a skill

```
somora skill remove <slug>
```

For built-ins, removal triggers a re-seed on the next server start.

## After adding or editing

The server re-reads SKILL.md at the next agent turn (no restart required). `somora skill list` reflects changes immediately.

## Anti-patterns the linter rejects

- Setup instructions in the body (`Setup on this host`, `eval $(brew shellenv)`, `export X=...`) — these get loaded verbatim into agent context every turn. Use a `BOOTSTRAP.md` sibling instead (read on demand via `file_read`, not as ambient context).
- Inline secrets (`export TOKEN=xyz`) — declare `requires.env_vars` in frontmatter; somora reports the skill unavailable with a precise reason if the env vars are missing.
- Body > 200 lines — split into sub-resources and reference them by relative path.
- Full HTML documents (`<!DOCTYPE html>`, `<html>`) — happens when `--from-url` points at a marketplace landing page instead of raw markdown. Use the marketplace's canonical URL (e.g. `clawhub.ai/<owner>/<slug>`) which routes through a dedicated resolver, or download SKILL.md manually and use `--from-file`.

See the `gog` skill (`~/.somora/skills/gog/`) for a clean reference implementation.
