# sentinel — proactive triggers for agents

Sentinel is somora's trigger runtime. It lets an agent be **woken on a
schedule** to do work, instead of waiting for you to ask. The output
of every fire is a chat message in the agent's session — just like
when you ask the agent something directly. You read it when you have
time.

This is not a notification system for you the user. If you want
"BTC dropped below 50k" as a toast, every monitoring tool already does
that. Sentinel is for "your agent saw BTC drop, looked at the news, and
wrote me a brief note about why" — the agent does work, you read its
output.

## Phase 1 scope

Time-based triggers only. Other event sources (HTTP polling, shell
command output) follow in Phase 2.

| Source variant | Example use |
|---|---|
| `at` — single absolute moment | "remind me tomorrow 10:00 to call Luca" |
| `every` — fixed interval (≥ 60s) | "every 15 minutes check open github runs" |
| `daily` — same time each day | "every morning 08:00 summarize my mails" |
| `weekly` — same day-of-week + time each week | "every monday 09:00 review the backlog" |
| `cron` — full 5-field cron escape hatch | "0 8 * * mon-fri" (mon-fri ranges NOT supported — use `weekly` for ranges) |

## How an agent installs a trigger

The agent has access to one tool: `sentinel`. Action `create` shape:

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

When the trigger fires at 08:00, the agent receives a user-message turn
in session `morning-routine` (auto-created with timestamp prefix if
not existing — see the Phase 0 `/spawn-async` fix). The body is the
prompt above, prefixed with a structured **evidence block**:

```text
[Sentinel trigger fired]
trigger_id: morning-mail-summary-a7c3
name: morning-mail-summary
created_by: <your-agent>
source: time (daily 08:00)
fired_at: 2026-05-18T08:00:00.000Z
user_intent: Check inbox and tell me what's important today

---

Check inbox via the gog skill, group by topic, tell me what's important today.
```

The agent reads the header, understands it was woken (not user-asked),
loads its skills, does the work, writes its summary as a normal chat
message. You see it next time you open that agent in the web/mobile UI.

## Listing, pausing, deleting

Same tool:

```jsonc
sentinel({ action: "list" })                              // all triggers
sentinel({ action: "list", owner: "<your-agent>" })             // filter by owner agent
sentinel({ action: "list", status: "paused" })            // filter by status
sentinel({ action: "get", id: "morning-mail-summary-a7c3" })
sentinel({ action: "pause", id: "..." })
sentinel({ action: "resume", id: "..." })
sentinel({ action: "delete", id: "..." })                 // removes trigger + history
sentinel({ action: "history", id: "...", limit: 50 })     // last N fires
sentinel({ action: "test", id: "..." })                   // fire NOW, bypass cooldown/cap
```

## Web-UI sentinel tab

In the desktop web client there's a **Sentinel** app icon (bell glyph)
next to Sessions / Tmux / Terminal. The window shows:

- **List**: every trigger with status icon, schedule, owner, next-fire
  time and fire count. Click to open the detail pane on the right.
- **Detail**: schedule, intent, dispatch config (agent + session +
  prompt), policy, stats, and the last 50 fires with outcome
  (success / error / skipped). Plus four action buttons: **test now**,
  **pause** / **resume**, **delete**.

The "test now" button bypasses cooldown and daily-cap — use it to
verify a freshly-installed trigger does what you expect without
waiting for its real fire time.

## Storage layout

Everything is under `~/.somora/sentinel/`:

```text
~/.somora/sentinel/
  triggers.json                    # all triggers, one JSON file
  history/
    morning-mail-summary-a7c3.jsonl    # JSONL fire history per trigger
    ...
```

Git-friendly when `~/.somora/` is versioned. Human-readable when
debugging.

## Safeguards

These are enforced both at trigger-create time AND in the scheduler
(defense in depth). Agents can install triggers without user
confirmation, but they cannot bypass these limits:

| Limit | Default | Reason |
|---|---|---|
| **Minimum interval** | 60 s | No sub-minute polling possible |
| **Max active triggers per agent** | 50 | Prevents accidental fan-out |
| **Max fires per trigger per day (UTC)** | 500 | Auto-pauses with status `paused` + reason `daily_cap`; auto-resumes when the UTC day rolls over |
| **Auto-pause on consecutive errors** | 3 | Status → `error`, sticky until user resumes |

A **daily-cap** pause is temporary: the scheduler flips the trigger back
to `active` automatically once the UTC day rolls over and its fire count
resets — no manual action needed. An **error** pause is sticky: it stays
paused until you fix the underlying cause (e.g. expired `gog login` for
an exec-source in Phase 2) and click **resume**. Both are visible in the
web-UI with a status icon and the reason.

## Completed-trigger retention (GC)

One-shot `at`-triggers turn into status `completed` once they've
fired. They sit there forever otherwise — useful for an audit trail,
clutter on the long view. Sentinel auto-deletes `completed` triggers
(and their history file) older than a configurable retention window.

