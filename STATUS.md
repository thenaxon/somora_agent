# somora — Status & Pickup-Point

Lebende Notiz für nahtlosen Wiedereinstieg in zukünftige Sessions.

---

## Wo wir stehen (Stand: 2026-05-01 spätabend — Phase 2-Stufe-B/C/D MVP komplett)

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
