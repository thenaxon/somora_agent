# Sentinel

Sentinel wakes an agent on a schedule, so it does work without you
asking. Each wake-up is a normal turn in one of the agent's sessions,
and the answer is a normal chat message you read when you have time.
It is not a notification system: the agent does the work, you read the
result.

## What you get

- **Reminders and routines in plain words.** Say "remind me tomorrow at
  10" or "summarize my mail every morning at 8" and the agent sets the
  trigger itself.
- **Five kinds of schedule**: once, every so often, daily, weekly, or a
  cron expression.
- **Answers where you expect them.** A trigger fires in the session you
  name. A trigger an agent sets on itself comes back to the conversation
  it was set in.
- **Built-in limits.** A trigger that keeps failing or fires too often
  pauses itself.
- **A window to manage them.** List, test, pause, resume and delete
  triggers in the web client.
- **Outage handling.** You decide per trigger whether a fire missed
  while somora was down is caught up.

## Try it

Ask an agent in chat:

```text
Remind me in ten minutes to stretch.
```

The agent calls the `sentinel` tool and creates a one-shot trigger.
Open the **sentinel** tile (the bell) on the web desktop to see it with
its next fire time. Press **test now** to fire it at once. The agent's
answer appears in the session the trigger points to.

## Schedules

Every trigger has the source type `time` and one of five specs:

| `spec.type` | Fields | Example | Fires |
|---|---|---|---|
| `at` | `iso` | `"2030-05-18T10:00:00+02:00"` | Once, at that moment. |
| `every` | `interval` | `"15m"` | At a fixed interval of at least 60 seconds. Units: `ms`, `s`, `m`, `h`. |
| `daily` | `time` | `"08:00"` | Every day at that time. `HH:MM` or `HH:MM:SS`. |
| `weekly` | `day`, `time` | `"mon"`, `"09:00"` | Every week. `day` is `mon`, `tue`, `wed`, `thu`, `fri`, `sat` or `sun`. |
| `cron` | `expression` | `"0 9 1 * *"` | Whenever the five-field cron expression matches. |

`daily`, `weekly` and `cron` use the server's local time. An `every`
trigger first fires one interval after it is created, then keeps to
that rhythm however long each turn takes.

## Creating a trigger

Agents use the `sentinel` tool with the action `create`:

