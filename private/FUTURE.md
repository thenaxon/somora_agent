# FUTURE — geplante Phasen, Konzepte, Ideen

Dieses File hält Konzepte fest, die _entschieden, aber noch nicht
gebaut_ sind. Wenn was hier reift und zur Implementierung kommt,
wandert die Substanz in `DECISIONS.md` als kanonischen Eintrag und
hier bleibt nur ein „done in commit X"-Marker.

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

## Phase X — Skill-Handling (geplant für eine der nächsten großen Phasen, vorher diskutieren)

**Status: nicht designt, nur als Konzept reserviert.** Wir wollen das
unbedingt bauen, aber nicht bevor wir uns über die offenen Fragen
unterhalten haben. Der Eintrag dient als „nicht vergessen + hier sind
die Diskussionspunkte".

**Was Skills sind** (aus `docs/research/tool-architecture.md` §3):
Markdown-Files mit YAML-Frontmatter (AgentSkills.io-Spec), die dem
Modell „benutze Tool X dafür, hier ist das Pattern" sagen — separate
Schicht über den getypten Tools. OpenClaw hat 60+ Skills + ~30 Tools,
Hermes hat skills via eigene `skills_list`/`skill_view` Tools mit
Self-Improvement-Loop.

**Warum jetzt aufs Radar:** wir haben aktuell ~25 Tools nach Phase 6b.5.
Die Schwelle „lohnt sich" liegt laut der OpenClaw-Erfahrung bei 10+ —
sind wir längst drüber. Plus Skills wären die natürliche Antwort auf
Use-Cases die als Tool zu spezifisch wären (z.B. „obsidian daily-note
erstellen mit unseren Konventionen", „payment-orchestration-vergleich
formatieren wie wir's mögen" — Patterns, keine Funktionen).

**Was vorher zu klären ist (Diskussions-Liste):**

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
- agent_ask cross-engine: jarvis(opus) → lisa(gpt55) PONG in 4.3s
- spawn_subagent self-clone: HTTP-Fallback OK
- Codex MCP-Pfad: lisa ruft memory_search via codex's MCP child,
  korrekt geparst, 4 hits returned
- Codex NDJSON-Format unverändert für unsere Pfade (thread.started,
  turn.started, item.completed, turn.completed)
- Codex `--sandbox read-only` weiter akzeptiert
- Pattern 2 (async lifecycle) + Pattern 4 (cross-engine spawn)
  beide nach Bumps grün

**Keine Adapter-Anpassungen nötig** — die SDK-Surfaces in dem
Versionsband waren backward-compatible.

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
