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

## `kind` — Declaring what runs in the pane

For known coding-TUIs you can tell somora what's running inside the
session at create-time. Set `kind: "claude-code"`, `kind: "codex"` or
`kind: "opencode"` and two things happen automatically on every `capture` and
`wait_idle` against that session:

1. A structured `tui_state: { state, markers, suggestion_visible,
   suggestion_text }` block is added to the result. `state` is one of
   `"ready" | "queued" | "running" | "idle_unknown"`. `markers` is the
   list of substrings that matched the kind's marker table.
   `suggestion_visible` / `suggestion_text` report ghost text (the
   TUI's dim auto-suggestion on its input line) — detected via an
   automatic ANSI probe, so you don't need `include_ansi` for this.
   A visible suggestion is a hint the TUI renders for a human; it is
   NOT real typed input — ignore it (don't clear it, don't mention
   it, don't submit it).
2. `wait_idle` no longer returns prematurely on a content-stable-but-
   not-actually-ready pane. A `claude --dangerously-skip-permissions`
   session that's sitting on `Press up to edit queued messages` is
   content-stable but the TUI hasn't processed the input yet —
   without `kind`, `became_idle` would flip to `true` and the agent
   would proceed too early. With `kind: "claude-code"`, the queued
   marker is recognised and `wait_idle` waits until the state is
   actually `ready`.

The kinds and what they detect:

| `kind` | Watches for | Use for |
|---|---|---|
| `shell` (default) | nothing — pure content-stability | bash/zsh/fish, build scripts, REPLs, vim/htop, anything not in the list below |
| `claude-code` | `Press up to edit queued messages` (queued), `esc to interrupt` + spinner words like `Tempering…` / `Whisking…` (running) | `claude` / `claude --dangerously-skip-permissions` |
| `codex` | `esc to interrupt` (running) | `codex` CLI |
| `opencode` | `QUEUED` label under a message submitted mid-turn (queued), `esc interrupt` footer cue (running) | `opencode` TUI ([sst/opencode](https://github.com/sst/opencode)) |

Pick `shell` (or omit the field) when unsure — the TUI flags are
additive and only help if the correct kind is declared. A wrong
`kind` doesn't break the session, but the markers won't match the
actual TUI so the extra detection is wasted.

```jsonc
// Claude Code workflow with TUI-aware wait_idle.
tmux({ action: "create", name: "claude-1",
       kind: "claude-code",
       cwd: "/path/to/project" })
tmux({ action: "send",   name: "claude-1",
       keys: "claude --dangerously-skip-permissions\n" })
// … later, after sending a long multi-line prompt …
const r = await tmux({ action: "wait_idle", name: "claude-1",
                       wait_timeout_ms: 600_000 })
if (r.tui_state?.state === "queued") {
  // Input is in Claude Code's composer but wasn't submitted.
  // Don't proceed — submit explicitly or ask the user.
} else if (r.tui_state?.state === "running") {
  // Still working. Either wait longer or send key:"Escape" to interrupt.
} else if (r.became_idle && r.tui_state?.state === "ready") {
  // Truly done — proceed with the next step.
}
```

```jsonc
// Codex workflow.
tmux({ action: "create", name: "codex-1",
       kind: "codex",
       cwd: "/path/to/project" })
tmux({ action: "send",   name: "codex-1", keys: "codex\n" })
const r = await tmux({ action: "wait_idle", name: "codex-1",
                       wait_timeout_ms: 120_000 })
if (r.tui_state?.state === "running") {
  // esc-to-interrupt marker present — codex is still working.
}
```

```jsonc
// OpenCode workflow — same shape. Two OpenCode specifics:
//  - a "△ Permission required" dialog (Allow once / Allow always /
//    Reject) reads as `ready`: it is waiting for you. `capture` shows
//    the dialog; answer with key:"Enter" (Allow once is preselected)
//    or arrow keys + Enter to pick another option.
//  - a message sent while a turn runs is QUEUED and auto-submitted when
//    the turn ends, so `queued` means "still going to work after this".
tmux({ action: "create", name: "oc-1", kind: "opencode", cwd: "/path/to/project" })
tmux({ action: "send",   name: "oc-1", keys: "opencode\n" })
const r = await tmux({ action: "wait_idle", name: "oc-1", wait_timeout_ms: 600_000 })
if (r.became_idle && r.tui_state?.state === "ready") {
  const c = await tmux({ action: "capture", name: "oc-1" })
  if (c.content.includes("Permission required")) {
    tmux({ action: "send", name: "oc-1", key: "Enter" })   // Allow once
  }
}
```

OpenCode's model comes from `~/.config/opencode/opencode.json`; any
OpenAI-compatible endpoint works (a local model behind LiteLLM/vLLM/
sglang, for instance), so this is the natural kind for driving a
self-hosted coding model.

## Attention watcher — wake me when the CLI is done

Sessions created with `kind: "claude-code"`, `kind: "codex"` or
`kind: "opencode"` are
watched server-side: somora polls the pane every few seconds and
detects the moment the CLI goes from *running* to *ready* — which
means "finished" or "waiting for input" (e.g. a permission prompt).

What happens then depends on whether the agent that created the
session saw it happen:

- **The agent observed it itself** (its `wait_idle` returned the ready
  state, or a later `capture` saw it) → nothing. No duplicate nudge.
- **The agent missed it** (its `wait_idle` timed out and its turn
  ended while the CLI kept working) → somora dispatches a wake turn to
  the originating agent + session: *"tmux session X became ready —
  read the output and continue."* The turn renders as a `tmux` system
  divider in web/mobile/TUI, exactly like Sentinel triggers do.

Rules that keep this calm:

- One wake per completion. An ignored wake is never repeated — the
  session re-arms only after the agent interacts with it again.
- Configurable cooldown between wakes and a daily per-session cap
  (see below). Past the cap only the `needs_attention` flag is set.
- Only somora-created sessions with a coding-CLI `kind` are watched.
  Manual `tmux new` sessions and `kind: "shell"` are never touched.
- Opt out per session with `attention: false` on create.

`capture`, `wait_idle` and `list` responses include an `attention`
block for watched sessions:

```jsonc
"attention": {
  "needs_attention": true,      // completion nobody has looked at yet
  "last_event_at": 1785150000000,
  "last_wake_at": null,
  "wakes_today": 0,
  "state": "ready"
}
```

Config (`config.yaml`):

```yaml
tmux:
  attention:
    enabled: true            # watcher + metadata/badge
    wake: true               # agent-wakeup stage (false = flag only)
    pollMs: 3000
    cooldownS: 60
    dailyCapPerSession: 40
```

## `inherit_agent_env` — Sharing somora's isolated Claude tree

By default, sessions you create with `tmux({ action: "create" })` get
somora's internal isolation env vars (`CLAUDE_CONFIG_DIR`,
`SOMORA_CLAUDE_BIN`) **stripped** before the user's shell starts.
That's almost always what you want: a tmux session in a project
directory should behave like a normal terminal — a `claude` or
`codex` started inside the pane should see the user's normal
`~/.claude` login state, not somora's isolated tree.

The rare opt-in is `inherit_agent_env: true` on `create` — somora's
internal env carries through. Use this when:

- you intentionally want a nested `claude-cli` inside tmux to talk
  to the same isolated state somora's own engine uses;
- you're debugging a state-related issue and need to compare what
  somora sees vs what you see in a normal shell;
- you've pointed `CLAUDE_CONFIG_DIR` at a hand-curated config tree
  via `~/.somora/somora.env` and want the agent's tmux children to
  use it too.

```jsonc
// Default: pane behaves like a user-opened terminal.
tmux({ action: "create", name: "shell-1", cwd: "/path/to/project" })

// Opt-in: tmux child shares somora's isolated claude tree.
tmux({ action: "create", name: "claude-debug-1",
       inherit_agent_env: true,
       cwd: "/path/to/project" })
```

The same flag exists on `exec({ inherit_agent_env: true })` for
one-shot commands. Default is `false` on both tools.

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

If you declared `kind: "claude-code"` or `kind: "codex"` on the
session, you rarely need manual ANSI inspection for this anymore:
`tui_state.suggestion_visible` / `suggestion_text` report ghost text
on the input line directly (somora runs the ANSI probe for you), and
`tui_state.state === "queued"` is the structured form of "there's
pending input that hasn't been submitted". Manual `include_ansi`
capture remains the fallback for undeclared sessions or when you
want to inspect the raw styling yourself.

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
  // Present only when the session was created with kind != "shell":
  tui_state: {
    state: "ready",                  // "ready" | "queued" | "running" | "idle_unknown"
    markers: [],                     // marker substrings that matched
  },
}
```

And for `wait_idle`:

```jsonc
{
  action: "wait_idle",
  ok: true,
  target: "local",
  name: "claude-1",
  content: "<final pane snapshot>",
  became_idle: true,                 // for kind != "shell", true only when both
                                     // content-stable AND tui_state.state === "ready"
  ms: 1492,
  tui_state: { state: "ready", markers: [] },   // only when kind != "shell"
}
```

## Cross-references

- `tools.md` — full tool family overview