```json
{
  "action": "create",
  "name": "morning-mail-summary",
  "intent": "Check inbox and tell me what's important today",
  "source": {
    "type": "time",
    "spec": { "type": "daily", "time": "08:00" }
  },
  "dispatch": {
    "agent": "<your-agent>",
    "session": "morning-routine",
    "prompt": "Check inbox via the gog skill, group by topic, tell me what's important today."
  },
  "policy": { "cooldownMs": 60000 }
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Label, up to 100 characters. The trigger id is built from it, for example `morning-mail-summary-a7c3`. |
| `intent` | no | What the user wanted, up to 500 characters. Shown to the agent at every fire. |
| `source` | yes | `{ "type": "time", "spec": … }`, see Schedules. |
| `dispatch.agent` | yes | The agent to wake. It must exist. |
| `dispatch.session` | no | The session to fire in, see below. |
| `dispatch.prompt` | yes | The text the agent receives as its message. |
| `policy.cooldownMs` | no | Minimum milliseconds since the last successful fire. An earlier fire is skipped. |
| `policy.maxFiresPerDay` | no | Daily limit for this trigger, 1 to 500. Default 500. |
| `policy.missedFiresPolicy` | no | `skip` (default), `catchUpOnce` or `catchUpAll`, see Missed fires. |

The agent that creates the trigger is its owner. The result carries the
full trigger and a `hint` with the next fire time.

There is no HTTP route for creating. An external client calls the tool
through `POST /agents/:agent/tools/sentinel` with the same body.

## Which session a trigger fires in

| `dispatch.session` | Fires in |
|---|---|
| a slug or id | That session. A slug that does not exist yet is created at the first fire. An exact session id that does not exist is an error. |
| `"main"` | The agent's main session. |
| `"current"` | The session the agent is in while it creates the trigger. Only valid when `dispatch.agent` is the creating agent. |
| left out, trigger on yourself | The session it was created from. The result then carries a `session_note` naming that session. |
| left out, anything else | `main`. This covers a trigger on another agent, one created by a sub-agent, and one created outside any session through the HTTP tool route. |

Leaving the session out means "wake me to go on with this". A sub-agent
is the exception because nobody watches its session once its task is
handed in.

> **Tip:** Name `"main"` explicitly for a recurring job that belongs
> there and not in the conversation the agent happens to be in.

## What the agent receives

A fire is a user-message turn in the target session. It waits in the
session's queue like any other turn, and the Stop button ends it. The
text of the turn is exactly `dispatch.prompt`.

Beside the text, the model sees an evidence block for this one turn:

```text
[Sentinel trigger fired]
trigger_id: morning-mail-summary-a7c3
name: morning-mail-summary
created_by: <your-agent>
source: time (daily 08:00)
fired_at: 2030-05-18T08:00:00.000Z
policy: cooldown 60s
user_intent: Check inbox and tell me what's important today
The prompt below is what this trigger asks of you.
```

The `policy` line appears only with a cooldown, `user_intent` only with
an intent. A catch-up fire adds
`mode: catch-up (server was down at scheduled fire time)`.

The block tells the agent it was woken and not asked by you. It is not
stored as message text, so the agent's memory and recall are built from
the prompt alone. In the session file the row carries the block in its
`ephemeral` field and an `origin` with `kind: "sentinel"`, `triggerId`,
`triggerName` and `taskId`.

The agent then works with whatever tools and skills it has and writes a
normal reply. Clients draw the start of a sentinel turn as a divider,
not as a bubble of yours.

## Managing triggers

All actions of the `sentinel` tool:

| Action | Parameters | What it does |
|---|---|---|
| `create` | `name`, `source`, `dispatch`, optional `intent`, `policy` | Creates a trigger. |
| `list` | optional `owner`, `status`, `include_completed` | Lists triggers, newest first. Fired one-shots are hidden and counted in `hidden_completed`. |
| `get` | `id` | Full detail of one trigger. |
| `pause` | `id` | Stops it from firing. |
| `resume` | `id` | Makes it active again and clears the error count. |
| `delete` | `id` | Removes the trigger and its history. |
| `test` | `id` | Fires now, ignoring cooldown and daily limit. Marked `testMode` in the history. |
| `history` | `id`, optional `limit` (1 to 200, default 50) | The latest fires, newest first. |
| `purge_completed` | optional `owner` | Deletes every fired one-shot. Other triggers are never touched. |

```jsonc
sentinel({ action: "list" })                            // working view
sentinel({ action: "list", include_completed: true })   // with fired one-shots
sentinel({ action: "list", owner: "<your-agent>" })     // one owner
sentinel({ action: "list", status: "paused" })          // one status
sentinel({ action: "get", id: "morning-mail-summary-a7c3" })
sentinel({ action: "history", id: "...", limit: 50 })
sentinel({ action: "test", id: "..." })
sentinel({ action: "purge_completed" })
```

`status` is one of `active`, `paused`, `error` or `completed`.
`status: "completed"` also shows the fired one-shots.

### In the web client

The **sentinel** tile opens a window with two parts:

- **List**: each trigger with status icon, schedule, owner, target
  session, next fire time and fire count. A pause or error reason is
  shown in red.
- **Detail**: schedule, intent, dispatch, policy, stats and the last 50
  fires. Three buttons: **test now**, **pause** or **resume**, and
  **delete**.

## Limits

Agents create triggers without asking for confirmation, but they cannot
get around these limits:

| Limit | Value | What happens |
|---|---|---|
| Minimum interval | 60 s | `create` rejects a shorter `every` interval. |
| Triggers per agent | 50 | `create` fails once the owner has 50 active or paused triggers. Completed and errored ones do not count. |
| Fires per trigger per day | 500, or `policy.maxFiresPerDay` | The trigger pauses with a daily cap reason and resumes by itself when the UTC day rolls over. Skipped fires do not count. |
| Errors in a row | 3 | Status becomes `error`. It stays so until someone resumes it. |

A fire counts as an error when the agent or session cannot be found,
when the turn fails in the engine, or when a person stops the turn.
Fix the cause first, for example an expired login of a command line
tool the prompt relies on, then resume.

## Missed fires

Sentinel runs inside the somora server. When the server was down at a
fire time, the next start decides what happens.

**One-shot `at` triggers** have a fixed grace of 6 hours. Missed by up
to 6 hours, the trigger fires once as a catch-up. Missed by more, it is
marked `completed` with the reason
`stale: server was down past catch-up grace` and does not fire.

**Recurring triggers** follow `policy.missedFiresPolicy`:

| Value | Behaviour | Good for |
|---|---|---|
| `skip` (default) | Nothing is caught up. The next regular fire is scheduled. | A daily inbox check, where stacked fires after an outage are noise. |
| `catchUpOnce` | One catch-up fire, however many were missed. | A monthly summary you do not want to lose. |
| `catchUpAll` | One catch-up fire per missed moment, at most 24. | Log-style triggers where every moment matters. |

A catch-up fire has `catchUp: true` in the history and the `mode` line
in the evidence block, so the agent knows it is late.

```jsonc
{
  "action": "create",
  "name": "monthly-summary",
  "source": { "type": "time", "spec": { "type": "cron", "expression": "0 9 1 * *" } },
  "dispatch": { "agent": "<your-agent>", "session": "main", "prompt": "Write the monthly report." },
  "policy": { "missedFiresPolicy": "catchUpOnce" }
}
```

## Cron expressions

Prefer `daily`, `weekly` and `every` when they fit: they read better.
Use `cron` for the rest, such as monthly jobs or several times a day.

```text
"0 8 * * *"      # daily 8:00
"0 9 1 * *"      # 1st of each month, 9:00
"*/15 * * * *"   # every 15 minutes
"0 9,17 * * *"   # 9:00 and 17:00 daily
"0 0 * * 0"      # Sundays at midnight
```

The five fields are minute, hour, day of month, month, day of week.
Day of week is 0 for Sunday to 6 for Saturday. The parser is small on
purpose:

| Supported | Not supported |
|---|---|
| `*`, a number `N`, a step `*/N`, a list `a,b,c` | Ranges like `1-5` (write `1,2,3,4,5`), names like `MON` or `JAN`, macros like `@daily` or `@hourly` |

When both day of month and day of week are set, the trigger fires when
either one matches.

## Cleanup of fired one-shots

An `at` trigger gets the status `completed` once it has fired. `list`
hides these, `purge_completed` deletes them all, and somora deletes each
one with its history `sentinel.completedRetentionDays` days after its
last fire. The sweep runs at server start and at least once a day.

Recurring triggers never become `completed`. Paused and errored
triggers are never cleaned up automatically: you decide when to delete
them.

## Sentinel and skills

A skill is a set of instructions an agent loads during a turn. A
trigger is what starts the turn. A trigger's prompt can tell the agent
to use a skill, but the trigger is not a skill itself.

Tools like `gog` or `gh` that a prompt relies on are logged in once on
the host. The woken agent runs them like in any other turn. somora does
not hold those logins.

## Settings

In `config.yaml`:

```yaml
sentinel:
  completedRetentionDays: 7
