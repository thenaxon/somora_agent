# A2A — Architektur-Skizze (Stand 2026-05-03 abend)

Working draft nach Brain-Dump + Klärungs-Runde. Design-Entscheidungen
A–E sind alle ✓ vom User abgesegnet, was implementations-seitig noch
offen ist steht am Ende.

## Grundprinzip

**Subagents in somora SIND somora-Agents.** Kein eigener „Subagent-
Persona-Typ". Wenn agent-a agent-b spawnt, läuft agent-b als agent-b — mit ihrer
realen Persona, ihrer Memory, ihrer Engine, ihrer Config. Nur in einer
neuen Session.

Damit bleibt die ganze Persona-/Memory-/Dream-/Resource-Schicht
unangetastet.

## Zwei Modi (technisch klar getrennt)

### Modus 1 — Subagent-Dispatch (sealed task)

agent-a → spawnt Sub → Sub-Session läuft → Sub liefert Final-Result → an
agent-a zurück. Klassische delegate-pattern.

**Tool-Surface:**

```ts
spawn_subagent({
  persona?: 'agent-b',          // omit → clone of caller (agent-a-Klon)
  model?: 'opus',            // omit → persona default
  task: '...',               // the prompt for the sub
  wait?: true,               // default true: block; false → returns task_id
})
  → { result, session_slug, agent, ms }      // wait:true
  → { task_id }                                // wait:false

spawn_subagents({
  tasks: [{persona, model?, task}, ...]      // parallel batch
})
  → { results: [{ persona, result, session_slug, ms, error? }] }

subagent_status({ task_id })   // for wait:false flow
subagent_result({ task_id })   // fetch when status='done'
```

**Session-Lifecycle (Decisions A + B):**
- Sub bekommt frische Session in der Sub-Persona's Session-Dir
- Slug-Prefix:
  - Named persona → `sub-<parent-agent>-<YYYYMMDD-HHMMSS>` (z.B. `sub-agent-a-20260503-203045` in agent-b/sessions/)
  - agent-a-Klon → `sub-self-<YYYYMMDD-HHMMSS>` (in agent-a/sessions/)
- Sichtbar in `/sessions` der Sub-Persona mit Marker im Meta-File:
  ```json
  {
    "spawn": {
      "kind": "sub" | "self-sub",
      "parent_agent": "agent-a",
      "parent_session": "main",
      "task_summary": "first ~200 chars"
    }
  }
  ```
- TUI-Listing zeigt Marker, z.B. `* sub-agent-a-... ↳ spawned by agent-a/main`

**Dream + Memory (Decision E):**
- Sub-Sessions durchlaufen normalen Dream-Loop der Sub-Persona
- agent-a-Klon-Subs gehören in agent-a' Dream-Pool
- agent-b-Subs gehören in agent-bs Dream-Pool
- Auto-Inject läuft pro Sub-Turn normal — Sub kennt agent-bs/agent-a' Memory
- Sub-Sessions sind in der normalen `memory_search`-Hit-Surface

**Recursion + Concurrency:**
- TurnInput erhält `subagent_depth?: number` (default 0)
- spawn_subagent inkrementiert depth → Refuse bei depth > 3 (configurable)
- Per-agent + globaler Concurrency-Cap (default: 4 per agent, 16 global)

**Cancellation:**
- AbortSignal propagiert Parent → Sub
- User abort'd agent-a' Turn → alle laufenden Subs kriegen abort
- Result-Stream zu agent-a wird verworfen

**Engine-Wahl:**
- Sub default'd auf Persona-Modell (z.B. agent-bs default = sonnet)
- Mit `model:` explizit override
- Cross-engine OK: agent-a-auf-opus spawnt agent-b-auf-gpt55, beide normal

### Modus 2 — Direkte A2A-Konversation (live messaging)

agent-a → schreibt Frage AS AGENT-A in agent-bs main → agent-b antwortet → agent-a
liest. Beide Seiten sichtbar in agent-bs main wenn User später öffnet.

**Tool-Surface:**

```ts
agent_ask({
  agent: 'agent-b',
  message: '...',
})
  → { response, ms }   // agent-b's Antwort verbatim (Decision C)
```

**Storage-Erweiterung (gebaut 2026-05-05):**

```ts
// src/types/events.ts
| {
    kind: 'user_message';
    ts: number;
    engine: string;
    text: string;
    from_agent?: string;            // when set → A2A inbound
    agent_ask_call_id?: string;     // correlation UUID, MVP nur Logging
  }
```

- `from_agent: undefined` → menschlicher User (default, unchanged)
- `from_agent: 'agent-a'` → agent-a hat in diese Session geschrieben
- `agent_ask_call_id` → UUID pro agent_ask-Round-Trip. **MVP-Nutzung
  beschränkt auf Log-Korrelation** (siehe FUTURE-Sektion unten).

