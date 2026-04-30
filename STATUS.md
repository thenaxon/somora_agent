# somora — Status & Pickup-Point

Lebende Notiz für nahtlosen Wiedereinstieg in zukünftige Sessions.

---

## Wo wir stehen (Stand: 2026-04-30, commit `polish-3`)

**Phase 1 ist komplett**, plus drei Polish-Schritte. Das System ist
funktional benutzbar — `npm run dev:server` + `npm run dev:cli` läuft,
beide Engines reden, Sessions persistieren, Provider/Model-Switching
ist live.

### Was funktioniert

- **Server** (Hono auf 18737, SSE) — `src/server/index.ts`
- **CLI** mit Slash-Commands — `src/cli/index.ts`
- **Engine-Layer** mit zwei Adaptern:
  - `claude-cli` — Anthropic via Claude-Code-Subscription, Token-Streaming via
    `includePartialMessages`, 4-Schicht-Defense gegen Account-MCP-Leak
  - `openai-compatible` — `chat.completions` gegen jede BaseUrl, getestet
    gegen `omlx`-Server mit Gemma-Modellen
- **Provider/Model/Alias-System** — `src/config/types.ts`, `src/config/loader.ts`
  - YAML-Config in `~/.somora/config.yaml`, `config.example.yaml` als Repo-Doku
  - Pro Modell: `contextWindow`, `capabilities` (text/image), optional `alias`
  - Aliases sind global eindeutig — Config-Load failt sonst klar
- **Persona-System** — AGENTS.md/SOUL.md/USER.md pro Agent in
  `~/.somora/agents/<name>/`, Frontmatter mit `model:` und `fallback:`
- **Sessions** — `<YYYYMMDD-HHMMSS>_<slug>.jsonl` + `*.meta.json` companion;
  `main` als magic always-present-name
- **CLI-Polish** — Token/Context-Display im Prompt: `[hans:main · 12k/1000k · ↓42]>`
- **Fallback-Logik** — wenn primary vor Output failt → `persona.fallback`
- **Logging** — Pino, daily JSONL, Pretty-TTY mit `singleLine`

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

## Was bewusst NICHT da ist

- **Memory-Layer** — Phase 2. Rene hat hier Spezialwünsche, deshalb in
  der nächsten Session erst **diskutieren**, dann bauen. Mein erster
  Anlauf (Memory.md → System-Prompt) wurde verworfen.
- **Eigenes Tool-System** — Phase 2 nach Memory. Definition, MCP-Hookup
  beim Anthropic-SDK, Tool-Call-Loop beim OpenAI-Adapter, Allowlist
  pro Agent. Nichts davon existiert.
- **Voice / Realtime** — Phase 3.
- **Telegram-Channel** — Phase 3.

---

## Pickup für nächste Session

Erster Satz beim Wiedereinstieg sollte sein:
> „Wir stehen bei `polish-3`. Phase 1 ist durch, beide Engines auf
> Gleichstand. Du wolltest in der nächsten Session über die
> Memory-Schicht reden — du hast da Spezialwünsche. Ich hör erst zu,
> nicht vorbauen."

Wichtig: Memory ist bewusst noch unangerührt. Nicht spontan starten,
auch wenn Auto-Mode aktiv ist. Erst Renes Vorstellungen aufnehmen,
dann gemeinsam designen.

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
