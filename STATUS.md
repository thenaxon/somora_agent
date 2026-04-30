# somora — Status & Pickup-Point

Lebende Notiz für nahtlosen Wiedereinstieg in zukünftige Sessions.

---

## Wo wir stehen (Stand: 2026-05-01, commits `phase 2a/b/c`)

**Phase 1 + Phase 2-Stufe-A komplett.** Drei Engines im Gleichstand auf
Konversations- und Compaction-Ebene. System ist funktional benutzbar —
`npm run dev:server` + `npm run dev:cli` läuft, alle drei Engines
reden, Sessions persistieren, `/model`-Switching ist live, Compaction
greift automatisch + cross-engine.

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

### Slash-Commands im CLI

```
/help, /quit, /exit
/agents                          list agents
/agent <name> [session]          switch agent
/sessions                        list sessions of current agent
/session <slug-or-id>            switch session (slug → newest match)
/new <slug>                      create new session, switch into it
/main                            back to current agent's main
/models                          all configured models with aliases
/model                           current effective model + source
/model <alias-or-ref>            override for this session
/model default                   clear override
```

### HTTP-API

```
GET  /healthz
GET  /agents
GET  /agents/:agent/sessions
POST /agents/:agent/sessions                       { slug }
GET  /chat/history?agent=&session=
GET  /chat/stream?agent=&session=                  (SSE)
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

- **Memory-Layer** — Phase-2-Stufe-B (nächster Schritt). Rene hat
  Spezialwünsche, deshalb in der nächsten Session erst **diskutieren**,
  dann bauen. Mein erster Anlauf (Memory.md → System-Prompt) wurde
  verworfen.
- **Eigenes Tool-System** — Phase-2-Stufe-C, nach Memory. Definition,
  MCP-Hookup bei den CLI-Engines, Tool-Call-Loop beim OpenAI-Adapter,
  Allowlist pro Agent. Nichts davon existiert.
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
> „Wir stehen bei `phase 2c`. Drei-Engine-Parität ist durch:
> claude-cli, codex-cli, openai-compatible. Cross-Engine-Continuity
> via Session-Resume + Delta-Replay funktioniert. Compaction für
> openai-compatible ist da, mit dynamischer engine-agnostic
> Worker-Wahl. Du wolltest jetzt über die Memory-Schicht reden —
> du hast da Spezialwünsche. Ich hör erst zu, nicht vorbauen."

Wichtig: Memory ist bewusst noch unangerührt. Nicht spontan starten,
auch wenn Auto-Mode aktiv ist. Erst Renes Vorstellungen aufnehmen,
dann gemeinsam designen.

### Test-Sessions zum Aufräumen

Während Stufe A wurden mehrere Test-Sessions in
`~/.somora/agents/hans/sessions/` angelegt: `codex-smoke`,
`codex-smoke2`, `codex-resume`, `tokens-test`, `crossengine`,
`compaction-test`, `smartcompact`, `crossworker`. Können bei
Gelegenheit per `rm` weg.

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
