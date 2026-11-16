# Recorded coding-agent screens

Real screens of Claude Code, Codex, OpenCode and Pi in tmux, each with the
state a person reading it would give it. The test corpus for tmux state
detection: `src/tmux/corpus.test.mts` runs the detector over it.

Per case: `<case>.txt` (`capture-pane -p -S -300`), `<case>.ansi` (the same
with `-e`), `<case>.json` (agent, case, expected state, note, pane title,
foreground command, width, height). User, host and server names are
replaced by placeholders of the same length, so the layout is unchanged.

Recorded 2026-11-16: Claude Code 2.1.325 (Haiku 5.5), Codex 0.169 (GPT-6
Luna), OpenCode 1.19.5 and Pi 1.5.2 (both on a local DeepSeek V4.1).

States: `idle` (ready for input), `working`, `blocked` (an approval,
question or startup dialog waits for an answer).

| Agent | Case | Expected | Size | Note |
|---|---|---|---|---|
| claude | `after-abort` | idle | 120×40 | Escape stopped the essay; the queued message then ran and finished |
| claude | `blocked-permission` | blocked | 120×40 | Bash permission dialog (Yes / always / auto mode / No) |
| claude | `blocked-question` | blocked | 120×40 | AskUserQuestion dialog with options |
| claude | `blocked-startup-trust` | blocked | 120×40 | startup dialog: trust this folder? |
| claude | `done-after-task` | idle | 120×40 | question answered, turn finished |
| claude | `idle-background-shell` | idle | 120×40 | turn ended, the Bash command keeps running in the background ("1 shell still running") |
| claude | `idle-ghost-suggestion` | idle | 120×40 | turn ended, dim suggestion "! sleep 25; echo FG" in the input line (not real input) |
| claude | `narrow-working` | working | 64×30 | 64 columns, model streaming an answer |
| claude | `startup-idle` | idle | 120×40 | home screen after trust, auto mode, empty prompt |
| claude | `typed-not-submitted` | idle | 120×40 | text typed, Enter not pressed |
| claude | `working-with-queued` | working | 120×40 | second message sent while writing |
| claude | `working-writing` | working | 120×40 | model streaming a long answer |
| codex | `after-abort` | idle | 120×40 | Escape while working; the typed text is still in the input |
| codex | `blocked-approval` | blocked | 120×40 | command approval dialog (Yes / don't ask again / No) |
| codex | `blocked-startup-daemon` | blocked | 120×40 | startup dialog: background server has incompatible settings (choose 1/2/3) |
| codex | `blocked-startup-trust` | blocked | 120×40 | startup dialog: trust this folder? |
| codex | `done-after-task` | idle | 120×40 | turn finished, answer on screen |
| codex | `narrow-done` | idle | 64×30 | 64 columns, answer finished |
| codex | `narrow-working` | working | 64×30 | 64 columns, shell command running |
| codex | `startup-idle` | idle | 120×40 | home screen after trust, empty prompt |
| codex | `typed-not-submitted` | idle | 120×40 | text typed, Enter not pressed |
| codex | `working-tool` | working | 120×40 | shell command running (sleep 30) |
| codex | `working-with-queued` | working | 120×40 | text typed + Enter while working: NOT queued, stays in input ("tab to queue message") |
| opencode | `abort-first-escape` | working | 120×40 | one Escape pressed: OpenCode asks for a second one |
| opencode | `after-abort` | idle | 120×40 | two Escapes, turn interrupted |
| opencode | `after-reject` | working | 120×40 | permission rejected, model still answering |
| opencode | `blocked-permission` | blocked | 120×40 | external directory permission dialog (Allow once / Allow always / Reject) |
| opencode | `blocked-question` | blocked | 120×40 | question tool with options (select/submit/dismiss) |
| opencode | `done-after-task` | idle | 120×40 | turn finished, answer on screen |
| opencode | `narrow-working` | working | 64×30 | 64 columns wide, bash tool running |
| opencode | `startup-idle` | idle | 120×40 | home screen, empty prompt |
| opencode | `typed-not-submitted` | idle | 120×40 | home screen, text typed, Enter not pressed |
| opencode | `working-tool` | working | 120×40 | bash tool running (sleep 30) |
| opencode | `working-with-queued` | working | 120×40 | second message sent while working |
| pi | `after-abort` | idle | 120×40 | Escape pressed while working |
| pi | `done-after-task` | idle | 120×40 | task finished, answer on screen |
| pi | `narrow-done` | idle | 64×30 | 64 columns, task finished |
| pi | `narrow-working` | working | 64×30 | 64 columns wide, bash tool running |
| pi | `startup-idle` | idle | 120×40 | fresh start, empty prompt, extended-keys warning on top |
| pi | `typed-not-submitted` | idle | 120×40 | text typed in the editor, Enter not pressed |
| pi | `working-tool` | working | 120×40 | bash tool running (sleep 30) |
| pi | `working-with-queued` | working | 120×40 | second message sent while the bash tool runs |
