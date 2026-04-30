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
