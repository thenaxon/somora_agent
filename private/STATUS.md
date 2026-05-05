# somora — Status & Pickup-Point

Lebende Notiz für nahtlosen Wiedereinstieg in zukünftige Sessions.

---

## Wo wir stehen (Stand: 2026-05-05 abend — Phase 6c agent_ask live, A2A komplett validiert)

**HEAD: 3335f0b** auf main. Zwei Commits heute:
- `8ada555` — phase 6c-prep: long-task timeout politik (DECISION #39)
- `3335f0b` — phase 6c: agent_ask — live A2A messaging

**Phase 6 ist damit komplett** — beide Modi live über alle drei Engines:
- **Modus 1** (sealed delegation, fresh sub-session) — Phase 6b validiert 2026-05-04
- **Modus 2** (live A2A messaging in target's existing session) — Phase 6c
  validiert 2026-05-05

### DECISION #39 — Long-task timeout politik

Drei-Schicht-Config in `agentLoop` (`src/config/types.ts`):
- `toolCallTimeoutMs: 30s` — fast tools (memory, web, file, time, obsidian)
- `longTaskDefaultTimeoutMs: 5min` — slow A2A default wenn caller kein
  timeout_ms setzt (subagent_result wait_until_done, agent_ask)
- `longTaskMaxTimeoutMs: 30min` — hartes Maximum auch bei explizitem
  timeout_ms

Plus die CLI-Layer hochgezogen:
- `claudeCli.mcpToolTimeoutMs: 1800000` (von 600000)
- `codexCli.toolTimeoutSec: 1800` (von 600)

**Beide MÜSSEN ≥ longTaskMaxTimeoutMs sein** — sonst kappt die CLI's
MCP-Layer durch bevor unsere eigene Ceiling greift. Im Default jetzt
by-design alle drei bei 30 Min.

Read-at-call-time-Pattern in `src/tools/agents/long-task-timeouts.ts` —
Module-Level-Cache populated bei Server-Boot und MCP-Child-Boot. Tools
lesen `longTaskDefaultMs()` / `longTaskMaxMs()` per Call, also greift
eine Config-Änderung ohne Restart.

**Pattern Wall-Clock + Pending statt Heartbeat** — das ist eine
bewusste Politik-Entscheidung. DECISION #37 macht den „Default" zu
einem Checkpoint statt einem Death-Sentence: Tool-internes Timeout
returnt `state:"pending"` (NICHT Error), Sub läuft im Hintergrund
weiter, Caller adaptiert mit höherem timeout_ms. Heartbeat-basiert
wäre theoretisch ehrlicher, aber teurer (Streaming-Awareness durch
alle Engines, neue Wire-Format-Felder). Wall-Clock + Pending = 80%
des Werts zu 20% des Aufwands.

### Phase 6c — agent_ask live messaging

`agent_ask({agent, message, session?, timeout_ms?})` postet eine
Frage in die main-Session der Ziel-Persona, Lisa läuft einen normalen
Turn (Memory-Auto-Inject, Persona, Tools — alles), die Antwort kommt
blockierend zurück. Beide Turns sichtbar in Lisas main wenn User
später öffnet. Hans's tool_call/tool_result sichtbar in hans's main.

**Was Phase 6c gebaut hat:**

- `src/server/session-queue.ts` — neue Datei. Per-Session-Lock mit
  Two-Class-Priority-Queue (`user` > `agent`). User-Entries springen
  vor wartende agent-Entries (Variante b aus der Diskussion). FIFO
  innerhalb jeder Klasse. AbortSignal-aware. In-Memory only.
- `src/tools/agents/ask.ts` — neue Datei. agent_ask-Tool mit
  Pending-Pattern, UUID-call_id (FUTURE-async-Pfad vorbereitet),
  5min/30min Timeout via longTask-Config, Self-Call-Guard.
- `src/types/events.ts` — `agent_ask_call_id?` auf user_message,
  neuer SSE `user_message`-Event für A2A inbound live.
- `src/server/run-turn.ts` — plumb-through `agentAskCallId`,
  publishSse emittiert user_message-Event wenn fromAgent gesetzt.
- `src/server/index.ts` — `/chat/send` und `/chat/send-sync`
  acquiren Session-Lock mit Priority basierend auf fromAgent. Plus
  agent_ask_call_id Body-Param. Plus publishSse auch in send-sync.
- `src/cli/tui/{types,stream,app,turn-views}.tsx` — TUI rendert
  `↬ hans` Cyan-Tag bei A2A inbound (statt grünem `user`-Tag).

**Was bewusst NICHT in Phase 6c kam (FUTURE):**

- `agent_ask_result(call_id)` async-Retrieval — wenn Caller bei
  Pending später die Antwort programmatisch abholen will. Heute landet
  die Antwort nur im Target-JSONL, Caller hat keinen Zugriff. Bauplan
  in `private/A2A-design.md` FUTURE-Sektion.
- Persistente Queue mit Crash-Recovery — MVP nur In-Memory.
- Deadlock-Detection bei A2A-Cycles — theoretisch möglich, durch
  30min-Cap eh begrenzt. Cycle-Detection im Lock-Graph wäre FUTURE.
- History-Replay im TUI bei Session-Open — pre-existierende Lücke,
  unabhängig von 6c.

### Test-Validierung 2026-05-05

7 Tests durchgeführt, alle grün:

| # | Test | Ergebnis |
|---|---|---|
| 1 | agent_ask cross-engine jarvis(opus) → lisa(gpt55) | ✅ 12s, korrekte Antwort, call_id present |
| 2 | Pending-Pattern bei `timeout_ms: 3000` | ✅ pending nach 3001ms, Target-Turn lief im Hintergrund weiter |
| 3 | Lock-Serialisierung — parallele agent_asks | ✅ A1@4150ms, A2@7976ms (sequenziell, kein JSONL-Race) |
| 4 | User-Priority — User springt vor wartendem agent_ask | ✅ JSONL-Order: A1 → USER → A2, obwohl A2 zuerst enqueuete |
| 5 | spawn_subagent self-clone wait:true Regression | ✅ 6.3s, sub-self-894-2cnw erstellt |
| Pattern 2 | async Lifecycle: spawn-status-result mit pending+done+default | ✅ alle 5 Steps, neuer schema-default funktioniert |
| Pattern 5 | Recursion-Cap depth=3 | ✅ deterministisch via direct-handler-call |

**Persistenz verifiziert** — `from_agent` und `agent_ask_call_id` landen
sauber in `~/.somora/agents/lisa/sessions/main.jsonl`. Reihenfolge-
Beweis für User-Priority im JSONL: Hans-A1 → User-Turn (kein
from_agent) → Hans-A2.

**Was bewusst NICHT re-getestet wurde** — Patterns 1, 3, 4 vom
2026-05-04 (Payment-Orchestration, Per-Spawn-maxRounds, Cross-Engine-
Spawning). Die testen Engine-Behavior das in Phase 6c nicht angefasst
wurde — DECISION #37 (Engine-Tool-Race) ist von 2026-05-04. Wenn wir
später Engine-Adapter ändern, dann diese Patterns wieder mitziehen.

### Bug-Fixes nach A2A-Abschluss — alle 4 Bugs durch

Hans hat 2026-05-05 vier Bug-Reports geliefert (`~/somoraworkspace/2026-05-05-bugs.md`).
Alle vier sind drin und committed:

- **Bug 2** (commit `64ca680`) — `file_list` glob ohne `/` matcht jetzt
  korrekt gegen Basename auch im rekursiven Walk. Root-Cause war
  `globRe.source.includes('/')` der den kompilierten Regex inspizierte
  (immer `/` wegen `[^/]*`) statt das Original-Glob-String. Fix:
  CompiledGlob-Wrapper mit `hasSlash`-Flag, in local.ts + remote.ts.
  Verifiziert live: `*.md` recursive findet jetzt 10 Files in
  Unterordnern statt 3 Top-Level.
- **Bug 4** (commit `64ca680`) — Resources hot-reload via lazy
  mtime-check. Neuer `getFreshConfig()`-Helper in
  `src/config/loader.ts` cached + stat'd config.yaml, re-load nur bei
  mtime-Änderung. resource_list / resource_test / file_*-mit-target
  switchen auf `visibleResourcesForAgentFresh()` /
  `resolveVisibleResourceFresh()`. Agent kann jetzt config.yaml
  editieren und beim nächsten Tool-Call die neue Resource sehen ohne
  Restart. Verifiziert live: nach Hans' spiderman-Addition jetzt
  sichtbar.
- **Bug 1** (commit `c707065`) — Paused dreams akkumulierten weil
  `resumeDream` das alte `.paused.md`-File nicht löschte: `runDream`
  generiert einen neuen timestamp-basierten ID und schreibt fresh.
  Wenn der neue Run wieder abgebrochen wurde → noch ein paused-File.
  Fix: `resumeDream` unlinked das alte paused vor dem Rerun. Plus
  `consolidateStalePausedDreams` als Server-Start-Housekeeping
  drainiert den bestehenden Backlog (pro source-session nur das
  neueste paused behalten). Verifiziert live: tsx-watch reload
  hat 4 von 5 hans-paused-Dreams automatisch entfernt, nur das
  neueste (20260504-202507) bleibt zur Wiederaufnahme.
- **Bug 3** (commit `66c5d37`) — Optionales `DREAMRULES.MD` pro Agent
  unter `~/.somora/agents/<name>/` (zu AGENTS.md / SOUL.md / USER.md
  passend). Freitext-Markdown, wird verbatim als
  `## Per-agent rules`-Block in den Dream-Worker-System-Prompt
  injiziert. Loader mit mtime-Cache, optional (fehlende Datei →
  altes Verhalten). Per-Agent statt global weil Dream-Behavior und
  Vault-Zugriff schon per-Agent sind. Hans's Starter-DREAMRULES legt
  „Vault ist Single Source of Truth"-Regel + Anti-Duplikations-Regel
  fest; Lisa hat keine (opt-in). Doku in `docs/dream-mode.md`.

### TODO für nächste Session

Hans's Bug-Reports vollständig abgearbeitet — A2A + Dream-Worker-Pflege
sind durch. Nächste mögliche Themen:

### TODO für nächste Session

A2A + Dream-Worker-Pflege durch. Offene Themen:

1. **Phase 5 — exec mit Hard-Blacklist + tmux** (große separate
   Diskussion). Cross-Reference-Pointer in `private/FUTURE.md`
   liegen schon — claude-code-source `BashTool/`, OpenClaw exec
   mit host-Backends, unser eigenes `docs/research/tool-architecture.md`
   §2.2.
2. **Phase X — Skill-Handling** (vorher 9 Diskussionsfragen klären,
   siehe `private/FUTURE.md` Abschnitt „Phase X — Skill-Handling"; **NICHT**
   unilateral starten).
3. **Maintenance-Sweep 1** — Dependencies + SDK-Audit (FUTURE.md
   beschreibt Plan, Welle A-D, Smoke-Tests via 5-Pattern-Matrix).
   Empfohlen nach Phase 5 + Phase X.
4. **Dream-Worker-Priorisierung** (User-Active-Marker mit
   AbortSignal) — wenn `idleMinutes < 30` wieder gewünscht.
   FUTURE.md hat den halben-Tag-Bauplan.
5. **TUI-History-Replay bei Session-Open** — pre-existierende Lücke,
   für 6c relevant: User der Lisas Session erst nach einem agent_ask
   öffnet sieht den `↬ hans`-Tag erst beim Refresh, nicht aus dem
   JSONL repleyed.

### Pickup-Satz für nächste Session

> "Phase 6 ist komplett — Modus 1 (sealed) und Modus 2 (live agent_ask)
> beide live und validiert. DECISION #39 (long-task timeout politik:
> 30s/5min/30min Drei-Schicht) ist drin und mit dem Pending-Pattern
> aus DECISION #37 verzahnt. Session-Queue mit User-Priority hält
> User-Turns reaktiv auch wenn A2A-Traffic läuft. Hans's vier
> Bug-Reports 2026-05-05 alle abgearbeitet: Bug 2 (file_list glob),
> Bug 4 (resources hot-reload), Bug 1 (paused-dream Akkumulation +
> Backlog-Drain), Bug 3 (DREAMRULES.MD per-Agent — Hans hat starter
> Rules, Lisa opt-in). HEAD 66c5d37. Nächste Themen offen: Phase 5
> (exec+tmux), Maintenance-Sweep, Phase X (Skills, vorher
> diskutieren), Dream-Worker-Priorisierung."

---

## Vorheriger Stand (2026-05-04 spätabend — Tool-Timeout-Aware-Engine + cross-engine validiert)

**HEAD: dcbc854** (lokale Hotfixes 2026-05-04 noch nicht committed; tsx-watch
hatte sie aber zur Laufzeit aktiv).

Heute (2026-05-04) waren ein langer Test-Tag plus ein zweischrittiger Bugfix
auf der Engine-Tool-Loop:

### Bugfix-Welle 2026-05-04

Hans hat 2026-05-03 nachts einen sauberen Bug-Report geschrieben über
`subagent_result(wait_until_done)` der nach 30s gekillt wird. Root Cause
war ein pauschaler `Promise.race(invoke, 30s)` in `openai-compatible.ts`
um jeden Tool-Call. Recherche in OpenClaw + Hermes-Repos: niemand baut
einen globalen Engine-Tool-Race mit hartem Cap; OpenClaw hat
`waitForAgentRun({runId, timeoutMs})` mit Status-Tupel ok|pending|
timeout|error und Outer-Buffer `timeoutMs + 2000`.

DECISION #37: Adoptiert. ToolDefinition kriegt `defaultTimeoutMs?`,
`timeoutFromInput?(input)`, `maxTimeoutMs?`. Engine resolved
per-Call: `dynamic ?? static ?? globalToolCallTimeoutMs`, clamped auf
`maxTimeoutMs`. Lang-blockierende Tools (`subagent_result(
wait_until_done)`) returnen `state: "pending"` + `hint`-Feld statt
`{ok:false}`/Error — Modell soll nicht blind retryen sondern
`subagent_status` checken oder mit höherem `timeout_ms` retry'n.

Setting auf `subagent_result`/`spawn_subagent`/`spawn_subagents`:
caller-driven via `wait_until_done` + `wait` in den Inputs. Outer-Buffer
+2s wie OpenClaw. Default 30s greift weiter für alle Tools die nichts
über sich aussagen (memory_*, web_*, time_now, file_*).

Doku: `docs/research/tool-architecture.md` Sektion 6.1 +
`private/DECISIONS.md` #37.

### Cross-Engine Tool-Timeout Findings (Test-Tag-Befund)

Beim Cross-Engine-Test ist aufgefallen: claude-cli und codex-cli haben
**eigene** harte Tool-Call-Timeouts, die unabhängig von unserem
Engine-Race greifen:

- **claude-cli MCP_TOOL_TIMEOUT** ~5min. Hans-on-opus rannte bei sync-
  Test-5 zweimal in 5min-Timeouts, hat dann adaptiv auf async+poll
  umgestellt. Konfigurierbar via `MCP_TOOL_TIMEOUT` ENV des
  claude-agent-sdk subprocess.
- **codex-cli tool_timeout_sec** 60s default. Codex-Test-5 ist mit
  `subagent_result(timeout_ms=600000)` nach 120s vom codex-internen
  Timeout gekillt worden. Konfigurierbar via TOML-Override
  `mcp_servers.<name>.tool_timeout_sec` per `-c`-flag.

Hotfix in zwei neuen Config-Blöcken:

```yaml
claudeCli:
  mcpToolTimeoutMs: 600000      # 10min
  mcpConnectTimeoutMs: 60000

codexCli:
  toolTimeoutSec: 600           # 10min
```

Implementation:
- `applyClaudeCliSdkEnv(config)` setzt `process.env.MCP_TOOL_TIMEOUT` /
  `MCP_TIMEOUT` beim Server-Boot. Subprocess erbt sie automatisch.
- `applyCodexCliEnv(config)` setzt `process.env.SOMORA_CODEX_TOOL_
  TIMEOUT_SEC`; `somoraMemoryCodexFlags()` liest die ENV und emittiert
  `-c mcp_servers.somora-memory.tool_timeout_sec=N`.
- Explicit env wins (override-layer wie überall — DECISIONS-Politik).
- `/env`-Endpoint surfaced beide neue Felder.

### Dream-Worker Idle-Hotfix

Test-Tag-Beobachtung: Auto-Dream-Worker mit `idleMinutes: 3` (alter
Test-Wert) triggerte ständig parallel zu Live-Tests, blockierte den
mlx-omx-Server (sequenzielle Queue pro Modell). Hans-on-gemma hat in
20 Min nicht einen Token generiert, weil Dream-Calls + Sub-Subs den
Slot belegten.

Hotfix: alle agent.yaml `idleMinutes: 60` (von 3). Default in
`loader.ts` ist 30; per-agent override schiebt das hoch.

Eigentliche Lösung in `private/FUTURE.md`: Dream-Worker-
Priorisierung mit User-Active-Marker und AbortSignal. AutoDreamWorker
pausiert sobald Chat-Turn oder sync-Sub läuft, resumed bei nächstem
Idle. Halben-Tag-Bau, in FUTURE eingetragen, nicht heute.

### Test-Matrix 2026-05-04 (Tests 1-5 auf opus / codex / gemma)

Fünf Test-Patterns durchgespielt:

1. **Payment-Orchestration** (Hans's Original-Bug-Report-Prompt) — Sub
   spawnt 3 Sub-Subs parallel mit web_search/web_fetch, wartet, baut
   Vergleichs-Markdown.
2. **Pending-Status** — async spawn + `subagent_result(timeout_ms=20000)`,
   sehen ob `state: pending` sauber durchpropagiert.
3. **Per-Spawn maxRounds** — Orchestrator-Sub mit `maxRounds: 32` per
   User-Hint, sehen ob Hans's Tool-Description-Hint adoptiert.
4. **Cross-Engine** — Hans-on-X spawnt Lisa/Jarvis auf einem anderen
   Engine, sync wait.
5. **Recursion-Cap** — sync 3-level chain, sub3 versucht sub4,
   `recursion depth 3 exceeds limit 3` wird sauber durchpropagiert.

Ergebnis-Übersicht:

| Test | opus (claude-cli) | codex (codex-cli, gpt55) | gemma (openai-compatible) |
|---|---|---|---|
| 1 Payment-Vergleich | ✅ 11min, 4.5k-char Markdown | ✅ 9min, 5.5k-char Markdown | ✅ 9.6min, 3.9k-char Markdown |
| 2 Pending-Status | ✅ 47s, hint-Feld korrekt | ✅ 38s, hint korrekt | ✅ 4.8min (mlx-Queue), pending OK |
| 3 maxRounds | ✅ 32 proaktiv (auch ohne Hint) | ✅ 32 proaktiv | ⚠️ default — gemma listet Tool-Hints schwächer als die größeren |
| 4 Cross-Engine | ✅ → Lisa-on-gemma 63s | ✅ → Lisa-on-gemma 66s | ✅ → Lisa-on-opus 189s |
| 5 Recursion-Cap | ✅ via JSONL verifiziert | ✅ 2.4min (mit 600s-Hotfix) | ✅ 4.4min, sauber durchpropagiert |

**Engine-Race-Fix Beweis** (auf gemma, das war ja die kaputte Engine):
- 60s `wait_until_done` 3x sauber durchgewartet, kein 30s-Kill mehr
- Hans-on-gemma adaptiert selbständig auf `timeout_ms: 120000` wenn
  `pending` mehrfach kommt — `hint`-Feld wirkt als Selbst-Korrektur

**Concurrency-Beobachtung:** mlx-omx queue't sequenziell pro Modell.
Bei 5+ parallelen gemma-Subs (Test-Subs + Auto-Dream-Worker) blockt
der nächste Hans-Turn massiv. Mit `idleMinutes: 60`-Hotfix entschärft;
strukturell löst das aber erst der FUTURE-Eintrag (User-Active-Marker).

### Status der Phase 6

Phase 6 Modus 1 (sealed delegation) ist **vollständig validiert**:
- ✅ async (default) und sync wait
- ✅ Self-Clone und cross-persona spawning
- ✅ Cross-Engine in alle Richtungen (opus↔gpt55↔gemma)
- ✅ Recursion-Cap (max depth 3) — code-deterministisch
- ✅ Concurrency-Cap (4 per agent, 16 global) — code-deterministisch
- ✅ Race-Slug-Fix (parallele spawn_subagents alle unique sessions)
- ✅ pending-Pattern statt Errors bei Tool-Internal-Timeouts
- ✅ Tool-aware Engine-Race statt pauschaler 30s-Cap
- ✅ Tool-Timeout-Hardlimits aller drei CLIs konfigurierbar (10min default)
- ✅ Auto-Dream-Idle hochgedreht (60min) gegen Concurrency-Stau

### Workflow-Konvention seit 2026-05-05 (DECISION #38)

Vor **jeder** neuen Phase oder größeren Design-Diskussion: 30 Min
Skim in `claude-code-source/` + `~/.openclaw/dist/` + unserem
`docs/research/tool-architecture.md`. Konkrete Phase-Pointer in
`private/FUTURE.md` „Cross-Reference: 3-Repo-Research-Pointers".
Findings als knapper „was die machen / was wir adoptieren / was
weglassen"-Block ins Phase-Design-Doc.

### TODO für nächste Session

- **Phase 6c — `agent_ask` Modus 2** (live messaging zwischen Agents),
  ODER **Phase 5 — exec mit Hard-Blacklist** + tmux-Familie. User-
  Entscheidung steht aus. Vor Start: Cross-Reference-Pointer in FUTURE
  durchgehen (DECISION #38).
- **Dream-Worker-Priorisierung** bauen wenn `idleMinutes < 30` wieder
  gewünscht ist (FUTURE-Eintrag, halber Tag).
- **Maintenance-Sweep 1 — Dependencies + SDK-Audit:** geplant
  *nach* Phase 5 + 6c. Stand 2026-05-04: claude-agent-sdk 0.2.123 vs
  latest 0.2.126, codex-cli 0.125.0 vs latest 0.128.0; binary
  `claude` ist sync (2.1.126). Plus `npm outdated` für andere Deps.
  Sweep läuft mit derselben 5-Pattern-Test-Matrix vom 2026-05-04
  als Smoke-Test. Details: `private/FUTURE.md`.
- **Phase X — Skill-Handling (vorher unterhalten):** als eigene große
  Phase reserviert, NICHT in Phase 4-Polish reingerutschen lassen.
  Wir haben mit ~25 Tools die Schwelle wo Skills sich lohnen längst
  überschritten, aber 9 offene Fragen müssen vor Bau diskutiert sein
  (Skills-vs-Tools-Trennung-Strenge, Storage-Location, Discovery-
  Mechanik, Self-Improvement-Loop, Verhältnis zu Memory + Persona,
  AgentSkills.io-Kompatibilität). Reihenfolge wahrscheinlich nach
  Phase 5 + 6c, plus Aufwand 3-5 Tage. Diskussions-Liste:
  `private/FUTURE.md` Abschnitt „Phase X — Skill-Handling".

### Dateien-Pointer

- `src/tools/types.ts` — ToolDefinition Timeout-Felder
- `src/engine/openai-compatible.ts` — tool-aware Race-Resolver
- `src/tools/agents/status.ts` — pending-Pattern, hint-Feld
- `src/tools/agents/spawn.ts` — sync spawn timeout
- `src/config/types.ts` — claudeCli + codexCli config-Blöcke
- `src/config/loader.ts` — applyClaudeCliSdkEnv, applyCodexCliEnv
- `src/mcp/config.ts` — somoraMemoryCodexFlags mit tool_timeout_sec
- `~/.somora/agents/{hans,lisa,jarvis}/agent.yaml` — idleMinutes 60
- `docs/research/tool-architecture.md` Sektion 6.1
- `private/DECISIONS.md` #37
- `private/FUTURE.md` — Dream-Worker-Priorisierung Konzept

### Pickup-Satz für nächste Session

> "Phase 6 Modus 1 ist voll validiert über alle drei Engines (opus,
> codex, gemma) inkl. cross-engine. Tool-Timeout-Architektur ist
> tool-aware: Tools deklarieren ihre Wartezeit selbst, lang-blockierende
> Tools returnen pending statt error. Drei CLI-spezifischen Hard-Limits
> (claude-cli MCP_TOOL_TIMEOUT 5min, codex-cli tool_timeout_sec 60s,
> openai-compatible 30s-Race) jetzt alle auf 10min konfigurierbar via
> config.yaml claudeCli/codexCli. Dream-Worker idle 60min als Hotfix
> gegen Concurrency-Stau; eigentliche Lösung (User-Active-Marker) in
> FUTURE. Nächste Entscheidung: Phase 6c (agent_ask) oder Phase 5
> (exec)."

---

## Vorheriger Stand (2026-05-03 spätabend — A2A Modus 1 live, alle drei Engines)

**HEAD: dcbc854** auf github.com/thenaxon/somora_agent (private).

Phase 6 (Agent Orchestration) — Modus 1 (sealed delegation) ist live
über alle drei Engines. Hans kann andere Personas oder Self-Klone als
Sub-Agents spawnen, async (default) oder sync, mit Recursion-Cap und
Concurrency-Cap, mit Cross-Engine-Composition (Hans-auf-opus → Lisa-
auf-gpt55 → Jarvis-auf-gemma).

### 6a — Foundation (commit 52cdc08)
- `NormalizedEvent.user_message.from_agent?: string` auf der Wire
- `TurnInput.fromAgent` + `subagentDepth` durch alle drei Adapter
- `withFromAgentHeader` helper — alle Engines prependen denselben
  `[Message from agent X]`-Header konsistent
- Replay-Prefix labelt A2A-Pairs als `User (from agent X)`

### 6b — Modus 1 sealed task (commit 1f98c25)
- `spawn_subagent({persona?, model?, task, wait?, maxRounds?})`
- `spawn_subagents({tasks, wait?})` — bis zu 8 parallel
- Sub-Sessions via `createSession()` mit ms+rand Slug-Suffix
- spawn-Meta in SessionMeta: `{ kind, parent_agent, parent_session,
  task_summary }`
- Tools nur in-process registriert, MCP-Pfad fehlt noch (kommt 6b.1)

### 6b.1 — HTTP-Fallback für MCP (commit 0f5ff8a)
- `POST /chat/send-sync` Endpoint — sync wrapper um `runChatTurn`
- spawn_subagent fällt auf HTTP zurück wenn injectedDeps null
- SOMORA_HOST + SOMORA_PORT env vars in MCP child config (für beide
  CLI-Engines via `somoraMemoryServerSpawn` + `somoraMemoryCodexFlags`)
- Bug-Fix nachgereicht (commit 2fcff4d): alte injectedDeps-Guard
  entfernt die den Fallback blockierte

### 6b.2 — Async wait:false default + status/result (commit 949870f)
- spawn default jetzt `wait: false` — Hans kriegt task_id, Turn
  endet, User chattet weiter
- `subagent_status({task_id})` — running/done/failed
- `subagent_result({task_id})` — Final-Result wenn done
- In-Memory Task-Store `src/server/async-tasks.ts`
- Endpoints: `POST /spawn-async`, `GET /spawn-status`,
  `GET /spawn-result`, `GET /spawn-list`
- Session-Naming-Race-Fixes: ms+rand Slug, `createSession`
  Collision-Retry mit `wx`-flag, `sessionMetaStore.set` tmp mit
  pid+ts+rand (commit dd72577)

### 6b.3 — Hans's Bug-Report-Fixes (commit dcbc854)
Hans hat einen sauberen Bug-Report geschrieben über `result: ""` wenn
ein Orchestrator-Sub maxRounds erreicht ohne final-message. Vier Fixes
gelandet:
- **Force-Summary:** wenn Loop bei maxRounds ohne content endet → ein
  letzter LLM-Call ohne Tools mit "use all rounds gone, summarize now"
- **wait_until_done auf subagent_result:** Block server-side bis fertig,
  verbrennt KEINE caller-side rounds (vorher Poll-Loop nötig)
- **Synthetic Marker:** wenn auch Force-Summary failt → klare
  `[somora] Sub reached cap of N rounds...` Message statt leerer String
- **Per-Spawn maxRounds:** `spawn_subagent({maxRounds: 32})` für
  Orchestrator-Subs die mehr Budget brauchen

---

## TODO morgen (2026-05-04)

### Test-Checkliste
1. **Same payment-orchestration test wie Hans gestern**
   ```
   "schicke einen subagent los der 3 payment orchestration firmen sucht
    er kann auch gerne selbst subagents losschicken sie sollen auch die
    webseiten dazu anschauen und dir alle infos geben damit du dann
    einen vergleich der 3 anbieter machen kannst"
   ```
   - Sollte mit Force-Summary + wait_until_done sauber durchlaufen
   - Wenn nicht: bug-trace, Hans's Format adoptieren

2. **wait_until_done UX prüfen** — Hans sollte beim Vergleichen NICHT
   Poll-Loops bauen sondern `subagent_result(task_id, wait_until_done:
   true, timeout_ms: 300000)` aufrufen

3. **Per-spawn maxRounds testen** — Hans (oder Sub-Hans) muss bei
   Orchestrator-Tasks `maxRounds: 32` o.ä. setzen. Description sagt's
   ihm, mal sehen ob er's adoptiert

4. **Cross-Engine Spawning** — `spawn_subagent({persona: 'lisa', model:
   'gemma4big', task: '...'})` — Hans-on-opus delegiert an Lisa-on-gemma
   sollte über HTTP-Fallback gehen

5. **Recursion-Cap (depth=3)** — verifizieren dass tief verschachtelte
   Subs sauber refusen

### Build-TODOs (in Reihenfolge)

**Phase 6c — Modus 2 `agent_ask` (live messaging):**
- Tool: `agent_ask({agent: 'lisa', message: '...'})` — postet AS Hans
  in Lisas main, blockt bis Lisas Antwort, beide Turns sichtbar in
  Lisas main
- Lock-Semantik: Lisa hat per-session-lock, fail-fast wenn Lisa busy
- Memory + Dream durchlaufen normal (Lisas auto-inject sieht den
  from_agent-Turn)
- TUI-Rendering: from_agent-User-Messages mit Sender-Icon statt
  User-Icon — siehe `src/cli/tui/turn-views.tsx` UserTurn

**Phase 6c.1 — TUI-Rendering Phase 6a foundation auch sichtbar machen**
- TUI parst `from_agent` aus user_message events
- UserTurn rendert mit Sender-Icon plus Marker

**Phase 5 — exec + tmux (großer separater Design-Block):**
- Vor-Bau: User wollte exec mit Hard-Blacklist (kein Approval-Flow),
  Sandbox-Dir per Agent, target=local|<resource>, PTY-Support,
  Background-Jobs+notify_on_complete
- Hard-Blacklist-Liste schon dokumentiert in
  docs/research/tool-architecture.md
- tmux-Tool-Familie als Phase 5b: tmux_create / tmux_send /
  tmux_capture / tmux_list / tmux_kill — analog zu OpenClaws
  tmux-agent-teams skill aber typed, nicht prompt-getrieben
- Smart-Approval-LLM-Layer (à la Hermes) explizit out-of-scope —
  User wollte simple Blacklist
- Konkretes File: privat/A2A-design.md hat Mode-3-Sketch unten

**Phase 4-Polish (kleiner Kram):**
- Anthropic Prompt-Caching aktiv markieren
- Multimodal Image-Routing für openai-compatible
- Token-Counting-Genauigkeit
- Obsidian Wikilink-Awareness im Memory-Layer

**Phase 6d — Skills-Layer (FUTURE):**
- AgentSkills.io spec, OpenClaw-style Frontmatter mit `requires.bins`
- Erst sinnvoll wenn 10+ Tools rechtfertigen, aktuell ~25

### Offen / unklar morgen zu klären
- Hat Hans den Force-Summary-Pfad tatsächlich getroffen? (= sah er
  vorher leeres Result, jetzt Markdown-Summary?)
- Race beim parallel Spawn voll behoben? (3 Subs mit ms-Kollision
  sollten alle saubere unique Slugs kriegen)
- agent_ask Modus-2 oder erst exec? — Bauchgefühl: agent_ask, weil
  es auf der A2A-Foundation aufsetzt und die Mode-Trennung sauber
  abschließt. exec ist eigene größere Diskussion

### Dateien wo's morgen weitergeht
- `private/A2A-design.md` — vollständige Architektur-Skizze, alle
  Decisions A-E + Detail-Fragen 1-5 gelocked
- `docs/research/tool-architecture.md` — exec Hard-Blacklist
  Referenz, OpenClaw + Hermes-Vergleich
- `~/.openclaw/skills/tmux-agent-teams/SKILL.md` — Vorbild-Pattern
  für Phase 5b

### Pickup-Satz für nächste Session
> "Phase 6 Modus 1 (spawn_subagent) ist live über alle drei Engines
> mit async-default, wait_until_done auf subagent_result, und
> per-spawn maxRounds. Hans's Bug-Report-Fixes sind drin. Erstes
> Test-Vorhaben: payment-orchestration-Vergleich nochmal,
> verifizieren dass Force-Summary + wait_until_done UX sauber sind.
> Dann Phase 6c (agent_ask Modus 2) oder Phase 5 (exec mit
> Hard-Blacklist) — User entscheidet."

---

## Vorheriger Stand (2026-05-03 abend — Phase 1 Tools komplett, Skeleton-Refactor durch)

Das System ist jetzt End-to-End mit echten Tools nutzbar — nicht mehr
nur Memory/Dream. Hans kann googeln, Webseiten lesen, Notes im Vault
schreiben und verschieben (mit Wikilink-Preservation), Datum/Uhrzeit
abfragen. Drei Engines weiterhin parity, Tool-Surface ist
engine-agnostisch.

**Heute (2026-05-03) — alles getestet, gepusht:**

Bugfix-Welle (commit 00e0003):
- resetSession touched leere jsonl (non-main sessions waren nach reset
  unauflösbar)
- /agent+/session validieren Existenz vor switchTo
- SSE bricht bei 4xx ab statt endlos zu reconnecten
- /show memory|tools on|off mit Config-Defaults (server-zentrisch via
  /tui-config Endpoint)
- Tool-Format-Logik vom TUI auf Server gezogen (callId→tool
  Korrelation, pre-formatted summary auf der SSE-Wire). Behebt nebenbei
  Bug dass per-tool result summaries nie liefen
- TUI-Polish: autocomplete window scrolling, header zeigt show-Status

Thinking-Steuerung Stufe 1+2 (commit 295151f):
- cross-engine `/thinking off|low|medium|high` plus persona-default in
  agent.yaml
- claude-cli mappt auf effort/disabled (SDK-recherche bestätigt),
  codex-cli auf -c model_reasoning_effort, openai-compatible auf
  reasoning_effort body field
- Capability-getrieben: Modelle ohne `reasoning` in capabilities →
  dormant-Anzeige (gelb) im Header statt silent placebo
- Reasoning-Token-Count im Header (`↓ 387 (1.2k 🧠)`)
- Stream-Phase-Indikator "🧠 thinking…" während Pre-Content
- Doku: docs/thinking.md
- Stufe 3 (Block-Sichtbarkeit) bewusst zurückgestellt → FUTURE.md

/verbose framework (commit e55a2e9):
- /verbose tools|memory|system on|off
- tools → volle Input/Output Payload unter jedem Call/Result
- memory → voller Inject-Block-Volltext unter [memory · …]
- system → einmaliger System-Prompt-Print via neuer Endpoint
- Server hängt `details`/`fullText` immer auf SSE Wire, Client filtert
- Doku: docs/display.md

Codex Disable-Liste verschärft (commit 37da701):
- 14 → 41 disabled features. All-own-tools-Posture.
- Web_search-Hallucination bestätigt: enovom.com Test mit dem neuen
  web_fetch zeigte dass Hans damals halluziniert hat, kein Tool-Leak

Tool-Architektur Recherche (commit 2087479):
- docs/research/tool-architecture.md (525 Zeilen) — Vergleich OpenClaw
  + nousresearch/hermes-agent. Beide Repos gelesen, verbatim Snippets
- Skeleton-Erweiterungen: ToolDefinition.toolset (required),
  maxResultSizeChars (default 100k, registry truncates JSON-string),
  available(ctx) (filter aus listAvailable, hidden vor Modell)
- ToolContext um config: Config erweitert
- /tools Debug-Endpoint zeigt toolset, cap, hasAvailabilityCheck

Phase 1 Tools (commits 41a01c6 ... 1f597f6):
- ✓ time_now (commit 41a01c6) — Datum/Zeit/Wochentag/Wochennummer,
  IANA-Timezone-Param, validiert via Intl.DateTimeFormat
- ✓ web_search (commit b7d932a) — Brave Search API, query+count+
  country+freshness, available() gated auf config.web.brave.apiKey
- ✓ web_fetch (commit d0fce00) — Mozilla Readability + jsdom +
  turndown, SSRF-Guard (RFC1918+loopback+link-local+CGNAT+IPv4/v6
  metadata), 750 KB Body-Cap, Re-Check nach Redirect, prompt-injection
  wrapping `<external_content source="web_fetch" warning="...">`
- ✓ obsidian_write/move/delete (commit 1f597f6) — Vault-Pfad-Sandbox
  via realpath, readOnlyPaths-Enforcement, frontmatter-Merge via
  gray-matter, **Wikilink-preserving Move** (basename + relative-path
  patterns mit |display und #heading), soft-delete in `.trash/<ts>-...`
- Smoke-tested end-to-end durch Rene: web_search, web_fetch, obsidian
  alle live geprüft, funktionieren

Brave-API-Key in `~/.somora/config.yaml` (gitignored, nicht im Repo).
Hans hat reasoning-Capability bei opus/sonnet/gpt55/gpt54mini/codex53,
gemma4big/small bewusst nicht (zeigen dann ehrlich „dormant").

---

## Was als nächstes ansteht

**Phase 2 — File-Tools (`file_read/write/patch/search`):**
- Braucht Sandbox-Design: was ist Agent's Workspace? Default
  `~/.somora/agents/<name>/workspace/`?
- readOnlyPaths-Pattern wie obsidian
- Realpath-Guards gegen Symlink-Escapes (haben wir bei obsidian schon)
- Adaptive Paging (OpenClaw-Style: 10% des aktiven Modell-Windows pro
  Page) oder einfacher fester Cap?
- Search via ripgrep-binary spawnen oder pure-TS Implementierung?
- ~5-7 Tage Aufwand wenn ohne unforeseen issues

**Phase 3 — `exec`-Tool (große separate Diskussion vor Bau):**
- Backend: lokal direct? Docker-Sandbox? andere?
- Hard-Blacklist (kein Approval-Flow, kein Override) — Liste in
  docs/research/tool-architecture.md schon dokumentiert
- Per-Pattern path-Whitelist (kein Schreiben in ~/.ssh, /etc, etc.)
- Working-Dir per Agent
- Cancellation
- Background-Jobs + notify_on_complete (Hermes-Pattern)
- PTY-Support für TUI-Tools (Codex/Claude-Code-Subprozesse als Tool)
- Wie verhalten sich claude-cli und codex-cli wenn ihr eigenes
  shell_tool disabled ist und unser exec zur Verfügung steht?

**Phase 4 — Polish:**
- Anthropic Prompt-Caching aktiv markieren
- Multimodal Image-Routing für openai-compatible (Schema hat's,
  Adapter ignoriert)
- Token-Counting-Genauigkeit (statt 4-chars/token Heuristik)
- Obsidian Wikilink-Awareness im Memory-Layer (Recall-Expansion)
- Skills-Layer (FUTURE.md hat Eintrag, eigene Phase wenn 10+ Tools
  rechtfertigen)

**Phase 5+ — Frontends:**
- Voice/Realtime
- Telegram
- Web-Client (Orbit) — Tool-Surface ist schon engine-agnostisch und
  dünn-client-fähig, Wire-Protocol komplett dokumentiert

---

## Vorheriger Stand (2026-05-01 spätabend — Phase 2-Stufe-B/C/D MVP komplett)

**Phasen 1, 2-Stufe-A, B, C, D-MVP durch.** System ist End-to-End
benutzbar mit Memory + Tools + Dream-Mode (manueller Trigger). Drei
Engines im Gleichstand bei Konversation, Compaction, Tool-Surface und
Memory-Anbindung. Auto-Dream (Idle-Trigger) noch offen, agreement to
build steht.

**Phase 2-Stufe-A** (Three-Engine-Parität): `npm run dev:server` +
`npm run dev:cli` läuft, alle drei Engines reden, Sessions
persistieren, `/model`-Switching live, Compaction greift cross-engine.

**Phase 2-Stufe-B (Memory-Layer) komplett.** Markdown-as-Source +
SQLite/sqlite-vec-Index, lokale Embeddings (all-MiniLM-L6-v2 default,
~30MB), Hybrid-Retrieval (Vector 0.7 + BM25 0.3), Auto-Inject pro Turn.
Memory-Tools (search/get/list/write/edit/delete) als MCP-Server
exponiert für claude-cli + codex-cli, plus in-process für openai-
compatible. Obsidian-Vault als optionale Read-Source mit `readOnlyPaths`.
DECISIONS #25–#31 dokumentieren das Konzept.

**Phase 2-Stufe-C (Agent-Loop für openai-compatible) komplett.**
TurnInput.tools + ToolInvoker, openai-compatible erkennt tool_calls
aus dem Stream, dispatcht via in-process ToolRegistry, max 8 Rounds
(konfigurierbar via `agentLoop.maxRounds`), per-Tool-Timeout
(`agentLoop.toolCallTimeoutMs`). Drei-Engine-Tool-Parität erreicht.

**Phase 2-Stufe-D MVP (manueller Dream-Trigger via /reset)
komplett.** Async LLM-Extraktion über JSONL-Delta, Findings als
konkrete Aktionen (memory_write/edit/delete/vault_hint), strukturierte
Markdown-Files unter `~/.somora/agents/<name>/memory/.dreams/` mit
Status-Lifecycle (running/paused/failed/completed/processed). Tool-
Surface (dream_list/get/apply/dismiss) sowohl in-process als auch via
MCP. Crash-Recovery für orphan running-Dreams beim Server-Start.

**Sicherheits-Audit komplett.** Beide CLI-Engines haben jetzt
Defense-Layer gegen Host-Context-Leaks:
- claude-cli: 5-Layer (settingSources/tools/disallowedTools/canUseTool/
  managedSettings.autoMemoryEnabled=false)
- codex-cli: --ignore-user-config, --ignore-rules,
  project_root_markers=[], plus 14 disabled built-in features
  (shell/exec/browser/JS/web-search/personality/memories/...)
Auto-Memory-Leak (Claude Code's project-memory in agent prompts) und
codex' AGENTS.md walk-up identifiziert + geschlossen.

---

### Auf einen Blick — was Hans heute kann

| | claude-cli (opus) | codex-cli (gpt55) | openai-compatible (gemma) |
|---|---|---|---|
| Chat | ✓ | ✓ | ✓ |
| Memory READ (Auto-Inject) | ✓ | ✓ | ✓ |
| Memory WRITE (Tools) | ✓ via MCP | ✓ via MCP | ✓ via Agent-Loop |
| Dream-Tools | ✓ via MCP | ✓ via MCP | ✓ via Agent-Loop |
| somora-managed Compaction | — (Anthropic-intern) | — (codex-intern) | ✓ |
| Vault als Recall-Source | ✓ | ✓ | ✓ |

---

### Was bewusst noch offen ist

- **AutoDreamWorker (Idle-Trigger)** — Phase 2-Stufe-D Phase B. Manuell
  geht, Idle-Trigger fehlt. Design steht (idleMinutes per agent, Pause
  via AbortSignal bei chat.send, Resume on next idle, dreamReadThroughTs-
  Marker pro Session).
- **Anthropic Prompt-Caching aktiv markieren** — opus subscription-User
  profitiert eh implizit, aber für eventuelle API-Key-User später
  relevant. DECISIONS #20 Polish.
- **`obsidian_write` Tool** — User-getriggertes Vault-Schreiben mit
  `readOnlyPaths`-Beachtung.
- **Obsidian Wikilink-Awareness** — FUTURE.md, Lebensqualität.
- **Phase 3+** — Voice/Realtime, Telegram, andere Frontends.

---

### Veraltete Sektionen — historisch erhaltene Phase-2-Stufe-B-Entstehungsnotizen

(Bleiben für Audit-Trail; Inhalt ist „eingerollt" in den Stand oben.)

**Phase 2-Stufe-B im Bau.** Konzept-Doku + Foundation + Memory-Core
sind durch (siehe DECISIONS #25–#30, FUTURE.md):

- DECISIONS #25–#30 dokumentieren Memory-Layer + Config-Migration
- FUTURE.md hält Dream-Mode + Agent-Loop für openai-compatible fest
- `compaction:`- und `memory:`-Sektion im config.yaml verfügbar
  (DECISION #30: config statt Env-Var). Schema-Defaults greifen wenn
  config-Block leer
- `SOMORA_COMPACTION_*` Env-Vars sind jetzt Override-Layer über
  `config.yaml.compaction`, nicht mehr Primärquelle
- AGENTS.md-Frontmatter aufgeräumt: model/fallback in `agent.yaml`,
  Frontmatter nur noch Identity (name/description/icon)
- CLI-SSE-Stream-Bug behoben (Server-Heartbeat alle 20s, Cleanup toter
  Subscriber on writeSSE-Fail, Client-Auto-Reconnect mit Backoff)
- **Memory-Core gebaut** in `src/memory/`:
  - `storage.ts`: SQLite + sqlite-vec (FTS5-Fallback wenn vec nicht lädt),
    Schema-Migration, Chunk-Replace-Transactions
  - `chunking.ts`: Markdown → Paragraph-Chunks mit Overlap, Frontmatter-Strip
  - `embeddings.ts`: Provider-Abstraktion. Default `local` via
    `@huggingface/transformers` (`Xenova/all-MiniLM-L6-v2`, 384-dim,
    ~30MB First-Run-Download). Aliases für gemma + mpnet vorbereitet
  - `retrieval.ts`: Hybrid Vector+BM25 mit Min-Max-Norm-Fusion, FTS5-
    Sanitization
  - `watcher.ts`: chokidar mit per-Pfad-Debounce (1500ms default)
  - `manager.ts`: per-Agent Public-API (search/list/get/write/delete +
    reindex on file change)
  - `registry.ts`: process-wide Manager-Cache mit lazy init, agent.yaml
    obsidian-Konfig wird hier eingelesen
  - `inject.ts`: Auto-Inject-Block-Builder, Token-Cap, `<memory-context>`-
    Wrapper mit Hinweis-Header
- **Auto-Inject in `chat/send` aktiv:** Server augmentiert pro Turn den
  systemPrompt mit Recall-Block. Nicht-persistierend (JSONL bleibt
  unangetastet)
- **Smoke-Test grün:** „italienisches Auto" findet Fiat-Note (Synonym),
  „Versicherung" findet sie via BM25-Boost. End-to-end Embed→Index→
  Hybrid-Search funktioniert

**Steht als nächstes an (Phase 2-Stufe-B Abschluss):**
1. Memory-Tools für Hans (`memory_search`, `memory_get`, `memory_write`,
   `memory_edit`, `memory_delete`, `memory_list`)
2. Lokaler MCP-Server, Hookup in claude-cli + codex-cli
3. Obsidian-Integration end-to-end testen (Konfig wird schon gelesen,
   aber kein Vault gegen-getestet)
4. Eventuelles `obsidian_write`-Tool für selektives Schreiben

---

## Phase 2-Stufe-B + C Abschluss (2026-05-01 mittags)

Stufe B + C vollständig durch:

- **Memory-Tools** gebaut + via MCP-Server in claude-cli und codex-cli
  hookt — sechs granulare Tools (DECISION #31), source-agnostic Read,
  source-spezifischer Write
- **MCP-Server** als spawned Child-Prozess pro CLI-Turn, Pino-Logger
  schreibt nur in File (Phase 2j.5 fix), `default_tools_approval_mode
  = "approve"` für non-interactive auto-approve auf codex-Seite
  (Phase 2j.6 fix)
- **codex-cli Built-In-Tools deaktiviert** (DECISION #23) — shell, exec,
  browser, JS, image-gen, web-search etc. abgeschaltet, nur somora-memory
  als Tool-Surface
- **Obsidian-Vault end-to-end** getestet gegen `/mnt/naxon/obsidian`
  (48 Files), `readOnlyPaths` für `Infrastruktur` markiert (Phase 2g)
- **Ephemeral Context Refactor** (Phase 2j.1) — TurnInput hat jetzt
  `systemPrompt` (stable, cacheable) + `ephemeralContext` (per-turn).
  Behebt den codex-resume-Bug wo Memory-Block nach Turn 1 droppte
- **Phase 2-Stufe-C: Agent-Loop für openai-compatible** (Phase 2k):
  TurnInput.tools, openai-compatible-Engine erkennt `tool_calls` aus
  dem Stream, dispatched via in-process ToolRegistry, max 8 Rounds.
  Damit Hans-auf-gemma vollständig — kann jetzt aktiv `memory_*`
  callen genau wie Hans-auf-opus / Hans-auf-gpt55.

**Drei-Engine-Parität auf Tool-Level:**

| Engine | Tool-Surface |
|---|---|
| claude-cli | MCP-Server via SDK, `canUseTool` Allowlist `mcp__somora-memory__*` |
| codex-cli | MCP-Server via `-c` TOML, `default_tools_approval_mode="approve"`, alle Built-ins disabled |
| openai-compatible | In-process Agent-Loop, OpenAI-Tools-API, max 8 Rounds, Tool-Calls direkt durch ToolRegistry |

CLI rendert `[memory · …]` (Auto-Inject), `[tool call · …]` und
`[tool result · …]` einheitlich für alle drei.

**Was als nächstes ansteht:**
- **Phase 2-Stufe-D — Dream-Mode**. Konzept in FUTURE.md fest. Liest
  JSONL-Delta seit letztem Marker, extrahiert Memory-würdiges Material,
  hinterlegt Findings. User-Approval-Loop danach. Adressiert die
  „Memory-Verlust bei interner Compaction der CLIs"-Sorge ohne dass wir
  Compaction zurücknehmen müssen.
- **Obsidian-Wikilink-Awareness** (FUTURE.md) — Wikilinks beim Chunking
  extrahieren, Recall-Expansion über verlinkte Notes.
- **`obsidian_write`-Tool** — explizites User-getriggertes Schreiben in
  den Vault, respektiert `readOnlyPaths`.

### Was funktioniert

- **Server** (Hono auf 18737, SSE) — `src/server/index.ts`
- **CLI** mit Slash-Commands — `src/cli/index.ts`
- **Engine-Layer** mit drei Adaptern:
  - `claude-cli` — Anthropic via Claude-Code-Subscription, Token-Streaming via
    `includePartialMessages`, 4-Schicht-Defense gegen Account-MCP-Leak
  - `codex-cli` — OpenAI via ChatGPT-Subscription (Pro/Plus/Business), Subprozess
    `codex exec --json` mit NDJSON-Event-Parser, `codex exec resume <thread_id>`
    für Folge-Turns
  - `openai-compatible` — `chat.completions` gegen jede BaseUrl, getestet
    gegen `omlx`-Server mit Gemma-Modellen
- **Provider/Model/Alias-System** — `src/config/types.ts`, `src/config/loader.ts`
  - YAML-Config in `~/.somora/config.yaml`, `config.example.yaml` als Repo-Doku
  - Pro Modell: `contextWindow`, `capabilities` (text/image), optional `alias`
  - Aliases sind global eindeutig — Config-Load failt sonst klar
- **Persona-System** — AGENTS.md/SOUL.md/USER.md pro Agent in
  `~/.somora/agents/<name>/`, Frontmatter mit `model:` und `fallback:`
- **Sessions** — `<YYYYMMDD-HHMMSS>_<slug>.jsonl` + `*.meta.json` companion;
  `main` als magic always-present-name. Meta-File hält additiv:
  `engine`, `sdkSessionId` (claude-cli), `codexSessionId` (codex-cli),
  `modelOverride`, `engineLastSeen[]`, `compactions[]`
- **Cross-Engine-Continuity** — jede CLI-Engine reaktiviert ihre eigene
  interne Session immer (durch `sdkSessionId`/`codexSessionId`); Lücken
  durch andere Engines werden via Delta-Replay als Markdown-Kontext-
  Block vor der user-message nachgeschüttelt. Replay ist
  compaction-aware: bei langer Lücke kommt Summary statt vieler Pairs
- **Compaction** für `openai-compatible` (DECISION #21 + #21a):
  - Pre-turn-check ab 80% des aktuellen Modell-Windows (configurierbar
    via `SOMORA_COMPACTION_TRIGGER_RATIO`)
  - Non-destructive: JSONL bleibt unangetastet, `compactions[]`-Array
    im Meta wächst stapelbar
  - 5-Sektion-Summary-Template (Goal/Constraints/Decisions/Recent/Open)
  - Worker-Modell **dynamisch gewählt**: kleinstes konfiguriertes Modell
    dessen Window die History fasst (estimate × 1.3 Headroom). Engine-
    agnostic — claude-cli/codex-cli/openai-compatible-Modelle alle
    valide. Override per `SOMORA_COMPACTION_MODEL` env (alias oder
    `provider/modelId`)
  - Safety-Cushion: konfigurierbar via `SOMORA_COMPACTION_SAFETY_PAIRS`
    (default 4), behält die N jüngsten Pairs unkomprimiert
  - Map-Reduce für Histories die selbst das größte Modell sprengen
    würden ist NICHT implementiert — fail mit klarer Meldung
- **Token-Counting konsistent** — alle drei Engines reporten `tokens_in`
  als TOTAL Context-Tokens (cached + uncached) damit das `X/window`-
  Display ehrlich ist
- **CLI-Polish** — Token/Context-Display im Prompt: `[hans:main · 12k/1000k · ↓42]>`
- **Fallback-Logik** — wenn primary vor Output failt → `persona.fallback`
- **Logging** — Pino, daily JSONL, Pretty-TTY mit `singleLine`. Wichtige
  Compaction-Events: `engine.compaction_trigger`, `compaction.worker_chosen`,
  `engine.compaction_done`, `engine.replay`

### Slash-Commands im CLI (aktuell)

```
/help, /quit, /exit
/agents                          list agents
/agent <name> [session]          switch agent
/sessions                        list sessions of current agent
/session <slug-or-id>            switch session (slug → newest match)
/new <slug>                      create new session, switch into it
/main                            back to current agent's main
/reset                           preview reset of current session
/reset YES                       archive current session, start fresh
                                 (auto-spawns dream if dream.enabled)
/models                          all configured models with aliases
/model                           current effective model + source
/model <alias-or-ref>            override for this session
/model default                   clear override
```

### HTTP-API (aktuell)

```
GET  /healthz
GET  /env                                          effective env vars
GET  /agents
GET  /tools                                        tool catalog incl. dream_*
POST /agents/:agent/tools/:name                    invoke tool directly (debug)
GET  /agents/:agent/sessions
POST /agents/:agent/sessions                       { slug }
POST /agents/:agent/sessions/:session/reset        archive + reset, spawn dream
GET  /agents/:agent/memory/notes                   indexed memory list
GET  /agents/:agent/memory/search?q=…              hybrid recall debug
GET  /chat/history?agent=&session=
GET  /chat/stream?agent=&session=                  (SSE incl. memory + tool events)
POST /chat/send                                    { agent, session, text }
GET  /models
GET  /agents/:agent/sessions/:session/model
PUT  /agents/:agent/sessions/:session/model        { model }
DELETE /agents/:agent/sessions/:session/model
```

---

## Env-Variablen (kanonische Liste)

Alle `SOMORA_*`-Env-Vars im laufenden Server. Default-Werte werden
benutzt wenn die Var unset ist oder ihr Wert ungültig ist.

| Var | Default | Zweck |
|---|---|---|
| `SOMORA_HOME` | `~/.somora` | Root für config/sessions/logs/agents |
| `SOMORA_PORT` | aus `config.yaml` (`server.port`, default 18737) | Server-Port (Override für beide Seiten) |
| `SOMORA_HOST` | `127.0.0.1` | Connect-Host der CLI (server-side ignoriert) |
| `SOMORA_LOG_LEVEL` | `info` | Pino-Log-Level (`debug`, `info`, `warn`, `error`) |
| `SOMORA_CLAUDE_BIN` | `~/.local/bin/claude` falls vorhanden, sonst Anthropic-SDK-Default | Claude-CLI Binary-Pfad |
| `SOMORA_CODEX_BIN` | `~/.npm-global/bin/codex` falls vorhanden, sonst `codex` (PATH) | Codex-CLI Binary-Pfad |
| `SOMORA_COMPACTION_TRIGGER_RATIO` | `0.8` | Trigger-Schwelle als Anteil des aktuellen Modell-Windows (0..1) |
| `SOMORA_COMPACTION_SAFETY_PAIRS` | `4` | Anzahl jüngster Pairs die unkomprimiert bleiben |
| `SOMORA_COMPACTION_MODEL` | _unset_ → Auto-Pick (kleinstes passendes) | Override für Compaction-Worker (Alias oder `provider/modelId`). Wenn unauflösbar: Warning + Auto-Pick-Fallback. |

### Live abrufen

- **Beim Server-Start:** Log-Event `somora.env` mit allen effektiven
  Werten (in `~/.somora/logs/server-YYYY-MM-DD.log`).
- **Während des Betriebs:** `GET http://127.0.0.1:18737/env` —
  liefert dasselbe als JSON inklusive `isDefault`-Flag und ggf.
  `note` (z.B. „filesystem-fallback").

Beide nutzen denselben `getEffectiveEnv()`-Helper aus
`src/server/env.ts`. Wenn ein neuer SOMORA_*-env dazukommt: bitte dort
eintragen, sonst taucht er nicht im Log/Endpoint auf.

## Was bewusst NICHT da ist

- **Memory-Layer-Implementation** — Konzept ist 2026-05-01 abgesegnet
  (siehe DECISIONS #25–#28), Bau läuft als Phase-2-Stufe-B. Storage
  (Markdown + sqlite-vec), Embeddings (lokal via node-llama-cpp),
  Auto-Inject (Hermes-style, Runtime nicht Agent), Memory-Tools,
  Obsidian-Vault als optionale Read-Source — alles entschieden,
  nicht gebaut.
- **Agent-Loop für `openai-compatible`** — Phase-2-Stufe-C, kommt
  direkt nach Memory. Sodass openai-compatible Memory-Tools + andere
  Tools genauso aufrufen kann wie claude-cli/codex-cli es eingebaut
  haben. Siehe FUTURE.md.
- **Dream-Mode** — Phase-2-Stufe-D oder später. Konzept in FUTURE.md
  fixiert: Read-Only-Träumer findet Inkonsistenzen Memory ↔ Sessions
  ↔ Vault, hinterlässt Findings, User+Hans approven manuell. KEIN
  Auto-Promotion à la OpenClaw.
- **Eigenes Tool-System** — Memory-Tools sind der Anfang davon.
  Allgemeines Tool-System mit Allowlist pro Agent, MCP-Hookup, etc.
  baut darauf auf in späteren Phasen.
- **Map-Reduce-Compaction** — Phase 3, falls je benötigt. Wird erst
  relevant wenn das größte konfigurierte Modell (typisch Opus 1M) als
  Compaction-Worker nicht mehr reicht.
- **Voice / Realtime** — Phase 3.
- **Telegram-Channel** — Phase 3.

### Delta `openai-compatible` ↔ `claude-cli`

Der claude-cli-Subprozess macht intern viel, was wir beim
`openai-compatible`-Engine selbst bauen müssen. Das ist die
Konsequenz aus DECISION „classic openai-sdk statt @openai/agents".

| # | Delta | Status |
|---|---|---|
| 1 | **Agent-Loop** (tool_call → tool_result → model, bis Stop) | nicht da; kommt mit Tool-Phase |
| 2 | **Compaction** (History kürzen vor Context-Limit) | Strategie entschieden (OpenCode-style, siehe unten); zu bauen |
| 3 | **Tool-Definitionen & -Execution** + MCP-Bridge | nicht da |
| 4 | **Multimodal / Image-Routing** (vision-content-blocks) | `capabilities.image` im Schema, Adapter ignoriert es |
| 5 | **Token-Counting-Genauigkeit** | Heuristik (4 chars/token) statt exakter Counts |
| 6 | **Retry / Error-Recovery mid-stream** | keine; fallback greift nur _vor_ erstem Output |
| 7 | **Thinking / Reasoning-Block-Trennung** | alles wird zu plain content verschmolzen |
| 8 | **Prompt-Caching** | nicht genutzt (weder Anthropic-cache_control noch OpenAI-Prefix) |
| 9 | **Sampling-Params** (temp, top_p, stop, seed) | nur `max_tokens` im Config-Schema |

Punkte 1+3 sind die strukturellen Deltas, die untrennbar zur Tool-Phase
gehören. Punkt 2 (Compaction) ist Vor-Tool-Arbeit. 4–9 sind Polish.

---

## Phase-2-Plan (ab 2026-04-30 entschieden)

Reihenfolge bewusst seriell, um vor Memory+Tools eine ehrliche
Drei-Engine-Parität zu haben:

1. **`codex-cli` Engine** — dritte Engine, Subprozess-Adapter analog
   `claude-cli.ts`. Nutzt OpenAI ChatGPT-Subscription (Rene hat Pro-Sub
   à 200 €). `codex` v0.125.0 lokal vorhanden, eingeloggt via ChatGPT.
   Bekommt Loop/Compaction/Tools _intern_ vom Codex-CLI geschenkt
   (analog claude-cli).
2. **Compaction für `openai-compatible`** — siehe Strategie unten.
3. **Smoke-Test** aller drei Engines auf Konversations-Parität.
4. **Memory-Schicht** — Renes Spezialwünsche, Diskussion zuerst.
5. **Tool-System** — bringt automatisch Agent-Loop für openai-compatible
   und MCP-Bridge zu den CLI-Engines. Eigene Tools (z.B. `somora_exec`,
   `somora_memory_*`) als Source-of-Truth in `src/tools/registry.ts`,
   exponiert als MCP-Server für claude-cli/codex-cli, direkt
   konsumiert in openai-compatible. Built-in-Tools der CLIs werden
   wo möglich deaktiviert, damit Verhalten engine-übergreifend
   einheitlich ist.

### Compaction-Strategie für `openai-compatible`

OpenCode-style, **non-destructive**. Begründung: passt zur
JSONL-Sessions-as-Ground-Truth-Philosophie; Codex-style
all-or-nothing wäre destruktiv, Claude-Codes 3-Stufen-System
über-engineered für jetzt.

- **Trigger:** ab ~70% Context-Fill warnen, ab ~80–85% compact
  ausführen (genauer Schwellwert per Config).
- **Marker im Meta-File**, nicht im JSONL. Append-only-Property
  des JSONLs bleibt erhalten.
- **Range-Marker:** `throughTs` (Timestamp) als Range-Ende. Events
  mit `ts <= throughTs` werden beim `buildMessages` ignoriert,
  stattdessen wird die Summary als pseudo-system-message eingefügt.
- **Summary-Template:** strukturierte 5-Sektion-Form (Goal,
  Constraints, Decisions, Recent Context, Open Questions) — Pflicht
  zum direct-quote wo möglich (Claude-Code-Inspiration).
- **Safety-Cushion:** letzte N Turns / letzte X Tokens immer
  unangetastet (auch wenn sie technisch in Range fallen würden).
- **Stapelbar:** mehrere Compactions im Array; neue umfasst alte.
- **Engine-übergreifend gültig:** wenn openai-compatible compactet,
  sieht auch claude-cli/codex-cli die compactete History beim
  Engine-Wechsel. Doppel-Compaction (unsere + interne der CLIs) ist
  positiv (Sicherheitsnetz), solange unsere früh genug greift.

### Meta-File-Schema (erweitert)

Bestehende Felder (`engine`, `sdkSessionId`, `modelOverride`)
bleiben unangetastet. Additiv kommen dazu:

```json
{
  "engine": "openai-compatible",
  "sdkSessionId": "abc-123",        // claude-cli, wenn aktiv
  "codexSessionId": "uuid-xyz",     // NEU: codex-cli thread_id
  "modelOverride": "gemma-3-12b",
  "compactions": [                   // NEU: stapelbar
    {
      "ts": 1738239850000,
      "throughTs": 1738239847123,
      "summary": "…",
      "byEngine": "openai-compatible",
      "byModel": "gemma-3-12b",
      "tokensBefore": 78000,
      "tokensAfter": 12000
    }
  ],
  "memory": { /* Phase 2.4, später */ }
}
```

Pattern: rohe Wahrheit im JSONL, abgeleitete Sichten und
Pointer im Meta-File. Skaliert auf Memory.

### Codex-CLI: Event-Format und Aufruf-Pattern

```bash
# Erster Turn:
echo "<prompt>" | codex exec --json --skip-git-repo-check \
  --sandbox read-only -m <model> -

# Folge-Turn:
echo "<prompt>" | codex exec resume <thread_id> --json \
  --skip-git-repo-check --sandbox read-only -m <model> -
```

NDJSON-Events, die wir mappen:
- `thread.started` `{thread_id}` → `codexSessionId` ins Meta
- `turn.started` → `NormalizedEvent.turn_start`
- `item.completed` mit `item.type: "agent_message"` → `assistant_message`
- `item.completed` mit `tool_use`/`tool_result` (Schema TBD) → `tool_call`/`tool_result`
- `turn.completed` mit `usage` → `turn_end`

Streaming-Deltas: bestätigt durch Smoke-Test 2026-04-30 — `codex exec
--json` liefert _keine_ Token-by-Token-Deltas wie `claude-cli`. Pro
Turn ein einziges `item.completed` mit dem fertigen `agent_message`.
Im somora-CLI sieht der User dadurch eine Pause und dann die volle
Antwort (statt Typing-Effekt). Keine Funktionsregression — nur UX.

### Codex-CLI Smoke-Test (2026-04-30, commit pending)

✅ Engine geladen aus Registry (`engine: codex-cli`)
✅ `gpt-5.5` als Default-Model (gpt-5/gpt-5-codex sind via
   ChatGPT-Account _nicht_ erlaubt — Account-bound model list
   liegt in `~/.codex/models_cache.json`)
✅ Erster Turn: thread.started → Codex emit fertige `agent_message`,
   Token-Counts korrekt gemappt
✅ Resume-Turn (`codex exec resume <id>`): Context erhalten,
   Modell erinnerte sich an "27"
✅ `codexSessionId` und `engine` korrekt im Meta-File neben
   `modelOverride` und (potenziell vorhandener) `sdkSessionId`
✅ Fallback bei kaputtem Resume-Arg-Setup hat sauber gegriffen
   (claude-cli sprang ein, User-visible response durchgekommen)

**Fix während Smoke-Test:** `codex exec resume` akzeptiert
`--sandbox` _nicht_ (vererbt vom Original-Thread). Adapter
unterscheidet jetzt: fresh-exec → mit `--sandbox read-only`,
resume → ohne. Siehe `src/engine/codex-cli.ts`.

---

## Pickup für nächste Session

Erster Satz beim Wiedereinstieg sollte sein:
> „Phase 2-Stufe-B/C/D-MVP durch. Hans hat Memory (Read+Write via Tools),
> Vault-Anbindung, und Dream-Mode mit manuellem /reset-Trigger.
> Drei-Engine-Parität auf Tool- und Memory-Ebene. Sicherheits-Audit
> beider CLI-Engines komplett (Auto-Memory + AGENTS.md-Walk-Up
> geschlossen). Offen: AutoDreamWorker (Idle-Trigger), Phase 2-Stufe-D
> Phase B. Plus Obsidian-Wikilinks, obsidian_write, prompt-caching
> activation, Phase 3-Themen (Voice/Telegram)."

Falls die nächste Session direkt am AutoDreamWorker einsteigt: Design
steht in DECISIONS-Eintrag „Dream-Mode" + den Konversations-Notizen.
extract.ts unterstützt schon AbortSignal; nötig sind:
- per-Agent Idle-Tracker (resetten auf chat.send, fire nach idleMinutes)
- chat.send hooked → bestehenden Dream-AbortController abbrechen
- dreamReadThroughTs-Marker im SessionMeta
- Resume-Loop: paused-Dreams werden beim nächsten Idle re-ranned

Memory-Layer-Konzept (Kurzform, Details in DECISIONS #25–#28):

- Markdown auf Disk = Source-of-Truth (`memory/notes/<slug>.md`)
- SQLite + sqlite-vec als abgeleiteter Index (`memory.db`)
- Lokale Embeddings (`embeddinggemma-300m` via node-llama-cpp)
- Auto-Inject pro Turn (letzte 3 Turns als Query, Top-5, Score+Token-Cap)
- Tools: `memory_search`, `memory_get`, `memory_write`, `memory_edit`,
  `memory_delete`, `memory_list`
- MCP-Server für claude-cli/codex-cli; openai-compatible bekommt
  Direct-Bridge wenn Agent-Loop in Stufe-C gebaut ist
- Obsidian-Vault als optionale Read-Source pro Agent
  (`agent.yaml` → `obsidian.vault`, `obsidian.readOnlyPaths`),
  Schreiben nur über `obsidian_write` auf User-Aufforderung
- Pro-Agent `workspace`-Pfad in `agent.yaml` (für freie Files via Tools)

Vorgehen:
1. SQLite + sqlite-vec einbinden (Schema, File-Watcher, Re-Index)
2. Embeddings (node-llama-cpp + GGUF download), Chunking
3. Hybrid-Retrieval (Vector + FTS5)
4. Auto-Inject in Server-Turn-Pipeline
5. Memory-Tools + lokaler MCP-Server
6. claude-cli/codex-cli MCP-Hookup
7. Obsidian-Source-Indexer
8. STATUS-Update auf Stufe-B-Done

### Test-Sessions zum Aufräumen

Während Stufe A wurden mehrere Test-Sessions in
`~/.somora/agents/hans/sessions/` angelegt: `codex-smoke`,
`codex-smoke2`, `codex-resume`, `tokens-test`, `crossengine`,
`compaction-test`, `smartcompact`, `crossworker`, `codexworker`,
`codexworker2`. Können bei Gelegenheit per `rm` weg.

---

## Wichtige Repo-Dateien

- `DECISIONS.md` — alle 19 Architektur-Entscheidungen mit Begründung
- `CONTEXT.md` — Ursprungs-Diskussion aus Claude.ai (teilweise überholt:
  Name war damals offen — heute fix `somora`)
- `config.example.yaml` — Doku-Vorlage für `~/.somora/config.yaml`
- `src/{server,cli,engine,persona,storage,config,types}/` — Code-Module

## Lokale Dateien (nicht im Repo)

- `~/.somora/config.yaml` — Renes Provider-Config mit Keys
- `~/.somora/agents/hans/{AGENTS,SOUL,USER}.md` — Hans' Persona
- `~/.somora/agents/hans/sessions/*.jsonl` + `*.meta.json` — Konversationen
- `~/.somora/logs/server-YYYY-MM-DD.log` — Server-Logs

## Schnellstart

```bash
cd ~/Projects/naxon/somora

# Terminal A:
npm run dev:server

# Terminal B:
npm run dev:cli
```
