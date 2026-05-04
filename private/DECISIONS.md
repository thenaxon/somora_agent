# DECISIONS

Architektur-Entscheidungen für somora. Append-only — wenn was revidiert wird,
alten Eintrag mit `~~strikethrough~~` markieren und neuen drunter setzen.

---

## 2026-04-30 — Initial-Architektur

### 1. Projektname: `somora`
Final. Nicht „lobo", nicht „naxxen-*".

### 2. Stack
TypeScript / Node ≥20 / ESM. Hono für HTTP+SSE, Anthropic Agent SDK als Phase-1-Engine,
Zod, gray-matter, js-yaml, Pino. Build mit `tsx` (kein Compile-Step für Dev).

### 3. Auth: Subscription via Claude Code, Fallback API-Key
Test auf Naxon-VM bestätigte: SDK redet ohne `ANTHROPIC_API_KEY` gegen Subscription-Pool.
Falls Anthropic das technisch unterbindet, `ANTHROPIC_API_KEY` setzen — kein Code-Change.

### 4. SDKs werden gewrappt, nicht gepatcht
Engine-Adapter nutzt nur public SDK-API. Eigene Logik (Persona, Memory, NormalizedEvents,
Persistenz) lebt außerhalb des SDKs. `npm update` darf nie zu Patch-Verlust führen.

### 5. Architektur: Server-Prozess + getrennter CLI-Client, HTTP+SSE als Transport
Server lauscht auf `127.0.0.1:18737`. CLI redet via `POST /chat/send` und liest
`GET /chat/stream` als SSE. Ein Transport für CLI heute, orbit und weitere Webclients später.

### 6. somora als ein Gateway, Agents intern enumeriert
orbit (und andere Clients) registrieren *einen* somora-Gateway. Server liefert
Agent-Liste über `GET /agents`. Routen tragen Agent+Session als Body/Query, nicht im Pfad.

### 7. Persona-Layout: AGENT-Dreiklang (aus OpenClaw übernommen)
Pro Agent ein Ordner `~/.somora/agents/<name>/` mit `AGENTS.md` (Regeln/Verhalten),
`SOUL.md` (Persönlichkeit), `USER.md` (was Agent über Rene weiß). Beim Start in
System-Prompt zusammengesetzt. Ermöglicht `cp -r` von OpenClaw-Agents.

### 8. Heimat-Verzeichnis: `~/.somora/`
Default. Override per `SOMORA_HOME`-env. Gateway ist User-Service, nicht Pro-Repo.

### 9. Multi-Agent ist Architektur-Pflicht
Erste Tests mit einem Agent, aber Server/Routen/Storage müssen mehrere Agents nativ
tragen. Kein „single-agent jetzt, multi später".

### 10. Engine-Pattern: stateless
Engine bekommt pro Turn: `{persona, history, userMessage, tools}`. Liefert
`AsyncIterable<NormalizedEvent>`. Kein interner State. History/Memory/Persistenz
liegen außerhalb. Voraussetzung für späteren Multi-Engine-Betrieb (OpenAI, ADK, …).

### 11. NormalizedEvent als Lingua Franca
Eigenes Event-Format, engine-agnostisch, append-only als JSONL pro Session.
Event-Types: `user_message`, `assistant_delta`, `assistant_message`,
`tool_call`, `tool_result`, `turn_start`, `turn_end`, `error`.
Jedes Event mit `ts`, `engine`, optional `raw` (Debug).

### 12. SSE-Schema orbit-kompatibel
Stream-Events am OpenClaw-Pattern orientiert: `chat` (state delta|final),
`agent` (phase start|end), `tool` (phase call|result), `status`.
**Deltas sind kumulativ** (jeder Delta enthält den gesamten bisherigen Text).

### 13. Sessions: pro Agent, ewig, `main` als magic name
Jeder Agent hat eigene Sessions. `main.jsonl` existiert automatisch, kann nicht
gelöscht werden. Zusätzliche Sessions: `YYYYMMDD-HHMMSS_<slug>.jsonl`, permanent.
Slug allein adressiert die neueste mit dem Namen; ältere über Datum-Suffix.

### 14. Server-Config: ein YAML-File
`~/.somora/config.yaml` enthält Server-Setup (Port, Default-Modell, Pfade).
Splittbar in `configuration/`-Verzeichnis falls zu groß.

### 15. Port-Default: 18737
Frei auf Naxon-VM (OpenClaw belegt 18789). In `config.yaml` änderbar.

### 16. Server-Logging: Pino, Hybrid, daily
Server-Operations-Logs (Lifecycle, HTTP, Engine-Calls, Token-Verbrauch) als JSON-Lines
in `~/.somora/logs/server-YYYY-MM-DD.log`. Pretty-Print im Terminal wenn TTY.
Daily-Rotation, Cleanup manuell. **Kein** Conversation-Inhalt im Server-Log
(liegt in `agents/<name>/sessions/`). Levels über `SOMORA_LOG_LEVEL`-env.

### 19. OpenAI-Engine: klassisches `openai`-SDK, nicht `@openai/agents`
Für die zweite Engine wird das **klassische `openai`-SDK** verwendet
(`chat.completions.create`), nicht `@openai/agents`. Grund: das Agents SDK
setzt OpenAI's Assistants-API mit serverseitigen Threads voraus, die nur in
OpenAI's Cloud existieren. Renes interner LLM-Server (Ollama/vLLM-Stil mit
OpenAI-Kompatibilität) spricht nur `/v1/chat/completions` — die klassische
stateless-API. Das Agents SDK würde dort nicht funktionieren.

**Konsequenz:** asymmetrische Engines.

| | Anthropic | OpenAI |
|---|---|---|
| SDK | Agent SDK (high-level) | klassisches openai (low-level) |
| Compaction | SDK intern | nicht eingebaut |
| History | resume + sdkSessionId (SDK-internal JSONL) | wir, jeder Turn alle messages |

