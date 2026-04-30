# Projekt-Context: persönlicher Agent-Harness (Arbeitsname offen)

Dieses File ist die Zusammenfassung einer ausführlichen Architektur-Diskussion
aus dem Claude-Webchat. Es ist **kein Bauplan und keine Schritt-für-Schritt-Anleitung**,
sondern eine Info-Sammlung über besprochene Konzepte, Entscheidungen und offene Punkte.

Der Bau soll **mini-mini-mini** starten und sich organisch weiterentwickeln —
nicht von Anfang an das große Konstrukt.

---

## Wer

Rene Siegl. Vibe Coder. Hauptmaschine: Naxon-VM unter Proxmox.
Bestehender Stack: OpenClaw (mit Naxon-Persona via Telegram), Claude Code lokal,
naxxen.ai als breitere Plattform-Vision, KI-Vault als Next.js-Projekt.
Sprache: TypeScript ist sympathischer als Python.

---

## Worum geht's

Ein **persönlicher Agent-Harness** auf der Naxon-VM, der langfristig OpenClaw
ablösen *könnte*, aber nicht muss. Erstmal nur ein Prototyp, der eigene
Personas ausführt, mit eigenen Tools, eigener Memory, ohne den Ballast
fertiger Frameworks.

**Wichtig:** das Projekt heißt nicht naxxen-irgendwas. Der Name ist offen.
Während des Builds entweder Arbeitsname „lobo" oder einfach nichts —
final wird der Name später entschieden.

---

## Architektur-Kernentscheidungen aus der Diskussion

### Stack
- **TypeScript / Node.js**, nicht Python
- **Anthropic Claude Agent SDK** als einzige Engine in Phase 1
- **Hono** als Webserver (oder Fastify, beides okay)
- **Zod** für Schema-Validation
- später optional **OpenAI Agents SDK** für Voice und lokale LLMs (asymmetrisch genutzt, nicht gleichberechtigt)

### Auth-Lage (wichtig!)
- Anthropic-Doku sagt: für Drittanbieter-Apps eigentlich API-Key nutzen
- Test mit `apiKeySource: "none"` + ungesetztem `ANTHROPIC_API_KEY` zeigt:
  Subscription-Auth via Claude Code funktioniert technisch
- `rate_limit_event` mit `rateLimitType: "five_hour"` und `isUsingOverage: false`
  bestätigt: Aufrufe gehen gegen normalen Subscription-Pool, nicht Extra-Usage
- **Plan A:** Subscription nutzen (kostenlos im Rahmen der Quota)
- **Plan B:** wenn Anthropic das technisch unterbindet, einfach
  `ANTHROPIC_API_KEY` setzen — Code muss sich dafür nicht ändern
- Use Case ist rein lokal/persönlich, keine Kommerzialisierung —
  damit ist das Risiko praktisch niedrig

### Was das SDK *nicht* selber machen soll
Das SDK lädt standardmäßig viel Filesystem-Zeug (Skills, CLAUDE.md, Slash-Commands).
Für diesen Harness wollen wir das ausschalten:
- `settingSources: []` zwingend
- `allowedTools` auf eine **explizite kleine Liste** beschränken
- Built-in Tools (Bash, Edit, WebSearch etc.) **nicht** ins `allowedTools`,
  also de facto deaktiviert
- Nur was wir selbst definieren ist verfügbar

### Was wir selbst bauen
- **Persona-System** als YAML-Files
- **Tool-Registry** mit eigenen Tools
- **Memory-Schicht** außerhalb des SDKs (langfristig Qdrant, anfangs in-memory)
- **Skill-System** (eigenes, nicht Anthropics SKILL.md-Mechanismus)
- **NormalizedEvent-Format** für engine-agnostische Persistenz
- **Conversation Storage** in eigener DB (nicht JSONL-Files vom SDK)

### Engine-Abstraktion
Auch wenn Phase 1 nur Anthropic-Engine hat, das `AgentEngine`-Interface
gleich engine-agnostisch designen. Damit später OpenAI-Engine (für
Voice und lokale LLMs via OpenAI-kompatible Endpoints) und/oder Google
ADK-Engine (für Gemini) als zusätzliche Implementations einsteckbar sind.

---

## Was im Webchat *nicht* mehr Thema sein muss

Diese Punkte sind durchgekaut, nicht erneut diskutieren:

- Hermes Agent: nutzt OAuth-Token-Reuse, landet im Extra-Usage-Pool, kostet
  praktisch immer Geld → **kein Pfad für uns**
- OpenClaw weiternutzen: läuft, bleibt parallel als Naxon-Telegram-Bot
- Ob beide SDKs gleichzeitig nutzen: Anthropic primary, OpenAI später
  optional und asymmetrisch (nur für Voice/lokal), nicht gleichberechtigt
- Persona vs Engine: Personas sind First-Class, Engines austauschbar
- Tools über MCP einhängen: ja, das ist der saubere Weg

---

## Warum nicht OpenClaw weiterentwickeln

