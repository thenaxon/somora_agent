# TUI display toggles

The Ink CLI has two complementary toggle families: **show** (whether a
row appears at all) and **verbose** (how much detail when it does).
Both are TUI-side render state — the server keeps streaming everything
either way.

## Defaults from config

`~/.somora/config.yaml`:

```yaml
tui:
  show:
    memory: true            # [memory · …] inject lines visible
    tools: true             # [tool call · …] / [tool result · …] visible
  verbose:
    tools: false            # full input/output payloads expanded
    memory: false           # full memory inject text expanded
    system: false           # /verbose system on flag at boot
```

The TUI fetches these from the server at startup (`GET /tui-config`)
and uses them as initial values. Single config reader: server.

## `/show` — line visibility

```
/show                       — list current state
/show memory on|off         — show/hide [memory · …] inject lines
/show tools on|off          — show/hide [tool call · …] / [tool result · …] lines
```

When a flag is **off**, the corresponding SSE event still arrives at the
TUI but is dropped before the row is appended to the scrollback. New
events are dropped going forward; rows that already rendered stay as-is.

The header surfaces the current state with `mem ✓ tools ✗` badges.

## `/verbose` — detail level

```
/verbose                    — list current state
/verbose tools on|off       — full input/output payload below each tool call/result
/verbose memory on|off      — full memory inject text below each [memory · …] line
/verbose system on          — print the agent's persona system prompt as a one-shot block
/verbose system off         — clear the system flag (no effect on previously printed blocks)
```

Verbose data is always on the wire — server pre-formats and includes it
in every relevant SSE event:

| event    | always sent             | verbose-only render trigger              |
|----------|-------------------------|------------------------------------------|
| `tool`   | `tool`, `summary`       | `details` (pretty-printed JSON payload)  |
| `memory` | `count`, `topScore`, `refs` | `fullText` (the inject block as it landed in the model's context) |
| —        | —                       | `/verbose system on` fetches `GET /agents/:agent/system-prompt` once and prints it |

This means toggling `/verbose tools on` is instant for the next tool
call — no reconnection needed. Already-rendered rows do not retroactively
expand (consistent with `/show`).

## Why `details` lives on the wire

A natural alternative is "client requests verbose payloads". We chose
"server always sends, client always renders selectively" because:

1. **Bandwidth is local.** Even a chunky JSON tool result is kilobytes
   on a localhost SSE — not worth the protocol round-trip to negotiate.
2. **No client-side schema knowledge.** The server already pretty-prints
   payloads in `src/server/tool-format.ts`. Clients render strings,
   never inspect tool-specific structure. Same thin-client principle as
   the summary line.
3. **Future clients (Orbit, web).** They consume the same SSE events and
   can implement the verbose toggle without a new endpoint.

## Interaction with each other

`/show memory off` wins over `/verbose memory on` — if the line isn't
shown at all, there's no place to attach the verbose details. Same for
tools. Treat `/show` as the master switch, `/verbose` as the zoom level.

## What's not covered yet

**Thinking-block content** is not part of `/verbose tools` or any other
existing topic. Surfacing the model's reasoning text inline (collapsible,
dimmed) would land as `/verbose thinking on` once the engine adapters
emit thinking deltas as a separate SSE event (see `docs/thinking.md` for
the deferred work).
