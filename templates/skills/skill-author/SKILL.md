---
name: skill-author
description: How to create, install, and fully set up a somora skill — always use the somora skill CLI, never write SKILL.md directly.
metadata:
  somora:
    when_to_use: When the user asks you to create, install, or update a somora skill (whether self-written, from a URL, or a marketplace link). Also when a skill shows as unavailable and you need to finish its setup, or when editing an existing skill.
    tags: [meta, authoring]
---

# Authoring & installing somora skills

When the user asks you to create or install a skill, **always use the somora skill CLI**. Do not write SKILL.md files directly with the Write tool — the CLI pre-flights the lint that would otherwise reject your file at load time.

## Create a new skill from scratch (conversational path)

Pick a template based on what the skill does:

- `cli-wrapper` — orchestrates an installed command-line tool (e.g. wraps `gh`, `op`, `gog`)
- `api-wrapper` — calls an HTTP API
- `default` — everything else

Then run:

```
somora skill add <slug> --template <template-name> --description "<one-line>"
```

Fill in the body, then **declare what the skill needs** (next section) and finish with the setup checklist below.

## Install a skill from a URL

### Direct markdown URL

```
somora skill add <slug> --from-url <https-url-to-raw-SKILL.md>
```

The CLI downloads, sniffs for HTML (rejects landing pages), lints, and only writes if everything passes.

### ClawHub marketplace

ClawHub (`https://clawhub.ai`) is OpenClaw's public skill registry. Pass the web URL directly — somora detects it, downloads the ZIP via ClawHub's public API, extracts sub-resources, and translates the frontmatter (`metadata.openclaw.*`, legacy `clawdbot`/`clawdis` too) to `metadata.somora.*` automatically.

**Prefer the owner-qualified URL** — slugs are not unique across owners:

```
somora skill add gog --from-url https://clawhub.ai/steipete/skills/gog
```

A bare-slug URL of a contested slug fails with a 409 that lists every candidate URL — re-run with the right one. Malware-blocked skills refuse to install with a precise reason; rate-limit errors (429) surface the `Retry-After` value.

## Declare what the skill needs

Requirements live in the frontmatter and are ENFORCED, not just documentation:

```yaml
metadata:
  somora:
    requires:
      bins: ["gog>=0.30"]        # binary + optional minimum version
      env_vars: [GOG_KEYRING_PASSWORD]
```

- `bins` — somora checks existence AND the version constraint (via `--version`), and warns when the same binary exists at multiple paths (version split-brain). Declare every CLI the body invokes.
- `env_vars` — declare every secret/config var the CLI needs. Once the values are set in `~/.somora/somora.env`, somora injects them automatically into exec commands that invoke one of the declared `bins` — and ONLY into those. Never hardcode secrets or `export` them in the body.

## Post-install checklist (run after every install)

1. `somora skill check <slug>` — shows unavailable-reasons and warnings.
2. **Missing bin?** Install it (ask the user before installing system-wide; prefer the official release channel). If a version-constraint or multiple-installs warning appears, upgrade/remove the stale copy — do NOT work around it with wrapper scripts.
3. **Missing env vars?** Ask the user for the values and have them added to `~/.somora/somora.env` (`KEY=value` lines, one per line). The file is loaded at server start — after adding values, the user must restart somora (`systemctl --user restart somora`) before the vars are visible.
4. **Read `BOOTSTRAP.md`** in the skill folder if present — it holds one-time host setup (auth flows, config files) that deliberately lives outside the always-loaded body. Follow it step by step.
5. Re-run `somora skill check <slug>` until healthy, then run ONE real command from the skill body via exec as a smoke test before telling the user it's ready.

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

The server re-reads SKILL.md at the next agent turn (no restart required). `somora skill list` reflects changes immediately. Note the asymmetry: skill FILES reload per turn, but env-var VALUES load at server start (step 3 above).

## Anti-patterns the linter rejects

- Setup instructions in the body (`Setup on this host`, `eval $(brew shellenv)`, `export X=...`) — these get loaded verbatim into agent context every turn. Use a `BOOTSTRAP.md` sibling instead (read on demand via `file_read`, not as ambient context).
- Inline secrets (`export TOKEN=xyz`) — declare `requires.env_vars` in frontmatter; somora reports the skill unavailable with a precise reason while they're missing and injects them into the skill's commands once set.
- Body > 200 lines — split into sub-resources and reference them by relative path.
- Full HTML documents (`<!DOCTYPE html>`, `<html>`) — happens when `--from-url` points at a marketplace landing page instead of raw markdown. Use the marketplace's canonical URL (e.g. `clawhub.ai/<owner>/skills/<slug>`) which routes through a dedicated resolver, or download SKILL.md manually and use `--from-file`.

See the `gog` skill (`~/.somora/skills/gog/`) for a clean reference implementation.
