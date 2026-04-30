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

### 17. SDK-Defaults aus
Bei jedem `query()`-Call: `settingSources: []` und `allowedTools` strikt auf eigene
Tool-Liste. Keine impliziten SDK-Defaults (kein automatisches Skill-Loading,
keine Built-in Tools wie Bash/Edit/WebSearch).
