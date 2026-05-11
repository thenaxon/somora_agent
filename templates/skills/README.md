# somora templates/skills

Source of truth for skills somora ships in its own package.

## Layout

- **Top-level folders (e.g. `skill-author/`)** — Built-in skills. Seeded into `~/.somora/skills/<slug>/` at server start if the user copy does not exist. If the user later edits their copy, somora detects the edit (via SHA-256 content hash recorded in `~/.somora/.skill-seed-state.json`) and stops re-seeding that slug on future updates. To force a re-seed, run `somora skill update <slug>`.

- **`_templates/`** — Reserved namespace. Holds templates consumed by `somora skill add <slug> --template <name>`. Each subfolder is one template (`default`, `cli-wrapper`, `api-wrapper`, ...). These are NEVER loaded as skills directly — the leading underscore makes the dir name fail the slug regex (`^[a-z0-9]+(-[a-z0-9]+)*$`).

Placeholders inside template files use `__SLUG__`, `__DESCRIPTION__`, `__WHEN_TO_USE__`, `__BIN_NAME__`. The CLI substitutes these before writing.

## Adding a new built-in

1. Create `templates/skills/<slug>/SKILL.md` (and optional sub-resources).
2. Make sure the body passes `lintSkillBody()` (run `somora skill check <slug>` after a manual seed if unsure).
3. Bump somora version. On the next install + server start, every user gets the new skill at `~/.somora/skills/<slug>/`.
4. If you later modify the bundled file, users who haven't edited their copy will get the update on next server start; users who edited theirs see a `skills.builtin_user_edited` warning and have to opt in via `somora skill update <slug>`.

## Adding a new template

1. Create `templates/skills/_templates/<name>/SKILL.md` (plus optional siblings like `BOOTSTRAP.md`).
2. Use the `__PLACEHOLDER__` substitution conventions.
3. The CLI auto-discovers templates by listing `_templates/`.
