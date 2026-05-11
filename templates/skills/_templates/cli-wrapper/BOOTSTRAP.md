# __SLUG__ — Setup

Read this once when somora reports `__SLUG__` as unavailable. Do NOT inline these steps into `SKILL.md` — that would push setup text into every agent turn.

## Install

(Document the install command, e.g. `brew install __BIN_NAME__` or `pipx install __BIN_NAME__`.)

## Authenticate / configure

(Document required env vars and how to set them. Put secrets into `~/.somora/somora.env` — somora reads it at server start. Do NOT inject env vars per-call from inside the agent.)

Example:

```
# in ~/.somora/somora.env
__BIN_NAME___TOKEN=...
```

After editing `~/.somora/somora.env`, restart somora:

```
somora server restart
```

## Verify

```
somora skill check __SLUG__
```

Should print "Skill '__SLUG__' is healthy."
