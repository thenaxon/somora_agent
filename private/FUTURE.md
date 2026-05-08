# FUTURE — geplante Phasen, Konzepte, Ideen

Dieses File hält Konzepte fest, die _entschieden, aber noch nicht
gebaut_ sind. Wenn was hier reift und zur Implementierung kommt,
wandert die Substanz in `DECISIONS.md` als kanonischen Eintrag und
hier bleibt nur ein „done in commit X"-Marker.

---

## tmux-Effizienz — `wait_idle` / `since_last` / `tmux watch` (entdeckt 2026-05-06 via Hans's Bug-Report 2)

**Status:** `wait_idle` **DONE 2026-05-07** (commit `b2eb670`, Phase 1).
Hans-verifiziert mit 4-Test-Battery (happy-path, TUI welcome, TUI
Antwort, Timeout, already-idle). `since_last` und `watch` weiterhin
offen — bei nächstem realen Bedarf nachreichen.

Drei orthogonale Ideen, in steigender Komplexität:

### 1. `tmux({action: "wait_idle"})` ✓ DONE

Pollt den Pane bis sich der Content für N ms nicht mehr ändert (= TUI
hat aufgehört zu tippen / Command ist fertig). Returnt dann den
finalen Content. Ersetzt das „Pattern raten" für lange Beobachtungen
— funktioniert für jedes TUI/Command, völlig agnostisch.

API-Skizze:
```ts
tmux({
  action: 'wait_idle',
  name: 'session-x',
  idle_stable_ms: 1000,    // default 500
  max_wait_ms: 600_000,    // 10min ceiling
  lines: 200,
})
→ { content, ms_waited, became_idle: true|false /* timeout */ }
```

Implementierung: poll mit POLL_INTERVAL_MS, bei jeder unveränderten
Capture wachsen `stable_ms`, bei Veränderung Reset auf 0. Sobald
`stable_ms >= idle_stable_ms` → match. Diff zum bestehenden
`wait_mode: 'idle'` (das auf einem Pattern wartet): `wait_idle` braucht
KEIN Pattern, returnt einfach sobald Stille einkehrt.

Größter Hebel von den dreien — eine eigene Action, ~30 Min Build.

### 2. `capture({mode: "since_last"})`

Returnt nur die Bytes/Lines die seit dem letzten `capture` in derselben
Session NEU angefügt wurden. Spart Token-Kosten beim Re-Lesen alter
Outputs (Hans's reale Session: 70% des Capture-Outputs war
schon-gesehen).

Implementierung: per `<agent, name>` einen Cursor halten (Hash der
letzten N Bytes oder einfach Byte-Offset im internen Buffer), bei
nächstem since_last-Capture nur den neuen Bereich liefern. Edge-Cases:
tmux-Scrollback rolliert (alte Bytes weg), Pane wurde gecleart.

~1h Build inkl. Cursor-Storage + Cleanup beim Session-Kill.

### 3. `tmux({action: "watch"})` Background-Job

Ein Background-Capture-Loop schreibt jeden Snapshot in eine Datei,
der Agent pollt die Datei mit `file_read` (günstiger als jeder
synchrone MCP-Roundtrip). Schwerer zu bauen, aber wäre die
effizienteste Variante für sehr lange Beobachtungen (>5min mit
vielen Status-Checks).

Cleanup-Bürde: watch-Jobs müssen mit der tmux-Session sterben, sonst
kreieren sie endlose Files. Eigentlich ein eigenes kleines Subsystem
analog zu `process` für `exec --background`.

~halben Tag Build.

### Priorität untereinander

1 (`wait_idle`) ist der größte Quick-Win und vermutlich für 80% der
Use-Cases ausreichend. 2 + 3 lohnen sich erst bei sehr langen
Sessions; bauen wir bei nächstem Bedarf.

---

## Phase 2-Stufe-C — Agent-Loop für `openai-compatible`

**Status:** entschieden, kommt direkt nach Memory-Layer (Phase 2-Stufe-B).

**Was:** Eigene Tool-Call-Loop für die `openai-compatible`-Engine, sodass
sie Tools (insb. `memory_*`) genauso aufrufen kann wie claude-cli/codex-cli
es via ihren internen Loops + MCP tun.

**Warum jetzt nicht:** Memory-Tools werden in Phase 2-Stufe-B als MCP-Server
exposed. claude-cli/codex-cli konsumieren das natürlich (haben eingebaute
Tool-Loops). `openai-compatible` braucht aber einen _eigenen_ Loop:
`response.choices[0].message.tool_calls` → Tool-Bridge → Tool-Result →
nächste Completion → … bis stop. Bauen wir solange wir Memory-Architektur
frisch im Kopf haben, damit Tool-Surface engine-übergreifend identisch ist.

**Scope:**
- Loop-Implementierung in `src/engine/openai-compatible.ts`
- Tool-Bridge die Memory-Tools (und später andere) ohne MCP-Roundtrip aufruft
- Multi-Round-Tool-Calls (mehrere `tool_call`/`tool_result`-Pairs pro Turn)
- Korrekte Token-Counting über Tool-Rounds (akkumulieren, nicht nur letzte
  Completion)
- Streaming bleibt: Deltas durchreichen, Tool-Calls als Block-Events

**Dependencies:** Memory-Layer (Phase 2-Stufe-B) muss zuerst Tool-Registry
+ MCP-Server haben. Sonst hätte der Loop nichts zu tun.

---

## Phase 2-Stufe-D (oder später) — Dream-Mode

**Status:** Konzept abgesegnet (2026-05-01), Bau später.

**Konzept (Renes Vorstellung):**

Wenn die Runtime idle ist (keine User-Turns für eine Weile), startet ein
„Träumer"-Modus. Pro Agent in `agent.yaml` konfigurierbar welches Modell
zum Träumen genutzt wird (z.B. `dream: gemma4big`). Default: keiner →
Dream-Mode aus.

**Was der Träumer tut:**

1. Liest pro Session einen Marker aus dem Meta-File (`dreamReadThroughTs`
   oder ähnlich) — bis wohin er schon gelesen hat.
2. Liest das Delta seit Marker durch — also was seit dem letzten Traum
   in den Sessions passiert ist.
3. Vergleicht das mit dem Memory _und_ dem Obsidian-Vault (sofern
   konfiguriert) auf Inkonsistenzen.
4. Beispiel-Inkonsistenz: Memory sagt „Rene fährt einen Fiat 500", aber
   in der heutigen Session hat Rene erzählt „ich habe mir einen Mercedes
   gekauft und den Fiat verkauft". → Träumer notiert das als Finding.
5. Findet auch: veraltete Vault-Notizen die offensichtlich nicht mehr
   stimmen.
6. **Träumer schreibt nicht ins Memory oder den Vault.** Er hinterlässt
   eine **Traumzusammenfassung** in einer separaten Datei (z.B.
   `~/.somora/agents/<name>/memory/.dreams/<datum>.md`).
7. Marker im Meta-File wird auf das Ende des gelesenen Bereichs
   gesetzt.

**Was Hans dann tut:**

Wenn der User am nächsten Tag fragt „was hast du geträumt?" oder Hans
einfach auf eine Frage antwortet, sieht er:
- via Auto-Inject: ggf. die Traumzusammenfassung als Pending-Tray
- oder: explizit über ein Tool `dream_review()` → liefert offene Findings

