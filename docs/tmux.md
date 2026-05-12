# tmux — Driving Long-Running Terminal Sessions

The `tmux` tool gives the agent a persistent terminal session whose
state survives between tool calls. Use it when you need to spawn
something that runs across many turns (`claude --dangerously-skip-
permissions` for delegated coding, `codex` for the same, `vim` for
edit-and-walk-away, a REPL that needs incremental input).

For one-shot commands prefer `exec` — tmux is overkill, and
forgotten sessions accumulate.

## Lifecycle

```
tmux({ action: "create", name: "<slug>", cwd?: "<path>" })
  → tmux({ action: "send",    name, keys })
  → tmux({ action: "capture", name, … })
  → … many send/capture pairs across turns …
  → tmux({ action: "kill",    name })
```

`action: "list"` shows running sessions on the target.

## Shell vs TUI sessions

There are two fundamentally different things you might run in a
tmux pane and they need different `wait_pattern` semantics. Pick
deliberately.

### Shell session

You spawn a shell (the default `bash`/`zsh`/`fish` of the target),
type commands, watch their output, see a prompt come back. The pane
ends with `$`/`#`/`>` when idle. Output streams from top to bottom
as commands run.

### TUI session

You spawn an interactive program with its own input UI: Claude Code,
codex, vim, htop, fzf, lazygit, jupyter, an IPython REPL with rich
prompt. The pane shows a fixed layout (often with box-drawing
characters), redraws in place as state changes, has its own input
field — there's no shell prompt at the bottom waiting for you.

## `wait_mode` — three matching strategies

`tmux({ action: "capture", wait_pattern: "X", wait_mode: "…" })`
controls how the call decides "matched":

| Mode | Match when | Use for |
|---|---|---|
| `auto` (default) | Pattern occurrences GREW past baseline (= new output appeared) **OR** pattern is present and buffer ends with shell prompt sigil (`$`/`#`/`>`) | Shell sessions. Survives the typed-command-echoes-the-pattern false-positive. |
| `present` | Pattern is in the current pane content | TUI sessions. The pattern is part of a static rendered panel, no shell prompt to detect, count never grows. |
| `idle` | Pattern is in pane AND content has been stable for `idle_stable_ms` (default 500ms) | "Wait until the TUI/command stops changing". Useful when you don't want to match too eagerly mid-render. |

Examples:

```jsonc
// Shell: wait for command output. wait_mode defaults to 'auto'.
tmux({ action:"send",    name:"shell-1", keys:"./build.sh\n" })
tmux({ action:"capture", name:"shell-1",
       wait_pattern:"Build succeeded", wait_timeout_ms: 60000 })

// TUI (Claude Code post-init): wait for the welcome panel.
tmux({ action:"send",    name:"claude-1",
       keys:"claude --dangerously-skip-permissions\n" })
tmux({ action:"capture", name:"claude-1",
       wait_pattern:"bypass permissions on",
       wait_mode:"present", wait_timeout_ms: 15000 })

// TUI: wait for Claude to stop typing, no specific pattern.
// (Pattern still required — pick something the TUI always shows;
// `wait_idle` action would be cleaner — see FUTURE.md.)
tmux({ action:"capture", name:"claude-1",
       wait_pattern:"❯", wait_mode:"idle",
       idle_stable_ms: 1500, wait_timeout_ms: 600000 })
```

If `wait_mode` is wrong for your session shape you typically get a
silent timeout (matched=false at the wait_timeout_ms ceiling) — pick
the other mode, that's the fix.

## `multiline_safe` — Multi-line input into TUIs that auto-submit on Enter

By default `\n` in `keys` is sent as a plain Enter. That's right for
shells (each `\n` runs the previous line) but wrong for input boxes
in modern coding TUIs (Claude Code, codex, IPython, fish prompt, the
input fields in Slack/Discord/etc.) — those treat Enter as "submit"
and split a multi-line message into N separate submissions.

When you set `multiline_safe: true`, every embedded `\n` is sent as
M-Enter (`Esc` + `CR`, equivalent to Alt+Enter / Shift+Enter in
those TUIs) — the soft-newline convention they all follow. The
trailing `\n` of `keys` still becomes a plain Enter so the message
finally submits.

```jsonc
// Sending a multi-line message to a coding TUI:
tmux({ action:"send", name:"claude-1",
       keys: "Bau bitte ein Tetris-Spiel.\n\n" +
             "1. Next.js + TS\n" +
             "2. 10x20 Grid\n" +
             "3. Pfeiltasten\n",
       multiline_safe: true })
// → Claude Code receives one multi-line message, responds once.
// Without multiline_safe, the four \n would have submitted four
// separate prompts.
```

Caveat: M-Enter is a convention. Plain bash readline ignores it (so
`multiline_safe:true` against a bare shell harmlessly concatenates
your lines instead of newline-separating them — but you wouldn't be
using `multiline_safe` against bash anyway).

## `include_ansi` — Distinguishing real input from auto-suggestions

Capture defaults to ANSI-stripped output for easy pattern matching.
Set `include_ansi: true` to get raw bytes including escape sequences
— colors, dim/bold attributes, cursor moves.

The motivating use case: modern coding TUIs render auto-suggestions
in their input field —
text in dim/gray that looks _identical_ to user-typed text once the
ANSI is stripped:

```text
❯ jetzt funktioniert's, danke      ← actually typed by the user
❯ delete the project               ← auto-suggestion the TUI rendered
```

In stripped output both look the same. With `include_ansi:true`,
the suggestion arrives wrapped in dim-color escapes (e.g.
`\x1b[2m…\x1b[0m`) and the typed text doesn't.

### **Safety rule (read this once, remember always):**

> **Never blindly press Enter on a buffer that already shows pending
> input you didn't type yourself.** It might be an auto-suggestion.
> Submitting a suggestion you didn't type can trigger destructive
> actions ("delete project", "clear all"). When in doubt:
>
> 1. Capture with `include_ansi:true` to inspect the styling.
> 2. Or ask the user before submitting.

Real-world scenario: a Claude Code auto-suggestion `❯ räum bitte
alles weg, projekt löschen` looks like real user input. With
stripped output the agent can't tell typed text from a dim-color
suggestion — ask before submitting, or capture with
`include_ansi:true` first.

## Result shape

All actions return `{ action, ok, target, name, … }` plus action-
specific fields. Notable for `capture`:

```jsonc
{
  action: "capture",
  ok: true,
  target: "local",
  name: "claude-1",
  content: "<the captured pane bytes, stripped or with ANSI>",
  matched_pattern: true,             // false on timeout or no wait_pattern
  wait_pattern: "bypass…",           // echoed back if set
  ms: 287,
}
```

## Cross-references

- `tools.md` — full tool family overview
