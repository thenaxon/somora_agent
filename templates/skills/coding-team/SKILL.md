---
name: coding-team
description: Coordinate several coding agents (Claude Code, Codex, OpenCode, Pi, …) in tmux sessions as one team — roles with their own files, one task at a time per agent, a fixed status report, the coordinator reviews and commits.
metadata:
  somora:
    when_to_use: When a person wants a larger piece of software built or changed by several coding agents working in parallel in terminals, and you plan, hand out the work and put the results together.
    tags: [coding, orchestration, tmux, team]
---
# Coordinating a team of coding agents

You plan and coordinate; the coding agents in tmux sessions write the
code. Each agent has a role and files of its own, gets one task at a
time and ends every task with a short status. You check, decide and
commit. The `tmux` tool does the terminal work: `start`, `prompt`,
`read`, `wait_idle`, `list`.

## 1. Agree the work with the person
- Say back what will be built and what "done" means in observable terms
  (tests green, a command prints X, a page shows Y), and where.
- Agree the team: which agents (and models) take which role. Default
  when the person does not care: one agent per area of the code, plus a
  reviewer that writes no product code.

## 2. Put the rules in the project
- Copy `assets/AGENTS.md` from this skill to the project root and fill
  it in: the project in one line, the roles with the folders each may
  change, the shared files only you change, the checks that must pass.
- Write the plan (`docs/PLAN.md`): parts, interfaces between them, the
  order of the milestones. The agents read both before every task.
- Create the shared interfaces (types, API contracts) yourself first.
  Two agents guessing the same interface is the most common breakage.
- Keep your own working files (check scripts, notes, downloads) outside
  the project folder: agents tidy up `.scratch/` and take them with it.

## 3. Start the team
One session per agent, named after its role:

```
tmux({ action: "start", name: "frontend", cwd: "<project>", command: "opencode --model <provider>/<model>" })
tmux({ action: "start", name: "review", cwd: "<project>", command: "codex" })
```

- `start` returns when the agent is ready. `agent_not_ready` with state
  `blocked` means it stopped at a dialog (trust this folder, a login):
  read `content`, answer with `send` or ask the person.
- `list` shows every session with its agent and state.

## 4. Hand out one task at a time
- One `prompt` per task, complete in itself: the role, the files to
  touch, what done means, the checks to run, and the status format.
  Point at `AGENTS.md` and `docs/PLAN.md` instead of repeating them.
- Independent tasks run in parallel: `prompt` with `wait: false` to
  several agents, then `wait_idle` on each, or end your turn — somora
  wakes you when an agent finishes or stops at a dialog. While you are
  busy, every tmux result lists `waiting_for_you`: the sessions that
  finished or need an answer meanwhile.
- A new task in a fresh conversation: `new_conversation` first (it
  sends the agent's own `/new` or `/clear` and answers Codex's worktree
  question). Old context from a finished task leads agents astray.
- `list` shows how long each agent has been working (`working_for_s`):
  one far longer than the others is likely stuck — read it, and give a
  narrower task or interrupt it.

## 5. Read the status and decide
- `read` the session. Every agent ends with:
  `STATUS: done | blocked`, `CHANGED: <files>`, `OPEN: <questions>`.
  No status block means the turn stopped half-way (an error, a model
  that printed its tool call as text): tell it to continue where it
  stopped.
- Check what it says: run the checks yourself, look at the diff of the
  changed files. A report is a claim, the diff is the fact. While other
  roles are still editing, run only the tests of the finished role's
  paths: their half-done tests can hang a full run.
- `blocked` or open questions: answer, change the plan, or ask the
  person. A request for a change outside the agent's files is yours to
  decide — make it yourself or hand it to the owning role.
- Give the review role the diff of a finished milestone; it reports
  findings into `docs/reviews/`, it does not change product code.

## 6. Dialogs and errors
- `blocked`: read the dialog first. Approve only what you understand
  and what the task needs; ask the person otherwise. Answer with `send`
  (`key: "Enter"`, `key: "Down"`, `keys: "1"`); its result shows the
  agent's state right after. Rejecting in OpenCode ends its whole turn:
  follow up with a prompt that says why and what to do instead.
- `agent_busy`: the agent still works — wait, do not type into it.
- `agent_prompt_stalled`: capture before sending again; never send a
  task twice blindly.
- An agent that drifts (edits foreign files, loops on the same error):
  interrupt with `send` `key: "Escape"`, say what went wrong, or start
  it fresh with a narrower task.

## 7. Let the person try it
- For a person to test, build the last commit into a folder of its own
  (`git archive HEAD` or a worktree) and serve that on a port of its
  own. The dev server shows the half-edited working tree.
- Check it yourself in the `browser` tool first when this somora lets
  the browser open `localhost` (`browser.allowPrivate`); otherwise a
  headless browser from the shell does.

## 8. Commit and report
- Only you commit, after the checks pass, one commit per finished task
  or milestone with a message that says what changed.
- Tell the person what is done, what is open and what you decided on
  the way. Kill the sessions you no longer need.

## Rules
- One role per session, one task per prompt, the status format always.
- Never two agents on the same files at the same time.
- Agents do not commit, do not touch shared interfaces, and keep scratch
  files inside the project (`.scratch/`), never in `/tmp`.
- You do not write the product code of a role yourself while that role
  is busy — it would collide with the agent's work.