Hans schlägt dem User pro Finding eine Korrektur vor: „Soll ich das
Auto im Memory auf Mercedes ändern?". User bestätigt oder lehnt ab.
Bei Bestätigung führt Hans die entsprechende `memory_edit`/`memory_delete`/
`obsidian_write`-Operation aus. Nach Abarbeitung ist die Traum-
zusammenfassung weg (oder als „processed" markiert).

**Warum Read-Only-Träumer + User-Approval-Loop:**

- OpenClaws Auto-Promotion (Dreaming-Cron schreibt direkt in MEMORY.md)
  ist riskant: bei Fehlinterpretation korrumpiert er das Memory ohne
  Audit-Pfad.
- Renes Modell ist sicher (User sieht Findings vor Commit) und
  transparent (du weißt was gerade „dazugekommen" wäre).
- Idle-Trigger heißt: keine Latenz on-the-fly, Memory-Pflege passiert
  wenn eh niemand wartet.

**Implementierungs-Notizen:**

- Dream-Findings haben eigenes File-Layout, NICHT vermischt mit
  regulärem Memory.
- Pro-Session Marker im Meta-File (additiv zu `dreamReadThroughTs`).
- OpenClaws Obsidian-Skill (`obsidian-cli`) ist mögliche Referenz für
  das Vault-Schreiben:
  https://github.com/openclaw/openclaw/blob/main/skills/obsidian/SKILL.md
- Findings-Format strukturiert (Type / Reference / Old / New / Source-Session-Id).
- Dream-Worker läuft als entkoppelter Job, idealerweise mit eigenem
  Modell-Slot, damit reguläre Turns nicht blockiert werden.

**Dependencies:** Memory-Layer (Phase 2-Stufe-B) + Tools (mind.
`memory_*`, `dream_*`, `obsidian_write` falls Vault aktiv).

---

## Obsidian-Verbesserung — Wikilink-/Backlink-Awareness

**Status:** Idee aus Diskussion 2026-05-01, nach Phase-2g-Obsidian-Integration.

**Heute:** Vault-Markdown wird als reiner Text behandelt. Embeddings + BM25
matchen Tokens innerhalb des Inhalts (inklusive der wörtlichen Link-Strings
wie `[[../devices/Voice-Satellites|Voice Satellites]]`), aber die
**Graph-Struktur** zwischen Notes ist für die Runtime unsichtbar.

**Was fehlt:**

- **Link-Extraktion** beim Chunking: `[[target|display]]`-Patterns parsen,
  Target-Pfad relativ zum Vault auflösen, in Chunk-Metadaten speichern
  (z.B. neue `chunk_links`-Tabelle mit `from_chunk_id`, `to_file_path`).
- **Backlinks-Index:** „welche Notes verlinken auf X?" — beim Re-Index
  pro File eine Liste seiner ausgehenden Links bauen, dadurch entsteht
  implizit der Eingangs-Index.
- **Recall-Expansion:** wenn ein Treffer in Note A landet und A linkt auf
  B, dann B mit reduziertem Score-Boost (z.B. 0.6 × A's Score) als
  zusätzlichen Recall-Hit aufnehmen — bis zu N Hops oder Token-Cap.
  Das löst Renes Beispiel: Note A sagt „siehe [[B]] für Geräte-Übersicht",
  User fragt nach Geräten → A wird gefunden, B kommt automatisch mit.
- **Hit-Boost durch Link-Popularität:** vielverlinkte Notes (=zentrale
  Knoten im Vault-Graph) bei Score-Ties bevorzugen. Optional, eher
  Sahnehäubchen.

**Wert:** in echten Obsidian-Vaults ist die Link-Struktur _bewusst gepflegt_ —
sie ist kuratierte semantische Information. Die zu nutzen ist deutlich
billiger als sie via Embeddings zu rekonstruieren.

**Dream-Synergie:** der Träumer könnte Inkonsistenzen quer durch
verlinkte Note-Cluster aufdecken — „Note A sagt X, verlinkte Note B
sagt nicht-X, reconcile?". Das ist genau die Art Inkonsistenz die
Embedding-Suche allein schlecht findet.

**Implementierungs-Notizen:**

- Link-Resolution muss tolerant sein: Obsidian erlaubt sowohl
  `[[target]]` (basename-match) als auch `[[path/target]]` (relativ).
  Beim ersten Resolve-Pass über den ganzen Vault scannen, dann
  Slug-Map bauen.
- Renames: wenn der User eine Note umbenennt, brechen Links bis zum
  nächsten manuellen Sweep. Kann später automatisiert werden, aber für
  v1 reicht „beim Re-Index die Edge-List neu aufbauen".
- Obsidian-Aliases (`---\naliases: [...]\n---` in Frontmatter) ggf.
  mit-resolven für robusteres Linking.

**Dependencies:** keine spezifischen — könnte parallel zu Memory-Tools
oder vor Dream-Mode kommen. Lebensqualität-Upgrade, kein Blocker.

---

## Polish-Punkte aus dem Engine-Delta (DECISIONS #20-Tabelle)

Stehen offen, kommen wenn passt. Reihenfolge frei nach Bedarf:

- **Multimodal / Image-Routing** — `capabilities.image` ist im Schema, openai-
  compatible-Adapter ignoriert's. Vision-Content-Blocks müssten richtig geroutet werden.
- **Token-Counting-Genauigkeit** — Heuristik (4 chars/token) durch echte
  tokenizer-basierte Counts ersetzen wo das Backend das nicht selbst liefert.
- **Retry / Error-Recovery mid-stream** — aktuell greift fallback nur _vor_
  erstem Output. Mid-stream-Fehler werden durchgereicht.
- **Thinking / Reasoning-Block-Trennung** — anthropic-thinking + o1-reasoning
  würden eigentlich strukturiert übermittelt; wir verschmelzen alles zu plain content.
- **Prompt-Caching aktiv nutzen** — Anthropic `cache_control` und OpenAI-Prefix-Cache
  sind im Augenblick ungenutzt. Größter Hebel für Kostenreduktion.
- **Sampling-Params** — temperature, top_p, stop, seed; aktuell nur `max_tokens` im
  Config-Schema.

---

## Thinking-Block-Sichtbarkeit (`/verbose thinking`)

**Status:** Konzept abgesegnet 2026-05-03. Folgt nach `/verbose tools|
memory|system` (phase tui-G, commit e55a2e9). Wird gebaut wenn echter
Bedarf da ist — Token-Count + „🧠 thinking…"-Indicator decken heute die
90%-Fälle ab.

**Ziel:** Inhalt des Modell-Reasonings inline im Chat sichtbar machen,
nicht nur Token-Count. Bei `/verbose thinking on` rendert die TUI
Thinking-Blöcke gedimmt + eingerückt unter dem agent-Tag, ähnlich wie
`DetailsBlock` für Tool-Payloads.

**Was zu tun ist:**

1. **NormalizedEvent erweitern** (`src/types/events.ts`): neue Kinds
   `thinking_delta` und `thinking_message`, parallel zu `assistant_*`.

2. **claude-cli Adapter** (`src/engine/claude-cli.ts` ~Zeile 163):
   Block-Trennung. Heute verschmelzen wir `content_block_delta`-Events
   aller Block-Typen zu plain text. Stattdessen: Block-Type prüfen,
   `thinking_delta`-Blöcke separat als somora-`thinking_delta`
   emittieren, text-Blöcke unverändert. Gleicher Pattern für die
   trailing assistant-message: Thinking-Blöcke separat als
   `thinking_message`.

3. **codex-cli Adapter:** bleibt dunkel — Codex' JSON-Stream hat keine
   Reasoning-Inhalte, nur `reasoning_output_tokens` im Usage. Könnten
   wir später ergänzen wenn Codex sein Event-Format erweitert.

4. **openai-compatible Adapter:** zwei Varianten parallel:
   - Endpoints die `delta.reasoning_content` liefern (gpt-5/o1 via
     official SDK): direkt durchreichen als `thinking_delta`
   - Inline-`<think>...</think>`-Modelle (DeepSeek-R1, QwQ): Stream-side
     Detection, Tag-Stripping, separate Emission. Braucht eine eigene
     `reasoning-inline`-Capability im Model-Schema (heute nur binäres
     `reasoning`). Per-Modell opt-in in `config.yaml`.

5. **SSE Wire** (`src/types/events.ts`): neuer `event: 'thinking'` mit
   `{ phase: 'delta' | 'final', text }`. Wird gepublished wie
   `chat`-Events durch den Per-Turn-Serializer.

6. **TUI:**
   - neuer Turn-Kind `thinking` in `src/cli/tui/types.ts`
   - eigener TurnView in `turn-views.tsx`: gedimmt (gray), eingerückt,
     evtl. collapsible — Designdetail beim Bauen
   - `/verbose thinking on|off` als vierter Topic in `commands.ts`,
     reiht sich nahtlos in das bestehende `/verbose`-Framework ein
   - `tui.verbose.thinking: boolean` im Config-Schema

7. **Doku:** `docs/thinking.md` Sektion „What's not built" auf
   gebaut umstellen, Mapping-Tabelle pro Engine erweitern. `docs/
   display.md` letzten Absatz („What's not covered yet") entsprechend
   anpassen.

**Aufwand:** realistisch zwei Tage. Hauptlast: claude-cli
Block-Trennung + TUI-Component-Design + ggf. `<think>`-Tag-Detection
für lokale Reasoning-Modelle.

**Trigger fürs Bauen:** wenn Reasoning-Inhalt selbst gewünscht ist —
Debug, Vertrauensaufbau („was hat das Modell überlegt?"), Memory-
Curation-Workflows. Bis dahin reicht das was heute steht.

---

## Memory-Inject Position für Prefix-Cache — DONE 2026-05-06 (commits `49c682a` + `cb9f429`)

**Status: zwei Iterationen, jetzt strukturell korrekt.**

### Erste Iteration (49c682a, 2026-05-05) — partiell

- `src/engine/claude-cli.ts`: Variante B hardcoded — ephemeralContext
  landed vor dem user-text in der user-message, systemPrompt bleibt
  stabil. Backend immer Anthropic, deterministisch.
  **Wirkt — claude-cli cache hit von 73% → 95% (später 98%).**
- `src/engine/openai-compatible.ts`: „late-system"-Variante eingebaut —
  Memory als zweite system-message direkt vor letzter user-message.
  **Wirkte NICHT** — verifiziert mit instrumentiertem two-turn-Dump
  gegen omlx: Memory-Position „wandert" durch die Sequenz weil History
  wächst, byte-mismatch bei der ersten dynamischen Position.
- `src/server/run-turn.ts`: selfPointer aus `getFreshConfig()` (kleiner
  Bonus-Fix für Bug-4-Hot-Reload-Konsistenz).

### Zweite Iteration (cb9f429, 2026-05-06) — strukturell korrekt

Pre-Build-Research (DECISION #38) gelaufen: OpenClaw-Bundles sind
minified (keine Patterns extrahierbar), Hermes optimiert für stateless
openai-compatible **gar nicht** (sie verlassen sich auf Anthropic's
cache_control, für lokale Backends akzeptieren sie den Verlust). Wir
machen's hier besser als die Referenz-Repos:

- `src/types/events.ts`: `user_message` kriegt `ephemeral?: string`-
  Feld → memory-Block wird pro Turn in JSONL persistiert
- `src/server/run-turn.ts`: Reihenfolge umgestellt — Memory-Inject
  läuft VOR appendEvent, das `ephemeral` landed mit auf der JSONL-Zeile
- `src/engine/openai-compatible.ts` `buildMessages`: liest `ephemeral`
  aus jedem user_message-Event bei history-Reconstruction, rendert
  content als `${ephemeral}\n\n${text}`. `injectEphemeralLate()`-Helper
  weg — wird nicht mehr gebraucht.
- `memoryInjectMode`-Schema simplifiziert: `late` weg (war das
  kaputte Middle-Option). Nur noch `inline-user` (default mit JSONL-
  Persistenz) und `system` (legacy/fallback).

**Verifikation:** instrumentierter Dump zeigt Turn 1 und Turn 2
Position 0..9 byte-identisch. claude-cli + codex-cli ohne Regression
(98% / 68% cache hit).

**omlx-side limitation:** omlx returnt `cached_tokens: null` selbst
für byte-identische direct-curl-Requests. Reporting-Bug oder Cache
nicht aktiv für gemma-4-31b-it-8bit — nicht aus somora fixbar. Aus
unserer Sicht: strukturell richtig, runtime-Effekt auf omlx hängt
von deren Implementation ab.

**Smoke-Matrix nach Fix (cb9f429):**
- claude-cli (jarvis/opus): 98% cache hit auf Follow-up-Turn
- codex-cli (lisa/gpt55): 68% cache hit
- openai-compatible: byte-perfekte history-reconstruction verifiziert
- Memory-Recall funktioniert weiter (model konnte „Österreich"
  korrekt aus Vault-Inhalt benennen)

---

### Original-Diagnose (für Trajectory)

**Problem-Beobachtung (Renes Frage):** Turns auf gemma4big via mlx-omx
fühlen sich auch in laufenden Sessions zäh an — initiale Token-
Generation nimmt mehrere Sekunden, obwohl der vorhergehende Turn
gerade lief. Hypothese: Prefix-Cache wird zerstört.

### Status pro Engine

**openai-compatible (mlx-omx, gemma) — 🔴 KAPUTT**
(`src/engine/openai-compatible.ts:236-238`):

```ts
const effectiveSystemPrompt = ephemeralContext
  ? `${systemPrompt}\n\n---\n\n${ephemeralContext}`
  : systemPrompt;
```

Memory-Inject (`ephemeralContext`) wird an den System-Prompt angehängt
und der landet als ALLERERSTE Message im Array. Memory ändert sich
jeden Turn → Cache-Invalidation für alles dahinter.

**claude-cli (Anthropic SDK) — 🔴 KAPUTT, gleicher Bug, anderes File**
(`src/engine/claude-cli.ts:135-137`):

```ts
const systemPromptForTurn = ephemeralContext
  ? `${systemPrompt}\n\n---\n\n${ephemeralContext}`
  : systemPrompt;
SDK.query({systemPrompt: systemPromptForTurn})
```

Anthropic's Prompt-Caching setzt `cache_control` auf den system-block
als einzelnen Cache-Breakpoint. Wenn der String sich pro Turn ändert
(weil Memory hinten dranklebt), wird der gesamte system-block-Cache
invalidiert. Der SDK kann nichts dagegen tun — wir geben ihm einen
veränderten String, er cached entsprechend.

**codex-cli — 🟢 FINE (akzidentell richtig)**
(`src/engine/codex-cli.ts:206-210`):

```ts
const ephemeralBlock = ephemeralContext ? `${ephemeralContext}\n\n---\n\n` : '';
const promptPayload = resumeId
  ? `${ephemeralBlock}${replayPrefix}${taggedUserMessage}`
  : `${systemPrompt}\n\n---\n\n${ephemeralBlock}${replayPrefix}${taggedUserMessage}`;
codex exec [resume] ... < stdin promptPayload
```

Codex hat keine separate `--system`-CLI-Option — das ganze Payload
geht via stdin als „User-Message" rein. Codex' interner API-Call:
stable persona-system (gefrozen bei Session-Start nach Turn 1) +
history (intern verwaltet) + dieser Turn's Inhalt (= unser
`ephemeralBlock + user`). Memory landet damit **automatisch** am Ende
des Prompts, hinter dem stable Teil. Cache bleibt für die History
intakt. Codex' awkwarde CLI-Schnittstelle hat uns einen Gefallen
getan ohne dass wir's wussten.

**Begründung im openai-compatible-Kommentar** (Zeile 232-235): defensive
Wahl für Backends die nur eine system-message akzeptieren. Bei
claude-cli ist's strukturell limitiert: claude-agent-sdk's `query()`
nimmt nur EINE `systemPrompt: string` Field. Beide Begründungen
machten Sinn solange Cache nicht im Fokus war.

### Bauplan

**Pro Engine eigenes Vorgehen** weil die Schnittstellen sich
unterscheiden:

- **openai-compatible → Variante A (zweite system-message LATE)**
  direkt vor der aktuellen user-message:
  ```
  [system: persona]                ← stabil über Session
  [user 1] [assistant 1] ...
  [system: memory recall]          ← ephemeral, ändert sich pro Turn
  [user: current question]
  ```
  Cache stabil bis zur letzten Position. OpenAI Chat Completions API
  erlaubt mehrere system-messages, mlx-omx + ollama tun das auch.
- **claude-cli → Variante B (memory in user-message inlinen)**
  weil claude-agent-sdk's `query()` nur EIN `systemPrompt: string`-
  Feld hat. Memory geht in die user-message als
  `<memory-context>...</memory-context>\n\n<actual question>`-Wrapper.
  System-Prompt bleibt stabil → Anthropic's prompt-caching cache_control-
  Breakpoint auf system-block hält über Turns hinweg.
- **codex-cli → keine Änderung nötig**, ist schon strukturell richtig
  (siehe Status oben).

Der `<memory-context>`-Wrapper bei Variante B sollte explizit als
„Hintergrund-Recall, nicht User-Aussage" markiert sein damit das
Modell's nicht als „User hat das gerade gesagt" missversteht.
Hermes-Repo macht's so — Wrapper-Tag plus instruction-Hint im system-
Prompt.

### Config-Switch (Renes Wunsch 2026-05-05) — nur openai-compatible

Switch nur auf `openai-compatible`-Providern weil dahinter beliebige
Backends stehen können (mlx-omx, ollama, vLLM, OpenAI selbst,
llama.cpp-Gateways, exotische Setups). Welches multi-system-message
sauber unterstützt und welches nicht, wissen wir nicht im Voraus.

claude-cli braucht keinen Switch — das Backend ist immer Anthropic
via SDK, deterministisch, Variante B (inline-user) ist hardcodiert
die richtige Wahl.

codex-cli braucht keinen Switch — ist eh schon strukturell richtig.

Vorschlag:

```yaml
providers:
  omlx:
    engine: openai-compatible
    baseUrl: http://10.x.x.x:11434/v1
    apiKey: ...
    memoryInjectMode: late      # default: cache-friendly Variante A
    models: [...]

  some-quirky-backend:
    engine: openai-compatible
    baseUrl: ...
    apiKey: ...
    memoryInjectMode: system    # opt-out: top-of-system, current behavior
    models: [...]
```

Werte (nur auf openai-compatible-Providern):
- `late` (default) — Variante A, zweite system-message vor
  user-message. Funktioniert mit allem das multi-system kann.
- `inline-user` — Variante B, in user-message wrapped. Fallback wenn
  ein backend multi-system schluckt aber komisch interpretiert.
- `system` — Variante C, current behavior. Letzter Fallback wenn
  weder late noch inline funktionieren.

Field gehört nur auf `OpenAiCompatibleProviderSchema` — `ClaudeCliProviderSchema`
und `CodexCliProviderSchema` lassen wir clean.

### Validierung wenn gebaut

Vergleichs-Smoke pro Variante mit demselben Persona-Setup:
- Session warm-laufen lassen (3-4 Turns)
- 5 weitere Turns durchspielen, `engine.turn.duration_ms` aus Server-
  Logs sammeln pro Turn
- `late` sollte messbar schneller sein als `system` ab Turn 2 — wenn
  nicht, hat das Backend keinen relevanten Prefix-Cache und wir
  gewinnen nix (außer bessere Architektur)

Plus den Kommentar in `openai-compatible.ts` umschreiben damit das
historische „warum oben" nicht jemanden in die Irre führt.

### Aufwand

Realistisch **ein Tag** statt halber, weil zwei Engines + Config-Schema
+ pro-Engine-Default-Logik + Smoke pro Variante. Plus Token-Budget
für vergleichende Test-Sessions auf gemma4big UND opus.

### Trigger fürs Bauen

- Wenn Latenz auf gemma4big real wieder nervt
- Wenn wir andere lokale Modelle einbinden (qwen, llama, etc.) und
  noch mehr von Cache profitieren würden
- Vor jeder Frontend-Demo wo Latenz user-visible ist

### Code-Pointer

- `src/engine/openai-compatible.ts:236-238` — die Concat-Stelle
  (openai-compatible)
- `src/engine/openai-compatible.ts:232-235` — historischer Kommentar
- `src/engine/claude-cli.ts:131-137` — die Concat-Stelle (claude-cli)
- `src/engine/codex-cli.ts:199-210` — Referenz wie's korrekt sein
  sollte (= „inline ins User-Message-Payload"-Pattern)
- `src/engine/types.ts` — `TurnInput` mit `systemPrompt` +
  `ephemeralContext`
- `src/server/run-turn.ts` — Aufrufer der `ephemeralContext` baut
- `src/config/types.ts` — neues `memoryInjectMode`-Field NUR auf
  `OpenAiCompatibleProviderSchema`. claude-cli + codex-cli bleiben
  unverändert — bei claude-cli ist Variante B fest verdrahtet (Backend
  immer Anthropic, deterministisch), bei codex-cli ist's eh richtig.

### Audit der anderen Per-Turn-Injections (2026-05-05)

Renes Frage „gibt's noch andere Injections die wir zu früh reintun?"
durchgegangen. **Memory ist der einzige Übeltäter.** Audit-Tabelle
mit Status:

- `persona.systemPrompt` — stabil (AGENTS.md/SOUL.md, nur User-Edit) 🟢
- `selfPointer` — stabil (boot-time config) 🟢 (siehe Caveat unten)
- `subContextNote` — stabil per Sub-Session 🟢
- `ephemeralContext` (memory) — 🔴 known issue, dieses Doc
- `replayPrefix` (cross-engine catch-up) — 🟢 schon late position
  (in user-message inlined in claude-cli + codex-cli adapters)
- `from_agent` Header — 🟢 schon in user-message
- Tool-Definitionen — 🟢 stabil per Session
- `history` — 🟢 append-only, neue Inhalte hinten

**Caveat selfPointer + Bug 4:** der selfPointer wird mit der
boot-time-Config gebaut (`buildSelfPointer(persona, deps.config, …)`
in `src/server/run-turn.ts:244`). Nach dem Bug-4-Fix sehen Tools
neue Resources via `getFreshConfig()`, der selfPointer-Block aber
zeigt noch die Boot-Liste bis zum nächsten Restart. Cache-mäßig
korrekt (selfPointer bleibt stabil = Cache hält), UX-mäßig kleine
Inkonsistenz. **Polish-Item, kein Bug** — wenn man's fixt: in
run-turn.ts auf `getFreshConfig()` switchen.

### Skill-System Pre-Warning (Renes Punkt 2026-05-05, präzisiert 2026-05-06)

Wenn wir das Skill-System bauen (Phase X — siehe eigene Sektion),
landet das strukturell **genauso wie Memory:** dynamisch pro Turn die
relevanten Skill-Prompts injizieren. Wenn wir das nicht von Anfang an
cache-freundlich platzieren → killt den Cache genauso → ganzer Memory-
Iterations-Tanz nochmal.

**Verbindliche Regel** (DECISION #40, 2026-05-06): per-Turn variable
Inhalte ans Prompt-Ende, stable nach vorne. Das gilt für Skills.

**Konkrete Konsequenzen für Phase X:**

1. **Skill-Inject Position:** wie aktivierte Skills im Prompt landen,
   muss MIT Cache-Strategie aus `docs/cache-strategy.md` mitgedacht
   werden. Stable Skill-Inhalte (Always-On-Skills die für jeden Turn
   gleich sind) gehören in einen dedizierten stable-Block;
   per-Turn-aktivierte Skills (die je nach User-Frage rein/raus-
   schalten) sind variabel und gehören ans Ende.

2. **JSONL-Persistenz für Skill-Activations:** für stateless openai-
   compatible muss überlegt werden ob ein `skills?: string`-Feld auf
   user_message persistiert wird (analog zu unserem `ephemeral?:
   string`-Feld für Memory). Dann reconstruction bei history-rebuild
   byte-identisch — Cache hält. Das wäre die Skills-Variante des
   gleichen Patterns.

3. **`memoryInjectMode` umtaufen?** Vermutlich `injectMode` mit
   per-Source-Untervariante: `injectModes: { memory: 'inline-user',
   skills: 'inline-user' }`. Oder ein gemeinsamer Mode, der für
   beide gilt — beim Phase-X-Bau zu entscheiden.

4. **Zur 9-Punkte-Diskussionsliste hinzufügen:** „Wo im Prompt landet
   ein aktivierter Skill, und wird Skill-State (welcher Skill war zum
   Turn-Zeitpunkt aktiv) auf user_message persistiert?". Das wird die
   10. Diskussionsfrage.

**Anker:** `docs/cache-strategy.md` ist die kanonische Doku zur
Cache-Politik. Vor Phase X reinlesen, am besten Position-Dump-
Methodik vom Tag 1 anwenden um Drift sofort zu erkennen.

---

## Dream-Worker-Priorisierung (entdeckt 2026-05-04)

**Problem-Beobachtung beim Test-Run:** während mehrerer paralleler
Sub-Spawn-Tests auf gemma4big haben `dream.start` und
`dream.llm_request` Events für Auto-Dream-Worker den mlx-omx-Server
beschäftigt — der queue't sequenziell pro Modell. Folge: Hans-on-gemma's
initialer Turn (Test 1) hat in 20 Min keinen einzigen Token generiert,
weil Auto-Dream-Calls + Test-3-Sub-Subs den Slot blockierten.

**Heutiger Workaround (Hotfix 2026-05-04):** `idleMinutes` von 3 (Test-
Wert) auf 60 hochgedreht in allen agent.yaml. Auto-Dreams werden damit
viel seltener triggern, kollidieren weniger mit Tests/Live-Use.

**Eigentliche Lösung — User-Active-Marker mit AbortSignal:**

Auto-Dream-Worker pausiert sobald ein interaktiver Chat-Turn (oder
synchroner Sub-Spawn) startet, und resumed beim nächsten Idle-Trigger.
Manueller Dream via `/reset` bleibt prio-frei (User triggert ja
explizit).

Konkret:

1. **Globaler Active-Counter:** server-process-weiter Counter in
   `src/server/active-turns.ts`. `runChatTurn()` macht
   `incrementActive()` am Anfang, `decrementActive()` im finally.
   `runOneSpawn()` mit `wait:true` ebenfalls — sync-Spawns sind
   semantisch User-Turns die Hintergrund-Arbeit blockieren sollen.
   Async-Spawns (default `wait:false`) zählen nicht — sie selbst
   nutzen den mlx-omx-Server und würden sich sonst gegenseitig
   blockieren.

2. **Worker-Hook:** AutoDreamWorker subscribed auf den Counter via
   einfachem EventEmitter. Wenn er gerade ein LLM-Chunk verarbeitet
   und der Counter > 0 wird: `controller.abort()` mit Reason
   `"user-active"`. Wenn er gerade schläft / pollt: nicht starten,
   warte bis Counter == 0.

3. **Resume-Pattern:** abgebrochene Dream-Chunks bleiben mit Status
   `paused` markiert (das gibt's schon — siehe DECISIONS #32-#36 und
   `src/dream/extract.ts` AbortSignal-Hookup). Beim nächsten Idle-
   Trigger pickt der Worker sie wieder auf.

4. **Manual-Trigger:** `/reset` triggered Dream synchron (DECISIONS
   #33). Diese Calls sind explicit user-getriggert und sollen NICHT
   pausieren — bypass über Constructor-Flag `respectUserActive: false`.

5. **Engine-Rate-Awareness (Phase 2):** weiter-Konzept — Dream-Worker
   weiß welche Engine sein Worker-Modell nutzt (`omlx/gemma...` →
   openai-compatible). Pausiert nur wenn der gleiche Engine gerade
   von User-Turns belegt wird, ignoriert User-Turns auf anderen
   Engines (opus parallel zu gemma-Dream wäre OK). Aufwendiger, aber
   genauer.

**Aufwand:** Stufe 1-4 etwa ein halber Tag. Stufe 5 weitere halbe
Tag. Tests: User-Turn auslösen während Dream läuft → sehen dass
Dream pausiert und beim nächsten Idle weitermacht.

**Trigger fürs Bauen:** sobald wir wieder regelmäßig `idleMinutes` <
30 brauchen (z.B. wenn AutoDream sehr aktiv lernen soll), oder sobald
Live-Use mit gleichzeitig laufenden Dreams kollidiert. Bis dahin reicht
der Hotfix (`idleMinutes: 60`).

**Code-Pointer:**
- `src/dream/auto-worker.ts` — AutoDreamWorker class
- `src/dream/extract.ts` — AbortSignal-Hookup im LLM-Call schon da
- `src/server/run-turn.ts` — runChatTurn (für Counter-Hooks)
- `src/tools/agents/spawn.ts:runOneSpawn` — sync-Spawn (für Counter-
  Hooks im wait:true-Pfad)

---

## Cross-Reference: 3-Repo-Research-Pointers (DECISION #38)

Vor jeder neuen Phase erst hier reinschauen — siehe DECISION #38
(Pre-Build Research Convention). Pro kommende Phase die fertigen
Vorlagen aus claude-code-source / OpenClaw / unsere Hermes-Notizen,
die direkt anwendbar sind. Aus dem Skim 2026-05-04 abend:

### Phase X — Skill-Handling

**claude-code-source — direkter Bauplan:**
- `src/skills/bundledSkills.ts` → `BundledSkillDefinition`-Schema:
  `name, description, aliases, whenToUse, argumentHint, allowedTools,
  model, disableModelInvocation, userInvocable, hooks,
  context: 'inline'|'fork', agent, files, getPromptForCommand`
- `src/skills/bundled/loop.ts`, `simplify.ts`, `verify.ts`, `debug.ts`,
  `remember.ts`, `stuck.ts`, `batch.ts`, `keybindings.ts`,
  `updateConfig.ts`, **`skillify.ts`** (Skill-Creator-Skill, self-
  improvement-Pattern!), `claudeApi.ts`, `loremIpsum.ts`, `dream.ts`,
  `hunter.ts` — 14 konkrete Beispiel-Skills als Referenz.
- `src/skills/bundled/index.ts` → `initBundledSkills()`-Pattern,
  feature-flag-Gating per Skill.
- `src/skills/loadSkillsDir.ts` → File-System-Skill-Loading.
- `src/skills/mcpSkillBuilders.ts` → Skills aus MCP-Servers ableiten.

**OpenClaw — Disk-Skills + 60+ Beispiele:**
- `~/.openclaw/skills/<name>/SKILL.md` mit Frontmatter (AgentSkills.io-
  Spec). Production-real, editierbar mit normalem Editor.
- `~/.openclaw/skills/obsidian/SKILL.md` — Obsidian-konkretes Beispiel.
- `~/.openclaw/skills/tmux-agent-teams/SKILL.md` — Pattern für
  Multi-Agent-Workflows (relevant für Phase 5b).

**Pattern bestätigt:** Skills sind **Prompts die Tools aufrufen**, nicht
Tools selbst. Sowohl claude-code-source als auch OpenClaw bestätigen.

### Phase 5 — exec + tmux

**claude-code-source — fertige Module:**
- `src/tasks/LocalShellTask/` → `spawnShellTask`, `registerForeground`,
  `unregisterForeground`, `backgroundExistingForegroundTask`,
  `markTaskNotified`, `killShellTasks`. Foreground/Background-Pattern
  schon ausgereift.
- `src/tools/BashTool/`:
  - `bashSecurity.ts` → produktions-reifer Hard-Blacklist
  - `bashPermissions.ts` → `permissionRuleExtractPrefix`,
    `commandHasAnyCd`, `matchWildcardPattern`
  - `pathValidation.ts`, `readOnlyValidation.ts`
  - `shouldUseSandbox.ts` + `SandboxManager`
  - `commandSemantics.ts` → `interpretCommandResult` (was bedeutet
    welcher Exit-Code?)
  - `parseSedEditCommand.ts` → sed-Sicherheit (sed kann beliebig
    schreiben!)
- `src/tasks/types.ts` → `TaskState` Discriminated-Union als Vorbild.

**OpenClaw — Backend-Wahl:**
- `exec`-Tool mit `host: 'auto'|'sandbox'|'gateway'|'node'`
- Backend Session-Level-Config, nicht Tool-Argument
- `process` als Dispatcher mit `action`-Enum (8 Aktionen)

**Aus unserem Research-Doc:**
- `docs/research/tool-architecture.md` §2.2 "Exec/Terminal"
  (OpenClaw vs Hermes-Vergleich)
- Hermes' `notify_on_complete` + `watch_patterns` als
  Push-Pattern-Vorbild

### Phase 6c — agent_ask Modus 2

**claude-code-source:**
- `src/tools/AgentTool/agentMemory.ts` + `agentMemorySnapshot.ts` →
  Memory-Snapshots beim Sub-Spawn (Polish-Vorteil über unser aktuelles
  Setup, das nichts kopiert).
- `src/tools/AgentTool/forkSubagent.ts` → Fork-Pattern (Modus-3-Ansatz
  für später, wenn Lisa Hans's Context erbt).
- `src/tools/AgentTool/runAgent.ts` mit `createSubagentContext`,
  `executeSubagentStartHooks`, `recordSidechainTranscript` →
  Transcript-Trennung pro Sub.
- `src/utils/forkedAgent.ts` → `CacheSafeParams`,
  `createSubagentContext` Helpers.
- `src/services/mcp/client.ts` → `connectToServer`, `fetchToolsForClient`
  → Sub-Agents mit eigenem MCP-Client.

**OpenClaw:**
- `subagent-spawn-*.js` und `subagent-announce-*.js` → live-messaging-
  Patterns (subagent_followup runtime).
- `waitForDescendantSubagentSummary` → Pattern für „wenn Sub-Sub
  fertig wird, fasse zusammen und reiche hoch".

### Phase 4-Polish (verstreut)

**claude-code-source:**
- `src/query/stopHooks.ts` → **Vereinheitlichung von Lifecycle-Hooks**
  (autoDream, extractMemories, promptSuggestion alle als stopHooks).
  Direkt für unser Polish: Dream-Mode + Memory-Extraction
  konsistent als Hook-System.
- `src/services/policyLimits/` + `claudeAiLimits.ts` → **Per-Provider-
  Concurrency-Lock** + Rate-Limit-Awareness. Direkt anwendbar gegen
  unseren mlx-omx-Stau.
- `src/Tool.ts` `buildTool()` mit Defaults (`isReadOnly`,
  `isDestructive`, `checkPermissions`, `isConcurrencySafe`,
  `toAutoClassifierInput`) → erweiterbares ToolDefinition-Schema.
- `src/services/notifier.ts` → Hermes-Style notify-on-complete-
  Mechanik wenn wir's mal bauen wollen.
- `src/utils/forkedAgent.ts:CacheSafeParams` → Prompt-Caching-Aware
  Sub-Spawns (relevant fürs Caching-Polish).

### Allgemein

**claude-code-source — `feature('FOO')` build-time-flags via `bun:bundle`:**
Code wird beim Build eliminiert wenn Feature aus. Bei uns relevant
falls wir z.B. exec hinter Feature-Flag releasen wollen, Default off.

**claude-code-source — `src/memdir/`:**
Memory-Directory-Pattern (analog zu unserem Memory-Layer mit
Markdown-as-Source). Konvergente Evolution — gut zur Validierung.

---

## Phase X — Skill-Handling — SCAFFOLD + DOCS DONE 2026-05-07

**Status: end-to-end implementiert + Hans-verifiziert + dokumentiert.**
Diskussions-Runde + Recherche-Runde durchgegangen, alle 9 Fragen unten
adressiert (im Design-Doc, nicht hier — die Liste bleibt als historische
Referenz stehen). Implementierungs-Commits: `9d385aa`, `2b131c7`,
`23be832`, `148938d`, `0e1d7f0`. Tool-count 35 (`skill` neu).

**Was drin ist:**
- `~/.somora/skills/<slug>/SKILL.md` — agentskills.io-Format mit
  somora-Extras unter `metadata.somora.{when_to_use, requires.{bins,
  config}, tags}`
- `<available_skills>`-Registry im cached prefix (XML Standard, Compact-
  Format-Fallback bei Overflow, OpenClaw-Defaults 150/18000/256k)
- `skill({name})`-Tool für on-demand Body-Load mit Mutex zu `keys`,
  klaren Errors, Body-Refresh per Aktivierung
- Per-Agent Allow-List in `agent.yaml.skills`, leer/fehlend = alle
- `registerAllTools()` Single-Source für Tool-Registrierung über alle
  drei Engines hinweg
- Doku: `private/skills-design.md` (Architektur-Rationale) +
  `docs/skills.md` (User-Reference) + `docs/tools.md`-Update

**Hans's Self-Bootstrap-Test 2026-05-07 abend:** Hans hat sich selbst
einen `test-greeting`-Skill via `file_write` angelegt (aus der
`skill`-Tool-Description abgeleitet), der erschien im nächsten Turn
im Index, Hans hat ihn via `skill({name})` aktiviert und korrekt mit
"Hallo Welt!" geantwortet. Self-Bootstrap-Capability bestätigt.

**Phase X.1 — noch offen (organisch, nicht prefabriziert):**
- Echte Real-World-Skills unter `~/.somora/skills/` — kommen wenn
  Rene reale Workflows hat die er häufig macht und automatisieren will.
  Bewusst NICHT von mir ad-hoc gebaut.

---

**Historischer Kontext** (vor dem Bauen geschrieben, bleibt als Referenz):

**Was Skills sind** (aus `docs/research/tool-architecture.md` §3):
Markdown-Files mit YAML-Frontmatter (AgentSkills.io-Spec), die dem
Modell „benutze Tool X dafür, hier ist das Pattern" sagen — separate
Schicht über den getypten Tools. OpenClaw hat 60+ Skills + ~30 Tools,
Hermes hat skills via eigene `skills_list`/`skill_view` Tools mit
Self-Improvement-Loop.

**Warum aufs Radar geholt:** wir hatten ~25 Tools nach Phase 6b.5
(jetzt 35 nach Phase X). Die Schwelle „lohnt sich" liegt laut der
OpenClaw-Erfahrung bei 10+. Skills sind die natürliche Antwort auf
Use-Cases die als Tool zu spezifisch wären (Patterns, keine Funktionen).

**Original-Diskussions-Liste (alle adressiert in `private/skills-design.md`):**

1. **Skills ≠ Tools — wie streng?** OpenClaw zieht harte Trennung
   (Skill kennt Tool nur über Description, Skill macht keine Calls).
   Hermes integriert via `skills_list`/`skill_view` Tools und erlaubt
   Skills die Tools direkt aufrufen. Entscheidung beeinflusst alles
   weitere: Routing, Self-Improvement, Discovery.

2. **Storage-Location:**
   - Per-Agent in `~/.somora/agents/<name>/skills/<slug>/SKILL.md`?
   - Global in `~/.somora/skills/<slug>/SKILL.md` (alle Agents teilen)?
   - In Obsidian-Vault als markierte Notes (wie OpenClaws Skills,
     editierbar mit normalem Editor)?
   - Mischung — global default + per-Agent override?

3. **Frontmatter-Schema:** AgentSkills.io-Spec direkt übernehmen?
   Eigene minimale Variante? OpenClaws `requires.bins` /
   `requires.config` finde ich elegant (Skill sagt selbst was es zum
   Funktionieren braucht).

4. **Discovery:** Wie findet das Modell relevante Skills?
   - All-skills im System-Prompt — funktioniert nur bei <20 Skills
   - Memory-Recall-Style: Hybrid-Search auf Skill-Descriptions, Top-N
     im ephemeralContext (wäre konsistent mit unserer Memory-Layer)
   - Tool-getrieben (Hermes-Style): `skills_list({ topic })` + `skill_view`

5. **Self-Improvement-Loop (Hermes-Pattern):** Soll der Agent eigene
   Skills erstellen können? Wenn ja: wer reviewed? User? Dream-Worker?
   Auto-Promotion nach N erfolgreichen Anwendungen?

6. **Verhältnis zu Memory:**
   Memory = „erinnere dich an Renés Vorlieben"
   Skills = „so machst du Aufgabe X"
   — sauber zu trennen oder soll Memory Skills referenzieren? Was wenn
   Memory-Note und Skill widersprechen?

7. **Verhältnis zu Persona** (AGENTS.md/SOUL.md/USER.md):
   AGENTS.md sagt heute schon „so denkt Hans". Würde Skill-Layer
   teilweise dasselbe? Konkret: ist „Hans benutzt für Daily-Notes
   immer Wikilink-Format" Persona oder Skill?

8. **Verhältnis zu Tool-Descriptions:** unsere Tool-Descriptions sind
   bereits sehr policy-lastig („IMPORTANT: state pending is NOT an
   error" etc.). Wo zieht man die Grenze zwischen „ausführliche Tool-
   Description" und „eigener Skill"?

9. **Verhältnis zu OpenClaws AgentSkills.io spec:** Wir wollen vermutlich
   kompatibel bleiben — aber müssen wir 1:1 spec sein oder reicht
   „lesbar, übertragbar"?

**Wann:** als eigene große Phase, wahrscheinlich nach Phase 5 (exec)
und 6c (agent_ask) — also gleiche Reihenfolge wie der Maintenance-Sweep
unten. Phase 5 + 6c sind fundamental für die Tool-Surface, Skills
setzen darauf auf.

**Aufwand-Schätzung (Bauchgefühl, vor Diskussion):** 3-5 Tage. Storage
+ Frontmatter-Parser + Discovery + Tool-Anbindung + 5-10 erste Skills
zum Testen.

**Vorgehen wenn wir ankommen:**
1. Diskussion zur 9-Punkte-Liste oben (1-2 Sessions)
2. Konzept lockschreiben in eigenem `private/skills-design.md`
   (analog zu A2A-design.md)
3. Iterativ implementieren mit ständigem User-Feedback

**Bis dahin:** **nicht** unilateral anfangen, **nicht** halbgar in
Phase 4-Polish reinrutschen lassen. Skills brauchen ihre eigene
Konzept-Phase mit User-Buy-In, weil's strukturell viele Fragen aufwirft
die später teuer zu ändern sind.

**Code-Pointer für späteren Start:**
- `docs/research/tool-architecture.md` §3 — Skills-vs-Tools-Recherche
- `~/.openclaw/skills/` — 60+ Real-World-Skills als Vorlage
- `~/.openclaw/skills/obsidian/SKILL.md` — Obsidian-konkretes Beispiel

---

## Phase Y — Vision / Multimodale Inputs — Y.A.1 + Y.A.2 DONE 2026-05-07 (commits `2ccde5d`, `da1c6b1`)

**Status: Phase Y funktional komplett für agent-driven workspace-drop UX.** Y.A.1 brachte `analyze_file` (Worker-Dispatcher) + `file_read` MIME-Guard. Y.A.2 brachte file_read polymorph für Image + PDF mit Cross-Engine-Plumbing (ToolDefinition-Vertrag, MCP-Forwarding, openai-compatible adapter, ToolContext.activeModel). PDFs werden zu PNG-Pages gerendert via `pdf-to-img` (kein System-Dep). Live-verifiziert: claude-cli/Opus beschreibt Falken + extrahiert Rechnungs-Werte exakt; openai-compatible/gemma4big sieht Bilder korrekt.

**Y.B deferred** auf Folgetag mit TUI: User-Attachment-Pfad (TUI paste/drop, /chat/send body extension um attachments[], Content-addressed Storage `~/.somora/attachments/<sha256>.<ext>`, JSONL persistence). Native PDF-document-blocks (Anthropic) und input_file (OpenAI) ohne Rasterization wären dann verfügbar. Multimodal-Module sind passend designt.

**Y.B deferred** unbestimmt: Client-Attachment-Pfad (TUI/web paste/drop, /chat/send body, Content-addressed Storage `~/.somora/attachments/<sha256>.<ext>`, JSONL persistence). Multimodal-Module sind bereits passend designt.

---

**Historischer Kontext** (vor dem Bauen geschrieben, bleibt als Referenz):

**Auslöser:** Test mit Hans 2026-05-06: User legt
`rene_falcon_desert.png` in `~/somoraworkspace`, fragt „was ist auf
dem Bild". Hans kann nur Metadaten abfragen (`file`, `identify`) —
ohne Bildinhalt. Architekturell kein Bug, sondern fehlende Phase: es
existiert aktuell weder ein Image-fähiges Tool noch eine Attachment-
Surface in `/chat/send`.

### Drei Lücken die zugemacht werden müssen

1. **Kein image-fähiges Tool.** `file_read` returnt UTF-8-Text.
   Bei einer PNG kommt Garbage raus.
2. **`/chat/send` kennt keine Attachments.** Body ist
   `{ text: string }`. Selbst wenn der User ein Bild im Workdir hat,
   gibt es keinen Pfad es als Vision-Input mitzugeben.
3. **Engine-Adapter routen nur Text.** `TurnInput.userMessage:
   string`. Anthropic + OpenAI SDK können beide Vision-Content-Blocks,
   aber unsere Adapter mappen User-Nachrichten nur auf Text-Blocks.

### Was bereits ready ist

Model-Layer ist vorbereitet — alle drei vision-fähigen Modelle
deklarieren `capabilities: [text, image, ...]` in der `config.yaml`:
- claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5 (claude-cli)
- gpt-5.5, gpt-5.4-mini (codex-cli)
- gemma4big, gemma4small (omlx via openai-compatible)

Sobald die Adapter-Surface da ist, können diese Modelle Bilder
konsumieren ohne weitere Engine-Arbeit.

### Zwei Bauwege (in Reihenfolge der Empfehlung)

**(A) Tool-Pfad — Agent fragt selbst nach dem Bild.** Kleinere
Surface, agentenseitig, natürlicher erster Schritt:

- Neues Tool `image_read({ path, target? })` returnt MCP-Image-
  Content-Block: `{ type: 'image', data: <base64>, mimeType:
  'image/png' | 'image/jpeg' | ... }`.
- claude-cli + codex-cli: ihre MCP-Pipeline reicht Image-Content
  natively durch zur Model-Conversation. Adapter-Code Null.
- openai-compatible: braucht Erweiterung — tool_result aktuell
  nur Text. OpenAI's Spec erlaubt `content: [{type:'image_url',
  image_url:{url:'data:image/...;base64,...'}}]` als tool_result.
  Adapter muss das in `loopMessages.push({role:'tool', content:[...]})`
  einbauen.
- Hard-Cap auf File-Size (max 5MB Image bei Anthropic, 20MB bei
  OpenAI), Format-Whitelist (png/jpeg/webp/gif), MIME-Detection per
  magic bytes (nicht via Extension — Trust-Boundary).

Dauer: ~halber Tag wenn Vision-Adapter-Erweiterung sauber bleibt.
Größtes Risiko: openai-compatible MCP-tool-result-Schema bei lokalen
Servern (omlx, ollama) ist nicht standardisiert — ggf. Engine-Switch
oder Per-Engine-Override.

**(B) Attachment-Pfad — User schickt Bild mit dem Turn.** Größere
Surface, userseitig, zweiter Schritt nach (A):

- TUI nimmt Image-Paste / Drag-Drop. Ink hat keinen nativen Image-
  Support; vermutlich Pfad-Eingabe oder Clipboard-Read via Bash-Hook.
- `POST /chat/send` Body erweitert: `{ text, attachments?: [{ kind:
  'image', source: 'path'|'base64', value, mimeType? }] }`.
- Server: load → base64 → MIME-detect → in user-Message-Content-Array
  mappen pro Engine.
- JSONL-Persistenz: `user_message.attachments[]` mit (path-ref, hash,
  mimeType, bytes). Bytes selbst NICHT in JSONL (zu groß für
  Cache-Reconstruction); stattdessen Content-addressed Storage in
  `~/.somora/attachments/<sha256>.<ext>`.
- Cache-Implikation: Vision-Tokens sind teuer (Anthropic ~1300
  tokens pro 1024×1024 Bild). Stable-front-Pflicht (DECISION #40):
  Image-Block muss VOR dem variablen Memory-Block stehen sonst
  invalidiert jeder Turn den ganzen Cache.

Dauer: ~Tag, davon das meiste TUI-Paste/Drop-Handling und JSONL-
Schema-Erweiterung.

### Reihenfolge + Wann

- **Nach Phase X (Skills)** — Skills sind erstmal die größere
  Architektur-Frage; Vision baut darauf nichts auf.
- **(A) zuerst, (B) später bei Bedarf.** (A) deckt 80% (Agent will
  selbständig ein Bild prüfen, das im Workspace liegt). (B) erst wenn
  klar wird dass User regelmäßig Bilder direkt in den Turn paste'n
  will — bisheriger Use-Case ist „User kopiert Datei ins Workdir,
  fragt Agent".

### Diskussions-Punkte für die spätere Konzept-Phase

1. Streaming-Bilder (Webcam-Feed)? Aus heutiger Sicht: nein.
2. Image-Generation-Tools (DALL-E / Stable Diffusion via lokales
   ComfyUI)? Anderes Thema, eigene Phase.
3. Audio-Inputs (Whisper, Vision-Audio-Modelle)? Weiter weg, separate
   Phase wenn überhaupt.
4. Cache-Strategie pro Image: einmal hash'n, in JSONL referenzieren,
   bei Recall im selben Turn nicht doppelt schicken — Detail-Frage
   für Konzept-Phase.

### Code-Pointer für späteren Start

- `src/tools/file/local.ts:fileRead` — als Vorlage für `image_read`
- `src/engine/openai-compatible.ts` — tool_result-Loop ist die Stelle
  für multimodalen Content
- Anthropic SDK: Image-Block-Spec in `claude-agent-sdk` — schon im
  Type-System verfügbar, müssen wir nur passieren lassen
- omlx + gemma4: User hat Vision-Tests gemacht, wir sollten den
  empirisch verifizieren bevor wir auf API-Spec vertrauen

---

## Dependencies + SDK-Audit-Sweep — Maintenance-Sweep 1 done 2026-05-05

**Status: durchgeführt 2026-05-05 spätabend (commit `42fee3f`).**

Sweep-1-Resultat — alles über zwei Wellen + Final-Integration grün:

| Komponente | Vorher | Nachher | Welle |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.2.123 | 0.2.128 | A |
| `hono` | 4.12.16 | 4.12.17 | A |
| `ink` | 7.0.1 | 7.0.2 | A |
| `openai` | 6.35.0 | 6.36.0 | A |
| `zod` | 4.4.1 | 4.4.3 | A |
| `@openai/codex` (binary) | 0.125.0 | 0.128.0 | B |
| `claude-cli` (binary) | 2.1.128 (sync) | unverändert | — |

**Smoke-Befunde:**
- claude-cli engine + codex-cli engine + openai-compatible alle
  grundsätzlich funktional nach dem Bump
- agent_ask cross-engine: jarvis(opus) → lisa(gpt55) grün
- spawn_subagent self-clone: HTTP-Fallback OK
- Codex MCP-Pfad: lisa ruft memory_search via codex's MCP child,
  korrekt geparst
- Codex NDJSON-Format unverändert für unsere Pfade (thread.started,
  turn.started, item.completed, turn.completed)
- Codex `--sandbox read-only` weiter akzeptiert
- Pattern 2 (async lifecycle) + Pattern 4 (cross-engine spawn)
  beide nach Bumps grün

**Eine Adapter-Anpassung nötig** (commit `5bd7fc1`):
Codex 0.128 hat das Feature `general_analytics` aus seinem Catalog
**komplett entfernt** (anders als andere "removed but kept in catalog"
Features). Unser `CODEX_DISABLED_FEATURES`-Array enthielt es noch,
codex 0.128 errorte mit `Unknown feature flag: general_analytics`
und brach jeden codex-Turn.

**Wichtig:** Der Initial-Smoke hatte das verfehlt weil unser
Fallback-Chain (lisa hat `fallback: opus`) jede codex-fail-Anfrage
silently auf opus weitergeleitet hat — User-visible Output sah
plausibel aus, aber kam von der falschen Engine. Erst beim Nach-Check
durch User, der `engine.fail` im Log gesehen hat, ist der Bug
aufgefallen.

**Smoke-Lessons-Learned** für künftige Sweeps:
- Per-Welle-Smoke MUSS prüfen welche Engine geantwortet hat — nicht
  nur dass eine Antwort kam. Check `ChatTurnResult.{provider,model}`
  oder den server-side `engine.turn`-Log-Event.
- Server-Logs auf `engine.fail` / `engine.fallback_to` greppen
  während Smoke. Fallbacks machen CLI-Engine-Breakage am HTTP-Layer
  unsichtbar.

**Nächster Sweep:** wenn npm outdated wieder >3 Patches anzeigt
oder ein Trigger aus dem Block weiter unten greift.

---

### Original-Plan (für Trajectory bei kommenden Sweeps)

Periodisches Update aller Build-Inputs, weil somora drei externe
Komponenten gepinnt einbindet und keine davon automatisch erneuert
wird. Stand-Snapshot 2026-05-04 abend:

| Komponente | Wir | npm-latest | Wie aktualisiert |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` (npm dep) | 0.2.123 | 0.2.126 | `npm update @anthropic-ai/claude-agent-sdk` (oder gezielt `@latest`) |
| `claude-cli` binary (~/.local/bin/claude) | 2.1.126 | 2.1.126 (sync) | `npm install -g @anthropic-ai/claude-code@latest` |
| `@openai/codex` binary (npm-global) | 0.125.0 | 0.128.0 | `npm install -g @openai/codex@latest` |

Plus: alle anderen npm-Deps mit `npm outdated` durchgehen und
gezielt bumpen (sqlite-vec, chokidar, ssh2, pino, hono, etc.).

**Was zu tun ist beim Sweep:**
1. **Bestandsaufnahme:** `npm outdated`, plus `npm view <pkg> version`
   für die zwei Binaries. Alles in einer Übersichts-Tabelle.
2. **Read changelogs / release notes** für die wichtigen drei
   Komponenten. Vor allem für claude-agent-sdk und codex-cli — beide
   haben uns heute (2026-05-04) mit unbekannten Tool-Timeout-Limits
   überrascht (claude 5min hardcoded, codex 60s default). Vielleicht
   gibt es in neueren Versionen weitere Tunables die uns interessieren.
3. **Bumpen in Wellen:**
   - Welle A: claude-agent-sdk patch-bumps (low risk)
   - Welle B: codex-cli minor-bumps (event-format könnte sich ändern,
     siehe codex-cli.ts NDJSON-mapping)
   - Welle C: claude-cli (binary) selbst — sehr selten breaking, aber
     Settings-Schema könnte erweitert sein
   - Welle D: andere npm-Deps (sqlite-vec etc., minor + patch)
4. **Smoke-Tests pro Welle:** dieselbe 5-Pattern-Test-Matrix wie am
   2026-05-04 (payment, pending, maxRounds, cross-engine, recursion-cap).
   Auf allen drei Engines. Wenn was breaks → entweder rollback oder
   Adapter-Fix (typischer Kandidat: NDJSON-Event-Format-Änderungen
   in codex-cli).
5. **`MCP_TOOL_TIMEOUT` und `tool_timeout_sec` re-checken** — wenn
   neue SDK-Versionen die Defaults oder Mechanik geändert haben,
   müssen wir unsere config-Defaults anpassen. Plus: vielleicht gibt
   es jetzt offizielle Settings die wir bisher nicht kennen.
6. **Test-Tag dokumentieren** — Findings als Anhang an heutigen
   STATUS-Eintrag, damit der nächste Sweep die Trajectory sieht.

**Wann:** **nach Phase 5 (exec + tmux)** und **Phase 6c (agent_ask
Modus 2)** — das sind die zwei großen offenen Build-Phasen, die
Vorrang haben. Der Sweep wäre eine eigene Phase „**Maintenance-Sweep
1**" zwischen den Build-Wellen, etwa halben bis ganzen Tag.

**Trigger für ungeplanten Vorzieh-Sweep:**
- Wenn ein neuer claude-agent-sdk Release explizit Tool-Timeout-
  Mechanik-Bugfixes erwähnt (das hilft uns mit DECISION #37)
- Wenn ein codex-Release neue MCP-Settings oder Event-Format-Fixes
  bringt
- Wenn ein User Bug reproducible nur in unserer alten SDK-Version
  auftritt

**Why das nicht als Phase 4-Polish:**
Phase 4-Polish ist intern (Caching aktivieren, Multimodal, Token-
Counting). Dependency-Sweep ist external — andere Repos, andere
Velocity. Eigene Phase macht klar dass wir bewusst auf Versions-
Pinning setzen (reproducible builds) und der Sweep eine bewusste
Wartungsentscheidung ist, kein „mal eben".

---

## Phase 3+ — Voice / Realtime, Telegram-Channel, andere Frontends

Steht im STATUS noch als „Phase 3". Kein neues Konzept hier, nur Notiz
dass diese Themen explizit hinter den oben genannten anstehen.

---

## memory_search transitive Wikilink-Expansion (entdeckt 2026-05-09)

**Status:** Backlog. Aktuell macht `memory_search` keine Graph-
Traversal über Wikilinks — `[[orte/garten]]` wird als Text indiziert
(FTS tokenisiert die Brackets weg, Embedder sieht den Rohtext), aber
ein Hit auf eine Page A die `[[B]]` erwähnt liefert NICHT automatisch
auch B als Folgehit. Karpathy-Pattern: Agent sieht den Wikilink im
Inject-Block und entscheidet selbst per `memory_get` ob er den
nächsten Hop will.

**Mögliche Form:**
```ts
memory_search({
  query: 'familie luca',
  expandLinks: true,           // default false
  expandDepth: 1,              // hops via [[wikilink]] tokens
})
```
- Top-N Hits wie bisher.
- Pro Hit: parse `[[...]]` Tokens raus, mappe auf wiki-slugs, lade
  per memory_get, hänge als zusätzliche Hits an mit reduziertem Score
  (z.B. `score * 0.7^hop_distance`).
- Capping notwendig: max N expanded hits, max depth 1-2, Cycle-Detect.

**Wann lohnt es sich:**
Wenn der User bemerkt dass Agents bei zusammengesetzten Fragen
(„wer ist Luca und in welchem Auto fährt sein Onkel?") zu viele
manuelle `memory_get`-Hops brauchen. Dann ist die explizite Expansion
ein UX-Hebel — sonst Backlog.

**Why nicht jetzt:**
- Aktuelle Mechanik ist intentional (Karpathy-Pattern) und
  funktioniert.
- Risk: Expanded Hits können den 1500-token-Block sprengen ohne
  Mehrwert wenn die verlinkte Page off-topic ist.
- Vor Implementierung: 5 echte User-Beispiele sammeln wo single-hop
  Search nicht reichte → datenbasiert tunen statt theoretisch.

---

## Cross-Refs Wiki → Vault-außerhalb-Wiki (entdeckt 2026-05-09)

**Status:** Backlog. Aktuell linkt Dream-B Wiki-Pages nur innerhalb des
Wiki-Subfolders ([[orte/garten]], [[personen/rene]] etc.). Cross-Refs
auf Vault-Dokumente außerhalb des Wiki-Subfolders (z.B.
[[Projekte/Privat/somora]]) macht Opus NICHT, weil `summarizeWiki()`
nur den Wiki-Subfolder walkt.

**Das ist bewusst so:**
- Vault außerhalb Wiki ist user-owned, ändert sich asynchron zu somora.
- Dream-B-generierte Refs würden dangling werden bei Renames im Vault.
- Karpathy-Pattern: Wiki = agent-kurierte Topologie, Vault außenrum = rohe
  User-Notizen. Verbindung läuft über Search (vault-Source mit boost
  0.65), nicht über explizite Edges.

**Falls doch implementieren:**
- Optional `vaultSummary` zum PROMOTE-Prompt addieren (Liste stable
  Vault-Pfade, evtl. nur Top-Level-Folder oder Files mit explizitem
  Marker im Frontmatter).
- Dream-C-Lint müsste Vault-Refs als „weak link" markieren (silent fail
  bei broken statt fix-Vorschlag).
- Opt-in per config.yaml `wiki.crossRefVaultEnabled: true`.

**Wann:**
Wenn ein konkreter User-Use-Case auftaucht („ich pflege im Vault eine
große Projekt-Doku, Wiki sollte explizit drauf verweisen"). Bis dahin
deckt Search den Bedarf.

---

## Optional `IDENTITY.md`-Slot im Persona-Loader (entdeckt 2026-05-09)

**Status:** Backlog. somora's persona-loader liest aktuell drei Files
(`AGENTS.md` required, `SOUL.md` + `USER.md` optional) plus `agent.yaml`.
Identitäts-Metadaten (Name, Description, Icon, Vibe-Statement) leben
in der `AGENTS.md`-Frontmatter und im SOUL.md-Body.

**Warum es als Backlog auftauchte:**
Bei der naxon-Migration aus openclaw fiel auf: openclaw hat ein
expliziter `IDENTITY.md`-Slot („Name", „Creature", „Vibe", „Emoji",
„Avatar"). Beim Übersiedeln musste ich den Inhalt manuell aufteilen
(Name/Description/Icon → AGENTS.md frontmatter; Vibe/Creature → SOUL.md
prose). Hat geklappt, aber jeder weitere openclaw-Agent würde dieselbe
manuelle Aufteilung brauchen.

**Mögliche Implementierung:**
- Persona-Loader erkennt optionales `IDENTITY.md`.
- Inhalt fließt VOR `SOUL.md` in den System-Prompt (als „Wer du bist"
  Block, vor „Wie du wirkst" / Verhaltensregeln / User-Context).
- AGENTS.md-Frontmatter bleibt source of truth für `name`/`description`/
  `icon` (für `/agents`-Listing). `IDENTITY.md` ist rein Prompt-Material.

**Wann:**
- Wenn ein zweiter openclaw-Agent migriert wird → Trigger.
- Oder wenn genereller Bedarf da ist, Persona klarer in „Identität vs.
  Vibe vs. Verhaltensregeln vs. User" zu strukturieren.

**Why nicht jetzt:**
Aktuell läuft naxon@somora gut. Die Aufteilung kostet einmalig 5 Min
manuelle Arbeit pro Agent — kein wiederkehrender Aufwand.

---

## Bootstrap-Compaction für Daily-Logs vor Memory-Migration (entdeckt 2026-05-09)

**Status:** Backlog. Bei der naxon-Migration aus openclaw kamen 92
Daily-Log-Files mit (Konversations-Snapshots aus openclaw-Sessions).
Diese landen im somora-Memory, sind durchsuchbar — aber Dream-B's
PROMOTE-Prompt blockt sie explizit („Is NOT a transient task list,
scratchpad, or daily log"). Heißt: die Essenz dort drin kommt nie
ins Wiki, bleibt nur via memory_search auffindbar.

**Idee:**
Vor zukünftigen Migrationen (oder regelmäßig als Wartungs-Job) ein
Bootstrap-Compaction-Worker:
- Opus-One-Shot-Run über alle Daily-Logs eines Zeitraums.
- Aufgabe: „destilliere wiederkehrende Themen, Personen, Decisions in
  ein monatliches Summary."
- Output: 1-3 thematische Memory-Files pro Monat (`2026-04-naxon-month-summary.md`)
- Daily-Logs danach optional archivieren oder als Read-Only behalten.

Die Monthly-Summaries würden dann beim nächsten Dream-B-Lauf als
substantielle Promote-Kandidaten gesehen und ggf. ins Wiki gehoben.

**Wann:**
Wenn ein User merkt „naxon findet sein Wissen aus Februar nicht mehr
weil es nur in Daily-Logs steht und Auto-Inject die nicht hochrankt".
Oder wenn weitere openclaw-Agents migriert werden.

**Why nicht jetzt:**
naxon hat erstmal die thematischen Memory-Files (people, history,
projects, etc.) — die decken die wichtigen long-term Konzepte ab.
Daily-Logs sind Bonus. Erst beobachten ob's ein echtes Problem wird.
