---
name: __SLUG__
description: "__DESCRIPTION__"
metadata:
  somora:
    when_to_use: "__WHEN_TO_USE__"
    requires:
      env_vars: []
---

# __SLUG__

This skill teaches the agent to call an HTTP API. Use somora's HTTP-capable tools (`fetch_url`, `exec` with curl, or a dedicated API tool if one exists) — never embed API keys in this body.

## Endpoints

- `GET /...` — what it does
- `POST /...` — what it does

## Auth

API keys live in `~/.somora/somora.env`. Declare them in `requires.env_vars` so somora reports the skill unavailable if they are missing.

## Examples

(One or two concrete request shapes.)
