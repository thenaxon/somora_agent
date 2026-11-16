# AGENTS.md — rules for every agent in this project

Project: **<name>** — <one line: what it is>.
The plan and the interfaces are in `docs/PLAN.md`. Read it before every task.

## Roles and what each may change

| Role (tmux session) | Agent | May change |
|---|---|---|
| coordination | <coordinating agent> | `docs/`, `AGENTS.md`, `<shared interfaces>` |
| <role 1> | <agent and model> | `<folders>` |
| <role 2> | <agent and model> | `<folders>` |
| review | <agent> | `docs/reviews/` only, no product code |

## Rules

1. Change only the files of your role. Need a change elsewhere — above
   all in `<shared interfaces>` — say so in your status; the coordinator
   decides.
2. `<shared interfaces>` is the contract between the parts. Do not change
   it on your own.
3. Before you report done: `<check command>` and `<test command>` pass.
4. No git commits. The coordinator commits.
5. Scratch files only in `.scratch/` inside the project (git ignores it),
   never in `/tmp` or elsewhere. Delete only your own files there.
6. Visual changes: check them yourself (a screenshot you look at) before
   you report done.
7. End every task with exactly this:

   ```
   STATUS: done | blocked
   CHANGED: <files>
   OPEN: <questions, or none>
   ```

## Stack

<languages, frameworks, test tools, how to run it>
