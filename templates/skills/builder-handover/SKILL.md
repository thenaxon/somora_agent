---
name: builder-handover
description: Hand a coding task to a builder agent (kind builder) as one complete order with builder_dispatch, let it plan or build in the project's folder, and act on its report — no terminal, no interim controls.
metadata:
  somora:
    when_to_use: When a person wants software built or changed and a builder agent exists in this somora — a new project, a feature, a fix, a refactor — and you are the agent who plans it with the person and hands the implementation over.
    tags: [coding, builder, orchestration, projects]
---
# Handing work to a builder

A builder is a somora agent of kind `builder` (docs/builder.md): a coding
harness inside somora with file tools, a shell, a task list and long
turns. You do not drive it. You give it one complete order, it plans or
builds in the project's folder, and its final answer is the report that
wakes you. Everything between order and report is the builder's.

## 1. Agree the work with the person
- Say back what will be built, what "done" means in observable terms
  (tests green, a command prints X, a page shows Y), and where.
- Small and clear: hand over straight away. Larger or vague: write a plan
  file first, or let the builder plan (step 3) and show the person its plan.
- Do not ask the builder to decide scope for you. Scope is agreed here.

## 2. Prepare the project
- The project exists (`project_get`) and names its folder (`workdir`).
  Create it with `project_create` (`workdir` = the repository folder;
  a folder that does not exist yet is created when the project is pinned)
  or set it with `project_update`.
- Decide the report path (a file inside the repository, e.g.
  `reports/<task>.md`) and, when a plan file exists, its path.

## 3. Which builder, which phase
- One builder in this somora: leave `builder` out; the tool takes it.
- Several: choose by each builder's team description (role, model, what
  it is for). Name it in `builder`. Never split one task between two.
- `phase: "plan"` when the person wants to see the plan before anything
  changes: the builder reads the repository, writes its plan with
  `plan_write`, answers "Plan ready" and stops. You are woken with the
  plan; show it to the person. They press **Go** in the builder's task
  panel (or you send the next message into that session) and the build
  starts; you are woken again with the report.
- No `phase`: the builder builds straight away (the default when the
  plan already exists as a file or the task is small).
- `mode` stays `unattended` unless the person will sit and answer
  questions in the builder's window (`attended` offers it `ask_user`).

## 4. The hand-over — one call
```
builder_dispatch({
  project: "<slug with workdir>",
  task: "<what to build or change, which areas/files, constraints, interfaces>",
  done_criteria: "<observable: npm test green and the CLI prints the new column>",
  report_path: "/abs/path/to/repo/reports/<task>.md",
  plan_path: "/abs/path/to/repo/PLAN.md",     // when a plan file exists
  phase: "plan"                               // when the person wants the plan first
})
```
Fill the order from assets/ORDER.md. The order is complete or it is not
an order: the builder sees nothing of this conversation — files,
interfaces, constraints, verification, what to return. Do not tell the
builder to report back to you, name your session, or "return the plan
via message": its final answer reaches you by itself.

The call returns at once with a `call_id`. `agent_ask_result(call_id)`
reads the outcome any time; the wake comes on its own.

One builder per folder at a time: `builder_dispatch` refuses a folder
another builder is working in ("folder busy: <who>"). Wait for that
report; do not retry in a loop. Orders into different folders may run
side by side, each wakes you separately with the builder's name.

## 5. While the builder works
- Do NOT check in, poll, or send "status?" messages. Do NOT set wake-up
  triggers to look at it. The report is the only checkpoint.
- A correction that cannot wait is ONE message into the builder's
  session (`agent_ask` with that session; it is steered into the running
  turn or queued as the server decides). Everything else waits for the
  report and becomes the next order.
- The builder decides routine implementation choices itself and lists
  them in the report.

## 6. After the report
- Read the report file and the diff (`git status`, `git diff` in the
  folder). Run the verification yourself where it matters (`exec` with
  `cwd` = the folder). The builder's word is a claim, your run is the
  proof the person gets.
- Tell the person in their language what was built, what you verified
  and how, what the builder decided on its own, what is open.
- Accept, or send the next order: a new `builder_dispatch` for a new
  task, or a message into the same session when its context is worth
  keeping. Never edit the builder's work in parallel in the same folder.

## Helpers and colleagues
The builder may spawn helpers of its own kind for sealed sub-tasks and
may consult colleagues with `agent_ask`; both inherit nothing from you.
Do not spawn helpers for it from outside.
