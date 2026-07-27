---
name: __SLUG__
description: "__DESCRIPTION__"
metadata:
  somora:
    when_to_use: "__WHEN_TO_USE__"
    requires:
      bins: ["__BIN_NAME__"]     # optional min version: "__BIN_NAME__>=1.0"
      env_vars: []               # declared vars are auto-injected into exec
                                 # commands that invoke the bins above (values
                                 # from ~/.somora/somora.env)
---

# __SLUG__

This skill wraps the `__BIN_NAME__` CLI. Setup details (install, auth, env-vars) live in `BOOTSTRAP.md` — read that on demand the first time the skill is reported as unavailable.

## Common operations

(Document the most useful command patterns. One line each, no `eval`/`export` in the body.)

## See also

- `BOOTSTRAP.md` — install + auth, read via `file_read` when needed.
