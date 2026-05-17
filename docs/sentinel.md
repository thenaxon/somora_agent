# sentinel — proactive triggers for agents

Sentinel is somora's trigger runtime. It lets an agent be **woken on a
schedule** to do work, instead of waiting for you to ask. The output
of every fire is a chat message in the agent's session — just like
when you ask the agent something directly. You read it when you have
time.

This is not a notification system for you the user. If you want
"BTC dropped below 50k" as a toast, every monitoring tool already does
that. Sentinel is for "Hans saw BTC drop, looked at the news, and
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
    "agent": "jarvis",
    "session": "morning-routine",
    "prompt": "Check inbox via the gog skill, group by topic, tell me what's important today."
  },
  "policy": { "cooldownMs": 60000 }
}
```

When the trigger fires at 08:00, jarvis receives a user-message turn
in session `morning-routine` (auto-created with timestamp prefix if
not existing — see the Phase 0 `/spawn-async` fix). The body is the
prompt above, prefixed with a structured **evidence block**:

```text
[Sentinel trigger fired]
trigger_id: morning-mail-summary-a7c3
name: morning-mail-summary
created_by: jarvis
source: time (daily 08:00)
fired_at: 2026-05-18T08:00:00.000Z
user_intent: Check inbox and tell me what's important today

---

Check inbox via the gog skill, group by topic, tell me what's important today.
```

The agent reads the header, understands it was woken (not user-asked),
loads its skills, does the work, writes its summary as a normal chat
message. You see it next time you open jarvis in the web/mobile UI.

## Listing, pausing, deleting

Same tool:

```jsonc
sentinel({ action: "list" })                              // all triggers
sentinel({ action: "list", owner: "jarvis" })             // filter by owner agent
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
| **Max fires per trigger per day (UTC)** | 500 | Auto-pauses with status `paused` + reason `daily_cap` |
| **Auto-pause on consecutive errors** | 3 | Status → `error`, sticky until user resumes |

When a trigger hits an auto-pause condition, it's visible in the web-UI
with a red status icon and the reason — fix the underlying cause
(e.g. expired `gog login` for an exec-source in Phase 2), then click
**resume**.

## Catch-up policy when somora was down

Sentinel runs in-process with the somora server. If the server is
down when a fire was due, the next-boot logic decides what to do:

- **One-shot `at` triggers** that missed their moment within 6 hours
  → fire once with `catchUp: true` in the history. Beyond 6 hours →
  mark `completed` with reason "stale: server was down past catch-up
  grace" (we miss it cleanly rather than firing a day-late
  "your 10am reminder").
- **Recurring triggers** (`every` / `daily` / `weekly` / `cron`)
  → don't backfill. Compute the next future fire from the spec.
  Firing five "you have new mail" pings because somora was down for
  an hour is worse than firing zero.

The 6-hour grace and recurring-skip rule keep agents from getting
woken up with a confusing pile of stale work.

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