Configure in `config.yaml`:

```yaml
sentinel:
  completedRetentionDays: 7   # default; 0 disables auto-cleanup
```

The sweep runs at server boot and on each daily re-arm tick, so a
trigger that completed 8+ days ago will be gone within ~24 hours of
the next boot or daily heartbeat. Manual deletion (`sentinel({
action: "delete", id: "..." })` or the web-UI Delete button) works at
any time and bypasses the retention window.

Recurring triggers (`every` / `daily` / `weekly` / `cron`) never
reach `completed` status under normal operation — they go to
`paused` (manual, or auto via daily-cap which auto-resumes next UTC day)
or `error` (auto-paused after the 3-consecutive-fail streak). Those
don't auto-GC; you choose when to remove them.

## Catch-up policy when somora was down

Sentinel runs in-process with the somora server. If the server is
down when a fire was due, the next-boot logic decides what to do.

### One-shot `at` triggers

A 6-hour grace window applies system-wide:

- Missed by ≤ 6h → fire once with `catchUp: true` in the history.
- Missed by > 6h → mark `completed` with reason "stale: server was
  down past catch-up grace". We miss it cleanly rather than firing a
  day-late "your 10am reminder".

### Recurring triggers — configurable per trigger

For `every` / `daily` / `weekly` / `cron`, the behavior is set via
`policy.missedFiresPolicy` on the trigger:

| Setting | Behavior | Use for |
|---|---|---|
| `skip` (default) | No backfill. Compute next future fire, arm normally. | "Daily inbox check" — stacked fires after an outage are spam. |
| `catchUpOnce` | Fire ONE historical instance with `catchUp:true` in evidence. | "Monthly invoice summary" — you want to know it was missed but only get one fire. |
| `catchUpAll` | Fire one per missed instant (capped at 24). | Log-style triggers where each instant carries unique context. |

Example monthly trigger that survives multi-day outages:

```jsonc
{
  "action": "create",
  "name": "monthly-summary",
  "source": { "type": "time", "spec": { "type": "cron", "expression": "0 9 1 * *" } },
  "dispatch": { "agent": "<your-agent>", "session": "main", "prompt": "Erstelle den monatsbericht." },
  "policy": { "missedFiresPolicy": "catchUpOnce" }
}
```

If somora was offline on the 1st at 9am, the next boot detects the
missed fire and dispatches it with `catchUp:true` so the agent knows the
fire is delayed.

## Cron syntax (the escape hatch)

90% of recurring use-cases fit `daily` / `weekly` / `every` —
prefer those when they do; they read better. For the remaining 10%
(monthly recurring, multi-time-per-day) use `cron`:

```
"0 8 * * *"      # daily 8:00
"0 9 1 * *"      # 1st of each month, 9:00
"*/15 * * * *"   # every 15 min
"0 9,17 * * *"   # 9:00 AND 17:00 daily
"0 0 * * 0"      # sundays midnight
```

Standard 5-field cron (minute hour day-of-month month day-of-week).
Sentinel's parser is intentionally minimal:

- Supports: `*`, `N`, `*/N`, `a,b,c` (comma-list)
- Does NOT support: ranges `1-5` (use `1,2,3,4,5`), named months
  `MON` / `JAN` (use numbers), `@daily` / `@hourly` macros

Day-of-week is 0=Sun...6=Sat (Vixie convention).

## What the agent receives

Every fire is delivered to the dispatched agent as a **user-message
turn** through `/spawn-async`. The agent's session JSONL records it
exactly like a real user message. From the agent's perspective:

- A turn arrives with the structured evidence block at the top.
- It can use any skill it has access to (`gog`, `gh`, `web_fetch`, …).
- It writes its response. The response is a normal assistant message
  in the session, visible next time you open the chat.
- The chat history mixes sentinel-triggered turns and your direct
  questions seamlessly. The evidence-block prefix is what
  distinguishes them.

## Comparison with skills

Skills are markdown instruction-bundles an agent loads at runtime
during a conversation. Sentinel triggers are scheduled entry points
for that conversation. A trigger can tell the agent to load a skill
— but the trigger itself is not a skill. They sit at different
layers:

```text
user/sentinel → opens a turn for agent → agent loads skills as needed → tools execute
```

## Coming in Phase 2 (not in v2026.05.17.xx)

- `http_json` source — fetch a URL on interval, evaluate JSON
- `exec` source — run a shell command (gog, gh, curl, …), evaluate
  stdout / exit code
- `expression` evaluator — `value < 50000`, regex matching
- `rising_edge` policy — fire only on the value transition

The integration model for Phase 2 is intentionally CLI-tool-based: you
authenticate `gog` / `gh` / `aws-cli` / etc. once on the host, and
sentinel uses `exec` to run them. somora doesn't own your OAuth.
