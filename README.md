# somora

Persönlicher Agent-Harness — Server/Gateway mit pluggable Engines, Multi-Agent, eigenes NormalizedEvent-Format.

Status: Mini-Skelett. Logik kommt iterativ.

## Komponenten (geplant)

- **Server** (`src/server/`) — HTTP-Gateway auf Port 18737, SSE-Streams pro Session
- **CLI** (`src/cli/`) — primitiver Terminal-Client der mit dem Server redet
- **Engine** (`src/engine/`) — Adapter, der das jeweilige SDK in NormalizedEvents übersetzt (Phase 1: nur Anthropic)
- **Persona** (`src/persona/`) — Loader für `~/.somora/agents/<name>/{AGENTS,SOUL,USER}.md`

## Entwicklung

```bash
npm install
npm run dev:server   # später, sobald src/server/index.ts existiert
```

## Konfiguration

Lebt unter `~/.somora/`:

```
~/.somora/
├── config.yaml
└── agents/
    └── <name>/
        ├── AGENTS.md
        ├── SOUL.md
        ├── USER.md
        ├── memory/
        └── sessions/
```

Override des Home-Pfads per `SOMORA_HOME`-env-var.