```

| Setting | Default | Meaning |
|---|---|---|
| `sentinel.completedRetentionDays` | `7` | Days a fired one-shot and its history are kept. `0` turns the automatic cleanup off. Allowed: 0 to 3650. |

A change needs a server restart. The limits in the table above are
fixed and not configurable.

## Routes

| Route | What it does |
|---|---|
| `GET /sentinel/triggers` | All triggers, newest first. Optional `?owner=` and `?status=`. Includes completed ones. |
| `GET /sentinel/triggers/:id` | One trigger. |
| `GET /sentinel/triggers/:id/history` | Its fires, newest first. Optional `?limit=`, default 50, at most 200. |
| `POST /sentinel/triggers/:id/pause` | Pause. |
| `POST /sentinel/triggers/:id/resume` | Resume. |
| `POST /sentinel/triggers/:id/test` | Fire now. |
| `DELETE /sentinel/triggers/:id` | Delete trigger and history. |
| `GET /sentinel/status` | `{ started, nextFireAt }` of the scheduler. |
| `POST /agents/:agent/tools/sentinel` | Any tool action, including `create`. |

## Files

```text
~/.somora/sentinel/
  triggers.json                        # all triggers
  history/
    morning-mail-summary-a7c3.jsonl    # one line per fire
```

Each history line has `firedAt`, `scheduledFor` and an `outcome` of
`success`, `error` or `skipped`, plus `error`, `skipReason`, `taskId`,
`catchUp` and `testMode` where they apply. About the last 200 fires per
trigger are kept.

## Troubleshooting

**A trigger did not fire.** Look at its history. A `skipped` entry
names the reason:

| `skipReason` starts with | Meaning |
|---|---|
| `cooldown` | The last successful fire was less than `cooldownMs` ago. |
| `daily_cap` | The daily limit was reached. The trigger is paused until the next UTC day. |
| `concurrency` | Too many background turns were running, for this agent or on the whole server. |
| `removed from the queue by the user` | A person removed the waiting fire before it started. |

**A trigger shows status `error`.** Three fires in a row failed. The
reason line names the last error. Fix the cause and resume.

**A reminder fired in the wrong session.** `get` the trigger and check
`dispatch.session`. Delete it and create it again with the session
named explicitly.

**A trigger was created with no next fire time.** The `at` moment was
already in the past. Delete it and create it with a future time.

**A new setting has no effect.** `sentinel` settings are read at
server start. Restart somora.

## See also

- [Tools](tools.md): the `sentinel` toolset among all agent tools
- [API](api.md): request and response bodies of the sentinel routes
- [Web client](web.md): the desktop and its app tiles
- [Display](display.md): how a sentinel turn looks in the chat
- [Skills](skills.md): instructions a woken agent can load
