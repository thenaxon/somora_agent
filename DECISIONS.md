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