Das passt sogar besser zu DECISION #10 (stateless engine) — bei OpenAI ist
unser Interface natürlich, bei Anthropic mussten wir tricksen.

**Wie wir mit fehlender Compaction umgehen:**
- Anfangs: gar nicht. Wenn Context-Fenster knallt, Error → User macht `/new`.
- Mittelfristig: Memory-Schicht (Phase 2) löst das strukturell — wichtige
  Fakten leben in MEMORY.md, Konversation darf vergessen.
- Notfall-Fallback (falls vor Memory-Schicht nötig): einfache lokale
  Compaction (älteste Turns durch Summary ersetzen) — weglassen bis nötig.

**Asymmetrie ist okay**, war so im CONTEXT.md vorgesehen
(„OpenAI Agents SDK … asymmetrisch genutzt, nicht gleichberechtigt").

### 18. Phase-2-Reihenfolge: zweite Engine vor Memory & Tools
Nach Phase 1 (CLI-Polish + dann fertig) **erst die OpenAI-Engine** als zweiten
Adapter bauen — angebunden an Renes internen LLM-Server (OpenAI-kompatibler
Endpoint). Beide Engines auf Gleichstand bringen. **Danach** Model-Config
(per-Agent Engine- und Modell-Wahl). **Erst dann** Memory-Schicht und eigene
Tools.

**Why:** Memory und Tools nur auf Anthropic zu bauen würde das Engine-Interface
zur Lüge machen — Anthropic-spezifische Annahmen würden in die Memory-/Tool-
Schicht leaken. Sobald OpenAI dazukommt, müsste das nachträglich entkoppelt
werden. Zwei lebende Engines vor Memory/Tools = die Abstraktion wird ehrlich
gehärtet, bevor wir Schichten draufsetzen die sie voraussetzen.

**How to apply:** CLI-Polish als nächster Schritt; dann OpenAI-Adapter (mit
konfigurierbarer Base-URL für Renes internen LLM-Server); dann Model-Config;
dann Phase 2 (Memory + Tools).

### 17. SDK-Defaults aus — Vier-Schichten-Defense
`settingSources: []` allein reicht **nicht**. Das Claude-Code-Binary bringt die
User-claude.ai-MCPs (Gmail/Drive/Calendar) auch ohne File-Settings mit, weil die
aus dem Account-Profil kommen — nicht aus settings-files. Bei jedem `query()`-Call
deshalb:

- `settingSources: []` — keine User/Project/Local-Settings-Files
- `tools: []` — keine Built-ins (Bash/Edit/WebSearch/...)
- `disallowedTools: KNOWN_ACCOUNT_TOOLS` — die bekannten claude.ai-Connector-Tools
  hardcodiert blocken (siehe `src/engine/anthropic.ts`)
- `mcpServers: {}` — leere Map; schließt User-MCPs nicht aus (sie bleiben im
  Init-Header sichtbar), neutralisiert sie aber wenn keine Tools registriert sind
- `canUseTool: () => deny` — Safety-Net: jeder unbekannte Tool-Call wird denied

**Diagnose-Pflicht:** Im `engine.init`-Log werden `tools[]` und `mcp_servers[]`
geloggt. Wenn `tools.length > 0` → `engine.tools_leaked`-Warning;
wenn `mcp_servers.length > 0` → `engine.mcp_servers_leaked`-Warning.
So sieht man neue Leaks (z.B. neue claude.ai-Connectors) sofort statt sie still
mitlaufen zu lassen.

**Annahme die wir verworfen haben:** `allowedTools: []` als Whitelist nutzen.
Laut SDK-Doku ist `allowedTools` nur eine Auto-Approval-Liste (no-prompt),
kein Filter. `disallowedTools` ist das richtige Werkzeug zum Blocken.

---

## 2026-04-30 — Phase-2-Architektur

### 20. Drei Engines, klare Domain-Aufteilung
Phase 2 erweitert von zwei auf drei Engines. Keine ersetzt die andere,
jede deckt eine eigene Domain ab:

| Engine | Domain | Loop / Compaction / Tools | Auth |
|---|---|---|---|
| `claude-cli` | Anthropic-Modelle via Claude-Subscription | im CLI-Subprozess | Claude Max / Pro |
| `codex-cli` | OpenAI-Modelle via ChatGPT-Subscription | im CLI-Subprozess | ChatGPT Plus / Pro / Business |
| `openai-compatible` | alles andere — omlx, ollama, OpenRouter, Groq, Fireworks, _und_ api.openai.com mit reinem API-Key | **selbst gebaut** | API-Key pro Provider |

**Why:** Rene hat sowohl Claude-Sub als auch ChatGPT-Pro (200 €) und
will beide voll nutzen. `openai-compatible` ist nicht ersetzbar —
auch wer OpenAI-Modelle ohne ChatGPT-Sub nutzen will (CI, headless,
lokal) braucht den API-Key-Pfad. Lokale Modelle (omlx/ollama) sowieso.

**How to apply:** Phase-2-Reihenfolge: codex-cli zuerst (einfach,
analog claude-cli, schnell zur Drei-Engine-Parität auf
Konversationsebene), dann Compaction für openai-compatible (siehe
#21), dann Memory, dann Tools.

### 21. Compaction-Strategie: OpenCode-style, non-destructive
Für die `openai-compatible`-Engine bauen wir Compaction selbst,
weil dort kein Subprozess das übernimmt. Strategie nach Recherche
(Codex CLI vs. Claude Code vs. OpenCode, April 2026):

- **Pattern: OpenCode** — Marker statt Löschen. Originale bleiben
  im JSONL, ein `throughTs`-Marker im Meta-File definiert die
  Range; `buildMessages` ignoriert markierte Events und fügt
  stattdessen die Summary als pseudo-system-message ein.
- **Trigger: 70% warn, 80–85% compact** (configurable). Nicht 95%,
  damit doppelte Compaction (unsere + interne der CLI-Engines)
  nicht gleichzeitig feuert.
- **Summary: 5-Sektion-Template** — Goal, Constraints, Decisions,
  Recent Context, Open Questions. Direct-quote bevorzugt
  (Claude-Code-Inspiration).
- **Safety-Cushion:** letzte N Turns / X Tokens immer unangetastet.
- **Stapelbar:** Array von Compactions, jede umfasst alle vorherigen.
- **Engine-Modell:** dynamisch gewählt — siehe DECISION #21a.

**Why:** Codex-Style (all-or-nothing, verbatim-only-user) wäre
destruktiv und passt nicht zur JSONL-Ground-Truth-Philosophie
(DECISION #11). Claude-Code-3-Stufen-System ist über-engineered:
Tier 1 (Tool-Result-Trim) macht erst Sinn mit Tools, Prompt-Cache-
Reorder ist provider-spezifisch. OpenCode-Pattern passt nativ zu
unserem Append-only-JSONL-Layout.

**How to apply:** Compaction-Logik lebt in `src/compaction/`,
wird beim Turn-Build im openai-compatible-Adapter aufgerufen.
CLI-Engines respektieren den Marker bei der History-Übergabe;
ihre _interne_ Compaction läuft zusätzlich als Sicherheitsnetz.

### 21a. Compaction-Worker dynamisch wählen, Trigger am aktuellen Modell
Die naive Lösung „Trigger am kleinsten Modell-Window" verschenkt
große Modelle (Opus mit 1M würde wie ein 131k-Modell behandelt).
Sauberere Aufteilung:

- **Trigger** orientiert sich am **aktuellen Modell** des Turns.
  - Auf Opus chatten → Trigger erst bei 80% × 1M = 800k. Buffer voll genutzt.
  - Auf Gemma chatten → Trigger bei 80% × 131k = 105k. Gemmas Buffer.
  - Wechsel von Opus (mit 500k history) zu Gemma → openai-compatible's
    pre-turn-check sieht 500k vs Gemma's 105k → triggert sofort.
- **Compaction-Worker** ist NICHT zwingend dasselbe Modell wie der Turn.
  Wir wählen das _kleinste_ konfigurierte Modell, dessen Window die
  zu summarisierende History fasst (mit ~30% Headroom für
  Template-Overhead und Output).
  - Estimate 50k → Gemma (131k) reicht → wähle Gemma (günstig+schnell)
  - Estimate 200k → gpt-5.4-mini (400k codex-cli) als kleinstes passendes
  - Estimate 500k → opus (1M claude-cli)
  - Estimate 2M → kein Modell reicht → **Map-Reduce** (Phase 3, noch
    nicht implementiert; aktuell hard fail mit klarer Meldung)
- **`compactionModel`-Override** im Config kann diese Auto-Wahl überschreiben
  (für „immer Opus benutzen" o.ä.).

**Why:** Trigger und Worker haben verschiedene Constraints. Trigger
ist user-experience (wann lohnt sich Compaction). Worker ist
technisches Können (passt die History rein). Sie zu trennen erlaubt:
„Opus' großes Window voll nutzen UND beim Wechsel zu Gemma trotzdem
sauber compacten — durch das vorhandene große Modell."

**How to apply:** `pickCompactionModel(estimate, candidates, override)`
in `src/compaction/summarize.ts`. Iteriert über alle in der Config
konfigurierten `(provider, model)`-Paare, filtert auf Window-Fit, sortiert
aufsteigend nach Window, nimmt das kleinste. Engine-agnostic — kann
claude-cli- ODER codex-cli- ODER openai-compatible-Modelle wählen.

**Engine-Worker-Adapter:** für jede Engine eine separate
`summarizeVia<Engine>(model, systemPrompt, userPrompt)`-Funktion in
`src/compaction/summarize.ts`. Diese sind nicht-streaming, weil wir
nur den finalen Summary-Text wollen. Logging (`engine.compaction_done`)
nennt explizit `byEngine` und `byModel`, damit man im Betrieb sieht
wer den Job gemacht hat.

**Aktuelle Beschränkung:** Nur openai-compatible hat den pre-turn-check
implementiert. Das deckt das wichtigste Failure-Szenario („Wechsel zu
kleinem Window") ab, weil openai-compatible-Provider typisch die
kleinsten Windows haben (Gemma 131k, lokale Modelle). Wechsel von
großer History zu sonnet/haiku (claude-cli, 200k) wäre theoretisch
auch problematisch — fängt aktuell die Anthropic-SDK-interne
Compaction ODER der Fallback ab. Falls das in der Praxis bricht:
pre-turn-check auch in claude-cli/codex-cli ausrollen. Heute YAGNI.

### 22a. Cross-Engine-Continuity über Session-Resume + Delta-Replay
Die ursprüngliche Annahme im Phase-2-Plan — „beim Engine-Wechsel
verliert die neue Engine den Kontext, kann durch Memory-Layer später
gemildert werden" — war falsch und nie mit Rene besprochen.

Die richtige Lösung kombiniert beide Mechanismen:

- **Jede CLI-Engine reaktiviert ihre eigene interne Session immer**
  (claude-cli via `sdkSessionId`, codex-cli via `codexSessionId`),
  unabhängig davon welche Engine zuletzt aktiv war. Damit kennt
  sie alle Turns die _sie selbst_ gemacht hat.
- **Die Lücke (Turns die _andere_ Engines gemacht haben) wird als
  Delta-Replay nachgeschüttelt** — formatiert als Markdown-Block
  vor der eigentlichen User-Message, mit klarer Anweisung „nicht
  drauf antworten, ist nur Kontext".
- **`engineLastSeen[engine] = ts`** im Meta-File trackt pro Engine,
  bis wann sie zuletzt selbst aktiv war. Replay holt nur Turns mit
  `ts > engineLastSeen[engine]`.

**Why:** Token-effizienter als Full-History-Replay (interne Session
trägt den Großteil), und erhält die Erfahrung dass beim
Hin-und-her-Wechseln keine Konversation „verloren" geht.
`openai-compatible` braucht das nicht, weil es bei jedem Turn die
volle History sowieso einbaut.

**How to apply:** Logik in `src/engine/replay.ts`. Bei sehr langen
Sessions (1000+ Turns Lücke) wird der Replay durch Compaction
(siehe #21) automatisch auf Summary + frische Pairs verkürzt — der
gleiche Mechanismus dient zwei Zwecken: kürzere History fürs
Modell, kürzerer Replay für andere Engines.

### 22. Meta-File als shared container für engine-state und session-views
Das `*.meta.json` pro Session ist absichtlich ein offenes
`Record<string, unknown>` (siehe `src/engine/types.ts:7`). Mehrere
Engines und Subsysteme dürfen nebeneinander Felder reinschreiben,
ohne sich zu stören:

- `engine` — welche Engine zuletzt die Session betrieb
- `sdkSessionId` — claude-cli's interne Session-ID
- `codexSessionId` — codex-cli's `thread_id` (NEU, kommt mit DECISION #20)
- `modelOverride` — pro-Session Modell-Override (`/model` im CLI)
- `engineLastSeen` — Map `engine → ts` für Delta-Replay (NEU, DECISION #22a)
- `compactions[]` — non-destructive Marker + Summaries (NEU, DECISION #21)
- `memory` — reserviert für Phase-2.4-Memory-Schicht

**Why:** Append-only-JSONL als Wahrheit, abgeleitete Sichten und
Pointer im Meta. Reduziert Risiko (kein In-Place-Modify am
Event-Log), erlaubt mehrere Sichten parallel (Compaction-Index,
Memory-Pointer, Engine-State), und skaliert auf zukünftige
Use-Cases ohne Schema-Migration. Pattern direkt parallel zu
filesystem-DB-Trennung in klassischen Systemen.

**How to apply:** Beim Hinzufügen eines neuen Subsystems _nicht_
JSONL-Events erweitern, sondern ein neues Meta-Feld einführen.
Niemals JSONL-Zeilen modifizieren — nur appenden oder via
Marker im Meta logisch ausblenden.

### 23. Eigene Tools statt CLI-Built-ins (Phase 2.5)
Sobald Tool-System gebaut wird, bauen wir alle Tools selbst
(`somora_exec`, `somora_memory_*`, etc.) und deaktivieren — soweit
möglich — die Built-ins von claude-cli und codex-cli.

**Why:** Engine-übergreifend identisches Tool-Verhalten. Was
`somora_exec` tut, ist *eine* Codepath, *eine* Allowlist, *ein*
Audit-Log — egal ob Claude, GPT-5, Gemma oder Llama es aufruft.
Mit Built-ins parallel hätte jede Engine ihre eigene
Bash-Implementierung mit eigenem Sandbox-Verhalten und keinem
einheitlichen Audit.

**How to apply:** Tool-Registry in `src/tools/`, MCP-Server-Wrapper
für CLI-Engines, Direct-Call-Bridge für openai-compatible. Built-in
deaktivieren via:
- claude-cli: `--disallowedTools` für `Bash`, `Read`, `Write`, `Edit`, etc.
- codex-cli: `--sandbox read-only` + Tool-Disable wo möglich

**Caveat:** Manche Built-ins lassen sich nicht 100% stumm schalten.
Falls so ein Tool-Use-Event durchrutscht, im Adapter filtern.

### 24. Phase-2-Reihenfolge: codex-cli → compaction → memory → tools
Revidiert DECISION #18, weil dort nur zwei Engines geplant waren.
Aktuelle Reihenfolge:

1. `codex-cli`-Engine bauen (analog claude-cli)
2. Compaction für `openai-compatible` (siehe #21)
3. Smoke-Test alle drei Engines (Konversations-Parität)
4. Memory-Schicht designen + bauen (Renes Spezialwünsche, Diskussion zuerst)
5. Tool-System bauen (bringt automatisch Loop für openai-compatible
   und MCP-Bridge zu CLI-Engines)
6. Polish-Punkte 4–9 aus STATUS-Delta-Tabelle

**Why:** Memory vor Tools, weil Memory-Design entscheidet, ob
Memory ein Tool wird, eine Prompt-Injection oder beides. Tools
ohne Memory-Klarheit gebaut riskieren falsche Abstraktion.
Konversations-Parität vor Memory, damit Memory von Anfang an
über alle drei Engines konsistent funktioniert (nicht erst auf
einer und dann nachträglich entkoppelt).

**How to apply:** Schritte sind semi-seriell — innerhalb eines
Schritts können Polish-Sub-Tasks (z.B. exaktes Token-Counting)
parallel laufen. Aber kein Schritt-Vorziehen ohne Diskussion.

---

## 2026-05-01 — Memory-Layer + Config-Migration

### 25. Memory-Layer: Markdown-as-Source-of-Truth + SQLite/sqlite-vec-Index
Memory pro Agent unter `~/.somora/agents/<name>/memory/notes/<slug>.md`
als Markdown-Files mit Frontmatter (created/updated/tags). SQLite-DB
in `<agent-dir>/memory.db` als abgeleiteter Index — `files`/`chunks`
mit FTS5 + sqlite-vec-Vector-Spalte. SQLite ist jederzeit aus den
Markdown-Files rekonstruierbar.

**Inspiration:** OpenClaw (`openclaw/openclaw`) für Storage-Architektur,
Hermes (`NousResearch/hermes-agent`) für Auto-Inject-Mechanik.
Bewusst _ohne_ OpenClaws Komplexitäts-Aufschlag (kein Dreaming-Cron im
ersten Wurf, keine drei Backends parallel, keine 42k LOC).

**Why:** Markdown bleibt user-editierbar (`vim`, `git diff`,
versionierbar), Embeddings + FTS sind Implementierungs-Detail das wir
ändern können ohne User-Daten zu touchen. Bei Index-Korruption: rm
memory.db → automatischer Rebuild aus Markdown.

**How to apply:** Storage in `src/memory/`. File-Watcher (chokidar)
mit Debounce für Re-Index. Lokale Embeddings via `node-llama-cpp`
(default `embeddinggemma-300m`), Remote-Provider via Config-Schalter.

### 26. Auto-Inject by Runtime, nicht Agent-getriggert
Recall passiert **automatisch pro Turn** durch die Runtime, ohne dass
der Agent ein Tool callen muss. Query: letzte 3 Turns (configurierbar).
Hybrid-Retrieval (Vector + BM25, default 0.7/0.3). Top-N mit Score-
Schwelle und Token-Cap. Format: `<memory>...</memory>`-Block vor der
User-Message.

**Why:** Bei Tool-getriggertem Recall (OpenClaw-Modell) muss der Agent
den Reflex haben zu suchen. Vergisst er's → Memory unsichtbar. Mit
Auto-Inject ist relevanter Kontext per Default da. Agent kann
zusätzlich `memory_search` callen für gezielte Tiefe-Suche.

**How to apply:** In Server-Turn-Pipeline VOR `engine.runTurn`
einhängen. Runtime baut Query aus den letzten N Turns, fragt Memory-
Manager, prepended Block. Agent sieht das wie eine Pre-Message von
sich selbst, nicht wie ein Tool-Result.

### 27. Memory-Tools für Self-Edit
Hans braucht Tool-Zugriff auf sein Memory: `memory_search`,
`memory_get`, `memory_write`, `memory_edit`, `memory_delete`,
`memory_list`. File-basiert mit Slug-IDs (stable references).

**Why:** Auto-Inject deckt 80% ab, aber Hans muss aktiv schreiben können
(„merk dir: ich fahre jetzt einen Mercedes"), gezielt nachladen wenn
Auto-Inject was Wichtiges nicht gefunden hat („such mal alles zu
italienischen Autos"), und Inkonsistenzen aufräumen.

**How to apply:** Tool-Registry in `src/tools/registry.ts`. Exposed
als lokaler MCP-Server für claude-cli/codex-cli. Direct-Bridge für
openai-compatible kommt mit Agent-Loop in Phase 2-Stufe-C.

### 28. Obsidian-Vault als optionale Memory-Quelle (pro Agent)
`agent.yaml` bekommt optional einen `obsidian.vault`-Pfad plus
`obsidian.readOnlyPaths`-Liste. Bei aktiviertem Vault: dessen
Markdown-Files werden in dieselbe `memory.db` indiziert (mit
`source=vault` Tag). Auto-Inject + `memory_search` treffen beide
Quellen.

**Hans schreibt nicht automatisch in den Vault.** Vault ist primär
read-source für Recall. Schreiben passiert nur über separates
`obsidian_write`-Tool, auf explizite User-Aufforderung. Privacy-
Subpfade (z.B. `private/`) sind tabu zum Schreiben — Lese-Verhalten
optional konfigurierbar.

**Why:** Renes Vault enthält viel Wissen das Hans nutzen kann.
Aber: Vault ist User-Domäne, Hans soll nicht autonom darin
herumfuhrwerken. Saubere Trennung „Recall ja, Auto-Schreiben nein,
Schreiben nur wenn explizit gewünscht" hält den Vault unter
User-Kontrolle.

**How to apply:** Indexer hat `source`-aware-Modus. Embeddings
agnostisch ob Quelle eigenes Memory oder Vault. Tool-Surface
trennt: `memory_*` für eigenes Memory, `obsidian_*` für
Vault-Schreiben.

### 29. Workspace pro Agent (für Tool-Phase)
`agent.yaml` bekommt ein `workspace`-Feld. Wenn Hans später
Files anlegt die _nicht_ ins Memory gehören (Skripte, Code,
freie Notizen), landen sie hier. Default optional bei
`<agent-dir>/workspace/`, frei umlegbar.

**Why:** Drei Datenklassen sauber trennen: Memory (auto-managed),
Vault (User-Domäne, Recall-Quelle, selektiver Write), Workspace
(freie Files via Tool-Befehl). Vermeidet die OpenClaw-Variante
„alles in einem Ordner".

**How to apply:** Erst Tool-Phase. Jetzt nur ins Schema
aufnehmen, damit `agent.yaml`-Format stabil bleibt.

### 30. Config-File bevorzugt gegenüber Env-Vars
Tunables gehören standardmäßig in `config.yaml` (oder `agent.yaml`
für pro-Agent-Overrides), nicht als Env-Var. Existierende
`SOMORA_*`-Env-Vars werden bei Gelegenheit in entsprechende
config-Sektionen migriert, mit Env-Var als Override für
Container/CI-Use-Cases.

**Why:** Config-File ist transparenter — ein Ort, mit Kommentaren,
im Repo dokumentierbar via `config.example.yaml`. Verstreute Env-
Vars sind schwerer zu auditieren („was ist gerade gesetzt?").
Bestätigt mehrfach von Rene während Phase-2-B-Diskussion.

**How to apply:** Config-Schema mit `.optional().default(...)`,
Defaults im Code. Env als override layer obendrauf. Konkrete
Migration zuerst: `SOMORA_COMPACTION_*` → `compaction:`-Sektion.
Pure-Bootstrap-Werte (`SOMORA_HOME`, `SOMORA_PORT`) bleiben Env.

---

## 2026-05-01 — Memory-Tool-Architektur

### 31. Granulare Memory-Tools, Read source-agnostic, Write source-spezifisch
Konsumiert von claude-cli + codex-cli via MCP-Server (Phase 2-Stufe-B
Abschluss), später auch von openai-compatible über den Agent-Loop
(Phase 2-Stufe-C). Tool-Surface:

```
# Lesen — durchsucht / liest aus ALLEN konfigurierten Quellen
# (Hans' eigenes Memory + ggf. Obsidian-Vault).
memory_search(query, limit?, minScore?)
  → Hits mit `reference: "memory/<slug>" | "vault/<slug>"`,
    score, snippet, file_path

memory_get(reference)
  → reference ist EXAKT der String aus `memory_search`-Hit oder
    aus dem `<memory-context>`-Auto-Inject-Block.
    Liefert vollen Markdown-Inhalt + Frontmatter.

memory_list(filter?)
  → ÜBERSICHT eigener Memory-Notes (Slug, description, tags).
    Vault wird hier NICHT gelistet — der User kennt seinen Vault
    selbst, und er kann groß sein (nicht ungefragt
    in den Prompt schmeissen).

# Schreiben — operiert AUSSCHLIESSLICH auf Hans' eigenem Memory.
# Vault-Schreiben ist später über `obsidian_write` separat.
memory_write(slug, content, frontmatter?)
memory_edit(slug, content)
memory_delete(slug)
```

**Why granular statt combined-mit-Action-Enum (Hermes-Stil):**

- MCP-/JSON-Schema-Idiom: discriminated unions mit
  Action-abhängigen Required-Feldern sind Awkward. Granular = pro
  Tool ein klares, statisches Schema.
- Action-Shapes divergieren stark — `search` braucht Query +
  Score-Filter, `get` braucht reference, `write` braucht
  Slug+Content+Frontmatter. Keine sinnvolle Vereinheitlichung.
- Spätere Erweiterungen (z.B. `memory_link` für Wikilink-Awareness,
  siehe FUTURE.md) sind additiv ohne bestehende Schemas zu brechen.

**Why Read source-agnostic:**

- Auto-Inject zieht eh aus beiden Sources gleichzeitig. Wenn der
  Agent gezielt nachlädt, will er das _bestmögliche_ Wissen — egal
  ob aus eigenem Memory oder Vault. Source-Routing wäre Reibung
  ohne Mehrwert.
- Source-Tag im Recall-Treffer (`memory/...` vs `vault/...`) ist
  die Information die der Agent braucht. Mehr nicht.

**Why Write source-spezifisch:**

- `memory_write` zielt auf `~/.somora/agents/<name>/memory/` —
  Hans' eigenen, gefahrlosen Bereich.
- Vault ist User-Domäne (DECISION #28). Schreiben dort braucht
  klar abgegrenzten Tool-Namen mit anderer Intention/Risiko und
  respektiert `readOnlyPaths` aus `agent.yaml`.
- Trennung verhindert versehentliches Vault-Schreiben weil Hans
  „memory" gesagt hat.

**Reference-Format (Auto-Inject ↔ memory_get):**

Im `<memory-context>`-Block stehen Hits als `[memory/auto · score=0.71]`.
Der String `memory/auto` (vor dem `·`) ist die `reference` die der
Agent ans `memory_get`-Tool durchreichen kann. Vault-Hits analog:
`[vault/Infrastruktur--Blackcorner--Devices · score=0.82]`. Der Slug
für Vault-Files ist der Pfad relativ zum Vault-Root mit `/` zu
`--` ersetzt (siehe `slugFromPath` in `src/memory/manager.ts`).

**Was Hans NICHT kann (by design):**

- `memory_write` mit Vault-Pfad → Tool weigert sich, klare Fehler-Meldung
- `memory_delete` einer Vault-File → ebenso, nur über `obsidian_write` (zukünftig)
- Auto-Inject deaktivieren — das ist Runtime-Verhalten, nicht Agent-Belang

**Datenfluss (Big Picture):**

```
~/.somora/agents/hans/memory/*.md  ─┐
                                    │
/mnt/naxon/obsidian/**/*.md         ├──► chokidar Watcher ──► Re-Index
(wenn agent.yaml.obsidian.vault     │      ↓
 gesetzt; readOnlyPaths-Markierung) │   memory.db (SQLite + sqlite-vec + FTS5)
                                    │      ↑
                                    │      │
              ┌─────────────────────┴──────┘
              │
              ▼
    MemoryManager.search(query)  ──►  Hybrid Vector + BM25
              │
              ├──► Auto-Inject pro Turn (Runtime-driven, kein Tool-Call)
              │     └─ <memory-context>...</memory-context> in systemPrompt
              │
              └──► memory_search-Tool (Agent-driven, gezielt)
                   └─ Top-N Treffer mit reference, score, snippet

    MemoryManager.getNote(slug)   ──►  Memory-only (eigener Bereich)
    MemoryManager.writeNote(slug) ──►  Memory-only
    MemoryManager.deleteNote(...) ──►  Memory-only
    isVaultPathReadOnly(path)     ──►  für späteres obsidian_write-Tool
```

**How to apply:** Tool-Definitionen in `src/tools/memory/`, Handler
delegieren an `MemoryManager`-Methoden. MCP-Server in `src/tools/mcp/`
exposed sie via stdio für die CLI-Engines. JSON-Schema Tool-
Descriptions explizit machen dass `memory_write` _nicht_ in Vaults
schreibt — kleine Modelle (gemma) brauchen das.

---

## 2026-05-01 — Dream-Mode (Phase 2-Stufe-D)

### 32. Dream-Mode = Read-Only Findings + User-Approval-Loop
LLM-getriebene Memory-Konsolidierung. Worker liest JSONL-Delta einer
Session, vergleicht gegen aktuelles Memory + Vault, extrahiert
strukturierte **Findings**. Findings sind **konkrete Aktions-Vorschläge**
(memory_write/edit/delete/vault_hint mit slug + proposed_content +
reason), nicht freitext-Beobachtungen. Findings landen in
`~/.somora/agents/<name>/memory/.dreams/` — der Worker schreibt nichts
direkt ins Memory.

User-Approval-Loop: Hans listet Findings via Tools (`dream_list`,
`dream_get`), präsentiert sie dem User einzeln, bekommt ja/nein-
Entscheidungen, ruft `dream_apply` (führt die memory_*-Aktion aus)
oder `dream_dismiss` (markiert als abgelehnt). Nach Resolution aller
Findings wandert das Dream-File nach `.dreams/processed/`.

**Why:** Bei CLI-internen Compaction-Pfaden (claude-cli, codex-cli)
können Memory-würdige User-Aussagen verloren gehen. Wir brauchen
einen Mechanismus der orthogonal zur Compaction läuft, das JSONL als
Source-of-Truth nutzt (DECISION #22), und niemals automatisch
mutiert. Auto-Promotion à la OpenClaw ist riskant — Bad-Extracts
würden permanent ins Memory einsickern.

**How to apply:** `src/dream/` enthält Storage + Runner + Extract.
Findings-File-Format ist YAML-Frontmatter (DreamMeta inkl. Findings-
Array mit Per-Finding-Status) + Markdown-Body (human-readable
Audit). Atomic-Rename auf Status-Übergängen. Crash-Recovery beim
Server-Start (orphan running → paused/failed je nach Trigger-Typ).

### 33. Manual-Dream vs Auto-Dream — zwei Trigger, ein Worker
Manual-Dream wird via `/reset YES` ausgelöst, läuft synchron-im-Hintergrund
während User chattet, **kein Pause-Verhalten** (User-initiierte
Aktion mit beschränktem Scope = der Range einer einzelnen archivierten
Session). Auto-Dream wird nach Idle-Period (default 30 min, per Agent
konfigurierbar) automatisch ausgelöst, **pausiert hart bei jedem
chat.send** an den Agent, resumiert beim nächsten Idle-Window.

Beide nutzen denselben `runDream()`-Driver. Unterschied: AbortSignal
nur für Auto. Status-Lifecycle gleich.

**Why:** Manual ist User-Aktion mit klarem Erwartungs-Horizont — soll
durchlaufen. Auto ist opportunistisch — User darf nicht warten müssen
weil Hans träumt. Pause/Resume macht den Auto-Worker ressourcen-
schonend ohne ihn ineffektiv zu machen.

**How to apply:** Manual-Trigger via `/reset`-Endpoint nach Archive-
Rename. Auto-Trigger via per-Agent Idle-Tracker im Server-Prozess.
chat.send-Handler resettet den Timer + abortet ggf. einen laufenden
Dream-AbortController. dreamReadThroughTs-Marker im SessionMeta
trackt den letzten erfolgreich getraümten Bereich pro Session
(per-Session, nicht per-Agent — verschiedene Sessions haben
unabhängige Histories).

### 34. Findings = konkrete Aktionen, dream_apply ohne Kreativlogik
Jeder Finding hat:
- `action: "memory_write" | "memory_edit" | "memory_delete" | "vault_hint"`
- `slug` (Memory-Slug oder Vault-Slug)
- `proposed_content` für write/edit
- `current_excerpt` für edit/delete (Kontext-Anker)
- `reason` (Begründung mit User-Quote)
- `id` (1-basiert, sequenziell)
- `status: "pending" | "applied" | "dismissed"`

`dream_apply(dream_id, finding_id)` macht nichts „kreativ" — es ruft
einfach `memory_write/edit/delete` mit den vom Extractor vorgeschlagenen
Werten auf. So bleibt Apply deterministisch, debuggbar, und
verifizierbar.

vault_hint wird heute als No-Op verarbeitet (nur acknowledgement) —
das `obsidian_write`-Tool kommt später (FUTURE.md). Hint bleibt im
Findings-Array sichtbar als „User sollte selbst diese Vault-Note
aktualisieren".

**Why:** Wenn Apply selbst kreativ entscheiden müsste, wäre Memory-
Mutation indeterministisch und schwer zu auditieren. Trennung:
Extractor entscheidet WAS, Apply macht's nur. Plus: kleine Modelle
(gemma) machen weniger Fehler beim Apply weil sie nichts erfinden
müssen, sie geben nur ja/nein-Entscheidungen weiter.

**How to apply:** Schema-Validierung in `src/dream/extract.ts`
(`parseFindings`). Bad-Findings im Output werden gedroppt mit Warning,
gute Findings desselben Chunks überleben. Dedupe nach
`(action, slug)` — bei Duplikaten gewinnt das Finding mit dem
längsten `reason` (Proxy für „mehr Kontext").

### 35. Per-Agent Dream-Config in agent.yaml; Modell explizit, kein Fallback
```yaml
# ~/.somora/agents/<name>/agent.yaml
dream:
  enabled: true
  model: gemma4big          # required — keine implicite Fallback auf primary
  idleMinutes: 30
  chunkTokens: 50000
  chunkTimeoutMs: 120000
```

Wenn `enabled: true` aber `model:` fehlt, failt der Dream-Worker
explizit mit aussagekräftiger Fehlermeldung. Kein Fallback auf
Persona-Primary.

**Why:** Träumen kann lange Sessions in viele Tokens umsetzen — wenn
sich das aus Versehen auf opus oder gpt-5.5 stützen würde, würden
unbemerkt teure Worker-Calls anfallen. Bei subscription-Auth ist's
Rate-Limit-Druck, bei API-Key-Auth direktes Geld. Fail-loud zwingt
zur expliziten Wahl. Default lokal (gemma) ist die richtige
Konvention für Dream-Worker.

**How to apply:** Schema-Validation in
`src/persona/loader.ts:DreamConfigSchema`. Worker resolved Model via
`resolveDreamModel(config, dream.model)`, throw bei Resolve-Failure.
v1 verlangt `engine: openai-compatible` für den Worker — claude-cli/
codex-cli als Worker wäre möglich aber braucht andere Routing-Logik
(später).

### 36. Dream-Tool-Surface: granular, mit Self-Correction-Hooks
Vier Tools (DECISION #31 Style — granular, source-spezifisch):
- `dream_list({ include_processed? })` — Übersicht aller Dreams
- `dream_get(dream_id)` — vollständiger Inhalt + Findings
- `dream_apply(dream_id, finding_id)` — execute via memory_*
- `dream_dismiss(dream_id, finding_id?)` — reject finding (ohne id =
  ganzer Dream)

Auf Errors liefern apply/dismiss die VALID-IDs zurück im Error-Text,
plus den expliziten Hinweis „finding ids start at 1, not 0". Das
hilft kleinen Modellen (gemma) sich aus Argument-Halluzinationen zu
befreien — Phase 2l.5 nach Beobachtung dass gemma4big dream_apply
mit erfundenen IDs aufrief.

**Why:** Granulare Tools über discriminated-action-Unions ist gleich
gute MCP-Praxis wie bei Memory (DECISION #31). Self-Correction-Hooks
sind Defense-in-Depth gegen Tool-Argument-Confabulation. Tool-
Descriptions enden mit „IMPORTANT: pass dream_id and finding_id
EXACTLY as returned by dream_list / dream_get" — Bias gegen freie
Erfindung.

**How to apply:** Tools in `src/tools/dream/`, registriert in der
ToolRegistry alongside memoryTools(). MCP-Server in `src/mcp/server.ts`
exposed beide Bundles. openai-compatible konsumiert direct über
Agent-Loop (Phase 2-Stufe-C).

### 37. Tool-Call-Timeout: tool-aware statt globaler 30s-Race
Ein pauschaler `Promise.race([invoke, 30s])` um jeden Tool-Call (Phase
2k pragmatisch eingebaut) bricht jedes lang-blockierende Tool. Wir
adoptieren OpenClaws Pattern:

- Default 30s greift nur für Tools die nichts über sich aussagen.
- `ToolDefinition` hat `defaultTimeoutMs` (statisch), `timeoutFromInput
  (input)` (dynamisch, caller-driven), `maxTimeoutMs` (Hard-Cap).
- Engine resolved per Call: `timeoutFromInput?.(input) ?? defaultTimeoutMs
  ?? globalToolCallTimeoutMs`, dann clamp auf `maxTimeoutMs`.
- Lang-blockierende Tools (`subagent_result(wait_until_done)`) returnen
  bei Tool-internem Timeout `state: "pending"` + `hint`-Feld, statt
  `{ok:false}` oder Error. Pending ≠ Fehler.
- Outer-Buffer = inner + 2s (OpenClaws `agent.wait`-Konvention).

**Why:** Hans's Bug-Report 2026-05-04: `subagent_result(wait_until_done)`
wurde nach 30s gekillt obwohl Caller 60s+ wollte. Sub-Subs liefen
weiter, aber Sub-Hans verbrannte sein maxRounds-Budget mit Retry-Storm
auf Timeout-Errors. Strukturelles Problem: Engine-Race kennt Tool-
Semantik nicht. OpenClaws Lösung ist kein globaler Race + Tool-deklariert-
selbst — strukturell richtig.

**How to apply:** `src/tools/types.ts` Felder, `src/engine/openai-
compatible.ts` Resolver an der Tool-Race-Stelle. Per-Tool: setzen wenn
Worst-Case > 30s denkbar. Bei jedem neuen Tool die Frage stellen — Doku
in `docs/research/tool-architecture.md` Sektion 6.1. Tools heute mit
Timeout-Override: `subagent_result`, `spawn_subagent`, `spawn_subagents`.
Phase 6c (`agent_ask`) und Phase 5 (`exec`, `tmux_capture`) werden's
brauchen.

### 38. Pre-Build Research Convention — claude-code-source + OpenClaw + Hermes
Vor jeder neuen Build-Phase (oder jeder größeren Design-Diskussion)
**immer** zuerst die drei Referenz-Codebases prüfen, bevor wir
selbst Pseudocode oder Schemas schreiben:

1. `~/Projects/naxon/claude-code-source/` — Anthropic Claude Code-
   Source-Extract. Architektonisch am nächsten an somora (Tool-Loop,
   Skill-Layer, Permission-System, MCP-Integration).
2. `~/.npm-global/lib/node_modules/openclaw/dist/` — OpenClaw's
   bundled JS. Stark bei: Spawn/Sub-Agent-Patterns, Skill-vs-Tool-
   Trennung, withTimeout-Helper, Exec/Process-Management.
3. `docs/research/tool-architecture.md` — eigene 577-Zeilen-Synthese
   aus Hermes + OpenClaw. Immer zuerst lesen; wenn die Frage nicht
   beantwortet ist, dann die Live-Repos.

**Why:** Diese Konvention wurde 2026-05-05 zur Policy nach dem
Test-Tag 2026-05-04. DECISION #37 ist genau deshalb entstanden weil
wir nachträglich in OpenClaw nachgesehen haben und
`waitForAgentRun({timeoutMs})` mit Status-Tupel `ok|pending|timeout|
error` als bessere Alternative zu unserem `Promise.race(invoke, 30s)`
gefunden haben. Hätten wir das vor Phase 2k (als der 30s-Race
pragmatisch eingebaut wurde) geprüft, wäre uns die Bug-Welle
erspart geblieben. Plus: ein 1-stündiger Skim in `claude-code-source`
am 2026-05-04 abend hat fertige Vorlagen für Phase X (Skills),
Phase 5 (exec) und Phase 6c (agent_ask) zu Tage gebracht — die
unsere offenen Design-Fragen teilweise schon beantworten.

**How to apply:** Cross-Reference-Pointer pro kommende Phase liegen
in `private/FUTURE.md` „Cross-Reference: 3-repo-research-pointers"-
Block. Findings (was die machen, was wir adoptieren, was wir
weglassen) als knapper Block ins Phase-Design-Doc (eigene `private/
<phase>-design.md` oder direkt ins FUTURE-Phase-Kapitel).
**Counter-Regel:** Code nicht kopieren — nur Patterns adoptieren.
Lizenz-respektierend, plus die drei Repos haben andere Stacks
(Anthropic-SDK, OpenClaw-eigene-Runtime, Hermes-Python). Ideen
werden zu somoras TypeScript+Hono+SDK-Setup übersetzt.