Wurde diskutiert, kurze Zusammenfassung:
- OpenClaw spricht direkt die APIs, baut den Loop selbst nach
- Das ist OpenClaws strukturelle Schwäche: SDK-Innovationen müssen nachgebaut werden
- Plus zunehmende Komplexität (Auth-Profile, Plugin-System, Provider-Mapping)
- Plus Maintainer ist zu OpenAI gewechselt
- Eigener Harness mit SDKs als Engines = saubere Architektur, weniger Eigencode

---

## Was Phase 1 sein soll — wirklich klein

Nicht alles auf einmal. Erste Iteration:

- Ein TypeScript-Projekt, das mit dem SDK redet
- Ein simpler Server-Endpoint (Webchat oder CLI, völlig egal)
- Eine Persona als YAML
- Ein einziges Custom-Tool (echo, Trivial-Test reicht)
- `settingSources: []`, `allowedTools` strikt
- Streaming-Output abfangen und in eigenes Event-Format mappen
- Conversation in einer In-Memory-Map speichern (kein DB-Setup nötig)

Das war's. Wenn das läuft, ist Phase 1 abgeschlossen.

**Phase 2** (später):
- Memory-Schicht mit echter Persistenz
- Mehrere Tools, MCP-Integration der bestehenden Naxxen-MCPs
- Skill-System

**Phase 3** (noch später):
- OpenAI-Engine als zweite Engine
- Voice-Realtime-Experiment
- Telegram-Channel

**Phase 4-irgendwann**:
- Multi-Pi-Voice-Setup im Haus
- Sonos-Integration
- alles was Naxon heute kann + besser

---

## Konkrete Code-Schnipsel aus der Diskussion

### Subscription-Test (Naxon-VM, hat funktioniert)
```bash
mkdir ~/sdk-test && cd ~/sdk-test
npm init -y
npm install @anthropic-ai/claude-agent-sdk tsx typescript
unset ANTHROPIC_API_KEY
npx tsx test.ts
```

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const msg of query({
  prompt: "Antworte nur 'Test erfolgreich'.",
  options: { model: "claude-opus-4-7", settingSources: [] }
})) {
  if (msg.type === "result") console.log("Cost:", msg.total_cost_usd);
}
```

→ Output zeigte `apiKeySource: "none"`, Subscription wurde genutzt,
  Cost ist nur theoretischer Wert (nicht tatsächlich abgerechnet).

### Tool-Definition mit dem SDK
```typescript
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const myTool = tool(
  "tool_name",
  "Beschreibung was das Tool tut und wann es genutzt werden soll.",
  { param: z.string() },
  async ({ param }) => ({
    content: [{ type: "text", text: "result" }]
  })
);

const myServer = createSdkMcpServer({
  name: "my-tools",
  tools: [myTool]
});

// Aufruf:
for await (const msg of query({
  prompt: userMessage,
  options: {
    model: "claude-opus-4-7",
    systemPrompt: "Du bist...",
    mcpServers: { "my-tools": myServer },
    allowedTools: ["mcp__my-tools__tool_name"],
    permissionMode: "bypassPermissions",
    settingSources: [],
  }
})) { /* ... */ }
```

---

## Nützliche Doku-Links (nur falls Claude Code sie braucht)

- Anthropic Agent SDK (TS): https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
- Anthropic Agent SDK Docs: https://platform.claude.com/docs/en/agent-sdk/typescript
- Anthropic Agent SDK Quickstart: https://code.claude.com/docs/en/agent-sdk/quickstart
- Anthropic Agent SDK Overview: https://code.claude.com/docs/en/agent-sdk/overview

Diese braucht Claude Code nicht zwingend zu lesen — der hat den Code des SDKs eh
direkt verfügbar via `node_modules`. Tipp: nach `npm install` einfach in
`node_modules/@anthropic-ai/claude-agent-sdk` reinschauen für die echten Types.

---

## Naxon-VM Umgebung

- Debian, Node 20+ vorhanden
- Claude Code installiert und mit Max-Account eingeloggt
- Tailscale-Netz aktiv
- OpenClaw läuft auf Port 18789, also neuer Service auf anderem Port
- Verzeichnis-Konvention: `~/Projects/<projektname>/`

---

## Ton der Zusammenarbeit mit Claude Code

- Wirklich klein anfangen — nicht alles auf einmal generieren
- Bei Architektur-Fragen: Rene fragt, Claude Code antwortet, kein Solo-Wirken
- Lieber 50 Zeilen die laufen als 500 die nicht
- Erst Test ausführen, dann erweitern
- Wenn Claude Code unsicher ist über eine Designentscheidung — nachfragen,
  nicht annehmen
- Decision Log mitführen wäre nett (welche Entscheidungen warum getroffen)

---

## Was Rene jetzt vor hat

In das Projekt-Verzeichnis gehen, Claude Code starten, dieses File als
Kontext referenzieren, dann Schritt für Schritt anfangen — beginnend mit
dem absoluten Minimum: ein TypeScript-Projekt das mit dem SDK redet und
„Hallo" sagen kann. Alles andere wächst von da.
