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
    thinking: false         # model thinking text above each reply
```

The TUI fetches these from the server at startup (`GET /tui-config`)
and uses them as initial values. Single config reader: server.

## `/show` — line visibility

```
/show                       — list current state
/show memory on|off         — show/hide [memory · …] inject lines
/show tools on|off          — show/hide [tool call · …] / [tool result · …]
                              AND [◌ engine · …] meta lines
```

When a flag is **off**, the corresponding SSE event still arrives at the
TUI but is dropped before the row is appended to the scrollback. New
events are dropped going forward; rows that already rendered stay as-is.

The header surfaces the current state with `mem ✓ tools ✗` badges.

`/show tools` is also the gate for **engine_meta** rows — codex-cli
emits internal plan/checklist items (`itemType: todo_list`) that we
persist alongside tool calls. They render with a dimmer `◌ codex ·
plan · 3 tasks · 2 done` prefix and expand to a task list when
`/verbose tools on`. Conceptually they belong to the same "agent
internals" bucket as tool calls, hence the shared toggle. See
[setup.md](setup.md#engine-meta--codex-todo_list) for the mechanism.

## `/verbose` — detail level

```
/verbose                    — list current state
/verbose tools on|off       — full input/output payload below each tool call/result
/verbose memory on|off      — full memory inject text below each [memory · …] line
/verbose system on          — print the agent's persona system prompt as a one-shot block
/verbose system off         — clear the system flag (no effect on previously printed blocks)
/verbose thinking on|off    — show the model's thinking text above each reply
```

Verbose data is always on the wire — server pre-formats and includes it
in every relevant SSE event:

| event    | always sent             | verbose-only render trigger              |
|----------|-------------------------|------------------------------------------|
| `tool`   | `tool`, `summary`       | `details` (pretty-printed JSON payload)  |
| `memory` | `count`, `topScore`, `refs` | `fullText` (the inject block as it landed in the model's context) |
| `thinking` | `text` (cumulative), `truncated` | the whole event — nothing renders unless `/verbose thinking on` |
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

## `/verbose thinking` — the model's reasoning text

Off by default. When on, the model's thinking content lands in the
scrollback as a gray, indented `🧠 thinking` block directly above the
reply it produced (`(truncated)` is appended to the label when the
server cut the text at its cap). While the model is still thinking and
no reply text has arrived yet, the last six lines of the thinking text
show live where the reply will appear; the first reply token replaces
them. A finalized block renders at most 40 lines and ends with
`… (+N lines)` for the rest, so a long reasoning dump cannot flood the
terminal. Switching to a session replays stored thinking rows only
when the toggle is on at that moment. The block only appears for
engines and models that surface thinking at all — see
[thinking.md](thinking.md) for the engine matrix. The `🧠 thinking…`
header badge and the reasoning token counter work regardless of this
toggle.