**SSE-Wire-Erweiterung:** neuer `event: 'user_message'` mit
`{ text, from_agent, agent_ask_call_id? }` wird gepublished WENN
fromAgent gesetzt ist. Self-typed User-Turns kommen weiterhin nicht
über die Wire — die TUI echo't lokal beim Submit. Das gibt einem
Menschen der gerade agent-bs Session offen hat live-Sicht auf agent-a'
A2A-Anfrage (rendert mit `↬ agent-a` Cyan-Tag statt user-Icon).

**TUI-Rendering:**
- Wenn ein User-Message ein `from_agent` hat: Icon des Senders statt
  User-Icon, plus dezenter Marker („agent-to-agent")
- Im agent-a-Stream während des Vorgangs: Tool-Call wie sonst, aber mit
  speziellem Format `▸ agent_ask · agent-b: was weißt du über Rene` und
  Result `↳ agent-b: …`

**Lock-Semantik (Decision: Queue mit User-Priorität, gelocked 2026-05-05):**
- Per-Session-Lock in `src/server/session-queue.ts` mit zwei Priority-
  Klassen: `user` (POST /chat/send ohne from_agent) und `agent` (alles
  mit from_agent — also agent_ask + spawn_subagent's chat/send-sync-Pfad).
- User-Entries werden vor wartende agent-Entries einsortiert (FIFO
  innerhalb jeder Klasse). Variante b aus der Diskussion 2026-05-05:
  laufende User-Turns werden NICHT preemptet, aber neu eintreffende
  User-Turns überholen alle wartenden A2A-Turns.
- In-Memory Map<`<agent>/<session>`, SessionLock>. Server-Restart
  verwirft die Queue (waiters bekommen AbortError); persistent queue
  ist ein FUTURE-Item, MVP nicht nötig.
- AbortSignal für Queue-Cancellation: wenn der Caller (z.B. agent_ask
  mit Timeout) abort'd, wird der Waiter aus der Queue gespliced, der
  Slot bleibt frei.
- **Warum Queue statt fail-fast:** OpenClaw-Erfahrung — fail-fast bei
  „busy" macht Multi-Agent-Workflows sehr fragile, weil Agents ständig
  Retry-Code schreiben müssen. Mit Queue bleibt die Logik linear, der
  User wird nie verzögert (Priorität schützt), und A2A-Calls warten
  einfach geduldig oder hitten ihren Timeout (→ pending).
- **Was wir NICHT haben:** Deadlock-Detection. Wenn agent-a agent_ask agent-b
  callt während agent-b parallel agent_ask agent-a callt, hängen beide
  Locks bis zu ihrem timeout_ms. Theoretisches Problem, in der Praxis
  durch 30min-Cap eh begrenzt; richtige Lösung (Cycle-Detection im
  Lock-Graph) wäre FUTURE wenn das real wird.

**Memory + Dream (Decision E):**
- agent-bs Auto-Inject läuft normal beim agent_ask-Turn — sie hat vollen
  Context
- Der Turn ist in agent-b/main JSONL → wird im normalen Dream-Cycle
  abgegrast → wenn agent-a ihr was wichtiges erzählt fließt das in agent-bs
  Memory ein

**Persona-Conflicts (Decision D):**
- Wenn agent-bs Persona die Anfrage ablehnt: Refusal kommt als Antwort,
  agent-a muss damit umgehen (genau wie wenn ein menschlicher User mit
  einer Refusal konfrontiert wird)
- Kein Sondermechanismus, kein Override — Personas sind Personas

**Refused-Topics (offen, später diskutieren):**
- Soll es ein agent.yaml `agent_ask.deny_from: [agent-a]` geben? Würde
  agent-b erlauben Anfragen von agent-a grundsätzlich abzulehnen.
- Erstmal: nicht bauen. Wenn das Bedürfnis aufkommt, addieren.

## Tool-Familie zusammengefasst

| Tool | Zweck | Mode |
|---|---|---|
| `spawn_subagent` | sealed task in fresh session | 1 (single) |
| `spawn_subagents` | parallel batch dispatch | 1 (batch) |
| `subagent_status` | poll wait:false task | 1 (async) |
| `subagent_result` | fetch wait:false result | 1 (async) |
| `agent_ask` | live message into other agent's main | 2 |

`agent_list` brauchen wir nicht als Tool — die Info kommt eh über
`/agents` HTTP-Endpoint und ist im Self-Pointer-Block schon teilweise
sichtbar.

## Engine-Pipeline-Änderungen (welche Files)

Minimal-invasiv:

1. **`src/types/events.ts`** — `from_agent?: string` zu user_message
2. **`src/engine/types.ts`** — `TurnInput` bekommt `fromAgent?: string`
   und `subagentDepth?: number`
3. **3 Engine-Adapter** — `fromAgent` durchreichen (im prompt-build:
   user-message-Block kriegt einen Header „from agent: agent-a" damit das
   Modell weiß wer schreibt)
4. **`src/server/index.ts`** — `chat/send` erweitert um optionales
   `from_agent` field; spawnSubagent + agent_ask Tool-Implementations
5. **`src/storage/sessions.ts`** — Replay-aware für `from_agent`
   (wenn anderer Engine resumed wird und User-Messages mit from_agent
   im JSONL stehen, müssen die im Markdown-Replay sinnvoll dargestellt
   werden, z.B. als „agent-a wrote: ...")
6. **`src/cli/tui/types.ts` + `turn-views.tsx`** — UserTurn rendert
   from_agent mit Sender-Icon
7. **Neue Tool-Module** — `src/tools/agents/{spawn.ts, ask.ts, tools.ts}`
8. **`src/persona/loader.ts` + Self-Pointer** — Self-Pointer-Block
   ergänzt um `subagent_depth` info wenn in Sub-Kontext

## Implementations-Reihenfolge (Vorschlag)

Konkretes Build-Plan, in Phase 6a/6b/6c teilbar:

**6a — Foundation (Storage + Engine + Self-Pointer):**
- NormalizedEvent + TurnInput erweitern
- Engine-Adapter durchreichen
- Self-Pointer im Sub-Kontext: „You are agent-b, spawned by agent-a on
  task: <task_summary>. Your conversation here will be saved to your
  own memory."
- Sub-Session-Meta mit `spawn`-Block

**6b — Modus 1 (spawn_subagent + spawn_subagents):**
- Tool-Implementation mit sync (wait:true) Default
- Recursion + Concurrency-Caps
- Cancellation
- TUI-Rendering der Spawn-Tool-Calls

**6c — Modus 2 (agent_ask):** ✅ DONE 2026-05-05
- from_agent in user_message ✓ (war schon in Phase 6a drin)
- agent_ask_call_id auf user_message ✓ (FUTURE-async-Pfad vorbereitet)
- Tool-Implementation mit Pending-Pattern statt fail-fast (DECISION
  #37 + #39 angewendet)
- Per-Session-Lock mit User-Priority-Queue (Variante b) statt fail-fast
- TUI-Sender-Icon-Rendering (`↬ agent-a` Cyan-Tag) ✓
- Live-SSE für from_agent user_messages ✓
- 5min default / 30min cap aus longTask-Politik (DECISION #39)

**6d — wait:false async pattern (subagent_status/result):**
- Task-Storage in `~/.somora/agents/<agent>/tasks/<id>.json`
- Polling-Tools
- Optional: post hoc, nicht zwingend für MVP

## FUTURE — agent_ask Async-Pfad (`agent_ask_result`)

**Status:** designed, nicht gebaut. `agent_ask_call_id` ist heute schon
auf der user_message persistiert + im Tool-Result returned, damit der
spätere Bau drop-in geht.

**Motivation:** agent_ask ist heute synchron-blockierend. Wenn agent-a
mit `timeout_ms=300000` (5 min) ruft und agent-b-on-gemma 12 Min braucht,
returned agent-a nach 5 Min mit `state:"pending"` + `call_id`. agent-b läuft
dann noch 7 Min weiter, ihre Antwort landet in ihrem JSONL — aber agent-a
hat keinen programmatischen Zugriff darauf.

**Bauplan wenn Bedarf:**

1. `src/server/agent-ask-store.ts` — In-Memory-Map `<call_id,
   { target_agent, target_session, state, response?, started_at,
   completed_at? }>`. Persistierung nach JSONL nicht nötig: bei
   Server-Restart kann der Caller seinen Call eh nicht mehr abrufen,
   die Antwort steht aber im agent-b-JSONL und ist via `/chat/history`
   filterbar.

2. `runChatTurn` schreibt nach completion das Result in den Store
   keyed by `agent_ask_call_id` (wenn gesetzt). State-Übergänge:
   `pending → done | failed`.

3. Neues Tool `agent_ask_result({call_id, wait_until_done?, timeout_ms?})`
   analog zu `subagent_result`. Liest aus dem Store, mit dem gleichen
   Pending-Pattern + `wait_until_done`-Block-Mechanik.

4. Bei `agent_ask` Timeout-Pfad (heute): returnen `state:"pending"`
   + `call_id` + Hint, Caller weiß dass `agent_ask_result(call_id)`
   später kommt.

**Warum das nicht im MVP:** Komplexität-Hub für eine Use-Case die
heute nicht akut ist. Der MVP-Pfad „Timeout → Antwort liegt in agent-bs
Session, manuell sichtbar" reicht für 95% der Fälle. Wenn das real
zum Schmerz wird, ein-Tag-Bau.

## Was DEFERRED ist

- Read-only-Resources mit `agent_ask.deny_from` (siehe oben)
- Modus 3 (tmux-orchestrierte CLI-Sessions) → gehört zur exec-Phase,
  wird mit `tmux_*`-Tool-Familie gebaut neben `exec`
- Sub-Session-Cost-Accounting (wer „bezahlt" Tokens) — first machen,
  dann optimieren
- Cross-agent Memory-„private"-Marker (agent-a soll agent-b was sagen können
  das im agent-b-Memory NICHT für andere Agents sichtbar ist) — erstmal
  alle Memory ist global lesbar (das ist Status quo)

## Phase 6c gebaut (2026-05-05)

**Files:**

- `src/server/session-queue.ts` — neue Datei, per-Session-Lock mit
  Priority-Queue (user > agent), AbortSignal-aware
- `src/tools/agents/ask.ts` — neue Datei, `agent_ask` Tool mit
  Pending-Pattern + UUID-call_id + 5min/30min Timeout via
  `longTaskDefault/MaxMs()`
- `src/tools/agents/index.ts` — agent_ask in den agentTools-Bundle
- `src/types/events.ts` — `agent_ask_call_id?` auf user_message,
  neuer SSE `user_message`-Event für A2A inbound live
- `src/server/run-turn.ts` — `agentAskCallId` plumb-through, publishSse
  emittiert user_message-Event wenn fromAgent gesetzt
- `src/server/index.ts` — `/chat/send` und `/chat/send-sync` acquiren
  Session-Lock mit Priority basierend auf fromAgent. Plus agent_ask_call_id
  Body-Param. Plus publishSse auch in send-sync (live für TUI-User).
- `src/cli/tui/types.ts` — `fromAgent?` auf user-Turn, neuer
  `user-message`-StreamEvent
- `src/cli/tui/stream.ts` — parseFrame versteht `user_message`-Event
- `src/cli/tui/app.tsx` — applyEvent appended user-Turn mit fromAgent
- `src/cli/tui/turn-views.tsx` — UserTurn rendert `↬ agent-a` Cyan-Tag
  bei fromAgent statt grünem `user`-Tag

**Was nicht gebaut:**

- `agent_ask_result(call_id)` — siehe FUTURE-Sektion oben
- Persistente Queue mit Crash-Recovery — MVP nur In-Memory
- Deadlock-Detection bei A2A-Cycles — theoretisch, durch 30min-Cap eh
  begrenzt
- History-Replay im TUI bei Session-Open — pre-existierende Lücke,
  unabhängig von 6c. Live-SSE-Pfad funktioniert; bei Session-Open ohne
  Live-agent-a-Anruf sieht User agent-a's Frage erst beim Refresh

## Implementations-Details (alle ✓ gelocked 2026-05-03)

1. **`from_agent` ans Modell:** Header-Prepend in der user-message:
   ```
   [Message from agent agent-a]
   was weißt du über Rene?
   ```
   Kein cache-bust am System-Prompt, Modell parst Header natürlich.
2. **Sub-Session-Slug bei Same-Second-Spawn:** Millisekunden-Auflösung
   im Suffix:
   ```
   sub-agent-a-20260503-203045-127
   sub-agent-a-20260503-203045-129
   ```
   Stateless, deterministisch sortierbar.
3. **Multi-Spawn TUI:** wie ein normaler Tool-Call gerendert.
   ```
   ▸ spawn_subagents · 3 tasks (agent-b, agent-c, agent-a-clone)
   [Spinner während alle laufen]
   ↳ 3 results · agent-b 2.3s / agent-c 1.8s / agent-a-clone 4.1s
   ```
   Verbose-Mode zeigt darunter den vollen Output. Per-sub-live-status
   wäre Polish, MVP-mäßig OK so.
4. **Cost-Tracking:** Jeder Agent owned seine eigenen Tokens.
   agent-b-Sub-Session-Stats sind agent-bs. agent-a' Turn-Ende zeigt nur agent-a'
   Tokens (inkl. der paar K für den Tool-Call). Wenn später Aggregation
   gebaut wird, kann „spawned by"-Filter ergänzt werden.
5. **Sub-Session-Retention:** Keep forever, manuell archivieren via
   /reset. Marker `↳ sub from agent-a/main` im /sessions-Listing macht
   sie unterscheidbar. Wenn sich Sammelsucht zeigt, Polish-Phase mit
   `/sessions filter:own` o.ä.
