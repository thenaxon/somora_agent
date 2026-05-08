# somora — Status & Pickup-Point

Lebende Notiz für nahtlosen Wiedereinstieg in zukünftige Sessions.

---

## Wo wir stehen (Stand: 2026-05-09 nachts — Release `2026.05.09.1` Memory-Findability + MCP-Child-Fix)

**HEAD: `15f1267` auf main, gepusht. Lokal installiert (`somora-2026.05.09.1.tgz`), Server systemd-restart durch.**

### Was diese Tagesabschluss-Phase brachte

Über zwei Bumps ein kritischer Bug + drei Folge-Tunings für Memory-
Retrieval. Trigger war Renes Beobachtung dass Hans bei „welche autos
hab ich?" / „wer ist Luca?" konsistent 0 Memory-Hits hatte, obwohl die
Inhalte sichtbar im Vault lagen.

**Bump `2026.05.08.11` — MCP-Child Memory-Init-Bug (commit `479a840`):**
- `src/mcp/server.ts:75` rief `getMemoryManager(agent, { config: config.memory })` ohne `obsidian` + `wiki` auf.
- Folge: MCP-Child indexierte beim Init nur memoryRoot, walkte den Vault NICHT, und droppte beim `reindexAll` als `unindex_stale` JEDE Vault- und Wiki-Row aus der gemeinsamen sqlite-DB. Parent-Server hatte korrekte Refs, aber die Chunks-Tabelle war für 'vault' und 'wiki' permanent leer.
- Fix: MCP-Child reicht nun `{ config: config.memory, obsidian: config.obsidian, wiki: config.wiki }` durch — matcht run-turn.ts und server/index.ts.
- Live-verifiziert: hans's `memory.db` 21 memory + 125 vault + 4 wiki chunks (vorher 21 / 0 / 0). Search nach „renes-autos ferrari" liefert wiki/wissen/renes-autos als Top-Hit.
- Memory: `feedback_mcp_child_full_config.md` als Reviewer-Test-Hinweis.

**Bump `2026.05.09.1` — Memory-Findability-Tuning (commit `15f1267`):**
1. `autoInject.minScore: 0.5 → 0.35` — Single-Keyword-Queries erreichen wegen Vec-Recall-Limits oft nur ~0.30 hybrid (BM25-only Floor); bei 0.5 wurden Wiki-Hits weggefiltert.
2. `wiki.search.boostWiki: 1.0 → 1.4` — Curated Wiki-Pages ranken jetzt über generische Memory-Chunks die Vec-Recall fuzzy aufpickt. BM25-only Wiki-Match erreicht so ~0.42 hybrid.
3. `memory_search` Tool default `minScore: 0` (statt fallback auf autoInject) — agent-driven Search nicht mehr durch ambient Threshold gegated.
4. `wiki/index.md` regeneriert (war von meinem Stufe-5-Smoke gelöscht), Wiki-Overview-Block zeigt jetzt korrekt Topology in Auto-Inject.

### Phase-4-Stufe-5 Wiki-Lint (deterministisch) — DONE

Dream-C deterministische Checks live: `broken_wikilink`, `orphan_page`, `index_missing`, `index_stale`, `one_way_link`. Tools `dream_run({mode:'c'})` plus `/wiki/run-lint` Endpoint. Approval-Loop wie Dream-A. **Stufe 5.B (LLM-Lint: contradictions, stale time-claims) bewusst deferred** — Rene hat „solange will ich jetzt nicht warten" gesagt, kommt im nächsten Run.

### Recovery nach Smoke-Test-Schaden (rein narrativ)

Mein Stufe-5-Smoke hatte am 2026-05-08 in der Cleanup-Phase `rmSync(personenDir, { recursive: true })` gemacht und damit die promoteten `personen/*` Wiki-Pages gelöscht (rene, conny, familie-rene, projekte/familie-luca-podcast). Hans's Memory-Files waren danach Stubs auf gelöschte Pages → Dream-B's Merge-Route lief in „missing target" Skip. User entschied „lass es, daten kann ich neu erzählen" — nur familie-rene wurde rekonstruiert: Stub zu fresh memory zurück (frontmatter `promoted_to`/`promoted_at` raus, Body zu strukturierter Memory umgeschrieben), Dream-B-Lauf promoted als neue `personen/familie-rene` Page mit allen Familieninfos (Conny, Nathalie, Walter, Luca, Lilly, Lara) sauber strukturiert.

### Was Dream-B heute live geleistet hat

Drei Dream-B-Läufe: erster heute morgen mit 13 Promotions (initial Wiki-Aufbau), mittags Dream-B promoted `projekte/somora`, nachts Dream-B promoted `orte/blackcorner` + `personen/familie-rene`. Aktueller Wiki-Stand: 5 Pages in `orte/`, `personen/`, `projekte/`, `wissen/`. Index.md auto-regeneriert, log file `logs/2026-05.md` chronologisch.

### Klarstellungen mit Rene (heute besprochen, NICHT Code-Änderungen)

- **Wiki-Struktur ist LLM-driven**: Dream-B's PROMOTE_SYSTEM_PROMPT gibt Subfolder-Defaults (`personen/`, `projekte/`, `wissen/`, „may invent" wie `orte/`) und Page-Template (`## Aktueller Stand` / `## Eigenschaften` / `## Zeitleiste` / `## Notizen`). Skelett vorgegeben, Slugs + Subfolder-Wahl + Cross-Refs sind LLM-Entscheidung.
- **Dream-B splittet keine Multi-Subject-Pages**: wenn `personen/familie-rene` mit der Zeit zu viel über Conny enthält, würde Opus per default mergen statt eine eigene `personen/conny` zu spawnen — der „not already covered" Gate blockt. Workarounds: manueller Split in Obsidian; Prompt-Tweak in Dream-B; oder Future Dream-D Refactor-Worker.
- **Dream-C re-strukturiert NICHT**: aktueller Scope ist Hygiene (broken links, orphans, index-sync), keine Topologie-Änderungen.
- **Cross-Refs nur Wiki-intern**: Dream-B verlinkt nicht in den Vault außerhalb des Wiki-Subfolders — bewusst (ownership-boundary, dangling-refs Risiko, Karpathy-Pattern). Verbindung läuft über Search.
- **Wikilinks werden als Text indiziert, NICHT als Graph traversiert**: `[[orte/garten]]` ist BM25/Vec searchable, aber `memory_search` macht keine Link-Expansion. Agent muss expliziten zweiten `memory_get` machen.
- **Search liefert Chunks (snippets), nicht Full-Files**: `memory_search` returnt chunks.text mit reference; `memory_get reference` lädt das volle .md-File vom FS. Spart Tokens bei der Suche, Agent kann gezielt nachladen.

Backlog in FUTURE.md ergänzt:
- transitive Wikilink-Expansion in `memory_search` (`expandLinks: true`)
- Optional Cross-Refs Wiki → Vault-außenrum
- Optional `IDENTITY.md`-Slot im Persona-Loader (Kompat-Brücke zu openclaw)
- Bootstrap-Compaction für Daily-Logs vor Migration (Opus destilliert
  92 Daily-Logs zu monatlichen Summaries)

### naxon-Migration aus openclaw

Renes openclaw-Hauptagent („naxon", openclaw-intern als `main`) auf
somora übersiedelt. openclaw-Tree bleibt unangetastet, parallel-Betrieb
für 1-2 Wochen falls noch Files nachkommen.

**Persona** (`~/.somora/agents/naxon/`):
- `agent.yaml` — `model: opus`, `fallback: gemma4big`, dream-config 1:1 von hans
- `AGENTS.md` — neu zusammengestellt: Frontmatter mit `name=naxon, icon=⚡, description="Proaktiver digitaler Partner..."`, Body übernommen aus openclaw mit raus-gefilterten openclaw-specifics (Heartbeat-CLI, KiVault, Discord/WhatsApp-Formatting, Orbit-Tasks, Cron-Mechanik). Memory-Section auf somora-Pattern umgeschrieben (memory_search/get + Dream-A statt openclaw-Mechanik). Universal-Regeln + DB-Backup-Lesson erhalten.
- `SOUL.md` — 1:1 von openclaw (proaktiv-Vibe, Wow-Momente, Eigenständigkeit, „Mit Rene: Partnerschaft, nicht Dienstleistung")
- `USER.md` — 1:1 von openclaw (detailliertes Rene-Profil)

**Memory** (`~/.somora/agents/naxon/memory/`):
- 21 thematische Files (people, history, projects, properties, naxxen-deploy, naxxen-production, tools-* etc.)
- 91 daily logs aus root + 3 aus `daily/`-Subfolder = **115 Files total**
- Alle Slug-konform (SLUG_RE check passed: 0 invalid)
- openclaw-Begriffe in Daily-Logs bewusst gelassen (historischer Kontext)
- Nur Topical-File mit openclaw-Refs: `ollama-mac-studio.md` (3 legitime Modell-Namen-Refs wie `gemma4-openclaw:latest`, kein Rewrite nötig)

**Bewusst NICHT migriert:**
- `~/.openclaw/memory/main.sqlite` (53 MB) — eigenes DB-Schema, somora generiert sich Vector-Index aus den `.md`-Files neu.
- `~/.openclaw/agents/main/sessions/*.jsonl` — codex-app-server-Format inkompatibel mit somora's Event-Format. Sessions starten frisch.
- `IDENTITY.md`, `TOOLS.md`, `HEARTBEAT.md` — openclaw-spezifische Persona-Slots ohne somora-Equivalent. Identitäts-Inhalte sind in AGENTS.md frontmatter (Name/Icon/Description) und SOUL.md prose untergekommen.

**Server-Side:**
- Server kennt naxon automatisch (auto-discover via `listAgents()`).
- Erste Manager-Init lief 54s (Memory + Vault re-indexing + Embedder-Load).
- Cross-Agent-Wiki funktioniert: query nach „cornelia" liefert sowohl naxons own `memory/people` (score 0.67) als auch das geteilte `wiki/personen/familie-rene` (score 1.35) — beide Agents profitieren von hans's Promotion.

**Clarifications mit Rene aufgekommen während Migration (NICHT Code-Änderungen, nur Verständnis):**
- Dream-A geht Session→Memory, Dream-B geht Memory→Wiki. Wir wollten naxons Memory direkt copieren — Dream-Mechanik kommt erst im laufenden Betrieb dran.
- Dream-B's PROMOTE-Prompt blockt explizit daily-logs („Is NOT a transient task list, scratchpad, or daily log") — Daily-Memories bleiben als durchsuchbares Memory, kommen NIE ins Wiki. Das ist by design (kein Wiki-Müll), aber heißt: wenn der User die Essenz aus Daily-Logs ins Wiki ziehen will, braucht es einen Bootstrap-Compaction-Schritt VOR der Migration (siehe FUTURE).
- somora hat keinen IDENTITY.md-Slot — bewusste Vereinfachung von openclaw's 5-File auf 3-File-Persona. Inhalte fließen in AGENTS.md frontmatter + SOUL.md.

### Cleanup
- `~/.somora/agents/hans-debug/` removed — Diagnose-Test-Agent von der Memory-Search-Bug-Hatz, hatte 6 MB Sqlite-Wrack hinterlassen, kein Persona-File. Server hat ihn nie als Agent geführt (lädt nur Verzeichnisse mit `AGENTS.md`).

---

## Vorheriger Stand (Stand: 2026-05-08 sehr-spät — Release `2026.05.08.3` Multi-Engine Dispatcher)

**HEAD: tag `2026.05.08.3` auf main, gepusht. Lokal installiert.**

Bump enthält gegenüber `2026.05.08.2`:

### Stufe 4.5 — Multi-Engine Dream-B Dispatcher

Dream-B war bisher v1-beschränkt auf openai-compatible Worker. Mit diesem Bump unterstützt der Dispatcher alle drei somora-Engines:

- **openai-compatible** (existing): direkt via OpenAI SDK
- **claude-cli** (neu): one-shot via `@anthropic-ai/claude-agent-sdk` `query()`, ohne Tools/MCP/Session — nutzt User-Subscription
- **codex-cli** (neu): subprocess-spawn via `codex exec --json`, JSONL-Output-Parsing — nutzt User-Subscription

Code:
- `src/wiki/dream-b-llm.ts` (neu) — `callOneShotLLM()` mit drei Engine-Branches, Auth/Bin-Resolution analog zu den Chat-Engines
- `src/wiki/dream-b-dispatcher.ts` — Engine-Check raus, ruft callOneShotLLM, Parser bleiben

Real-getestet 2026-05-08: opus via claude-cli + gpt-5.5 via codex-cli haben beide auf einen "PING"-Smoke mit "PONG" geantwortet (smoke check-stage45-routing.ts, 7/7 grün). Plus Mock-Dispatcher-Smoke aus Stufe 3 (28/28 grün) zeigt dass der Refactor die existing Dispatcher-Contract nicht gebrochen hat.

### Aktivierung mit Subscription

Heute eingetragen in `~/.somora/config.yaml`:

```yaml
wiki:
  enabled: true
  promotion:
    model: opus
  lint:
    model: opus
```

Damit nutzt Dream-B (und später Dream-C) deine Claude-Subscription via claude-cli statt openrouter zu kosten.

**HEAD: tag `2026.05.08.2` auf main, gepusht. Lokal via npm-pack-Tarball installiert.**

Bump enthält gegenüber `2026.05.08.1`:

### claude-cli stale-session Fix (`71aa424`)

Wenn claude-cli's lokaler Conversation-Store eine alte SDK-Session-ID nicht mehr kennt, dropt der Engine-Catch-Block die stale `sdkSessionId` aus dem Session-Meta. Fallback startet damit eine frische Conversation statt nochmal die kaputte ID zu verwenden — kein manuelles `/reset` mehr nötig.

### Phase 4 — Wiki-Layer Stufen 1-4 komplett

Konzept aus `private/wiki-design.md` jetzt implementiert (4 von 6 Stufen):

| Stufe | Commit | Was |
|---|---|---|
| 1 — Foundation | `8eb53c9` | WikiConfig-Schema, ChunkSource erweitert um 'wiki', Source-Klassifikation, Search-Boost-Multiplier (wiki/memory/vault), src/wiki/conflict.ts (mtime), src/wiki/templates.ts (Wiki-Page + Stub-Templates) |
| 2 — Read-Side | `60a7bfc` | memory_*-Tools source-aware (memory_search source-Filter, memory_get wiki/-Pfad, memory_list source+pathPrefix, memory_write Stub-Detection); Auto-Inject erweitert um Wiki-Overview-Block; obsidian_*-Tools entfernt (33 statt 36 Tools) |
| 3 — Dream-B | `8dc1f09` | Server-globaler Promotion-Worker: fresh memory → wiki page mit Stub-Replacement, Stub-Observations → wiki-merge; mtime-Konflikt-Schutz; index.md regen + monatliche logs/YYYY-MM.md; real-clock 12h Scheduler + Pre-Sweep über autoDreamWorker.runPreSweep(); Manual-Trigger via wiki_run_promotion + wiki_status (35 Tools) |
| 4 — Dream-A wiki-aware | `551a504` | extract.ts: ExtractContext.referencedWiki + formatWiki + System-Prompt-Erweiterung mit Konflikt-via-Stub-Pattern; src/dream/wiki-context.ts neu — loadReferencedWiki kombiniert Stub-derived + Recall-derived; runner.ts wiret durch wenn config.wiki.enabled |

### Was Stufe 1-4 zusammen kann

Mit `wiki: enabled: true` in der config:

1. **Lesen:** Agents searchen + browsen das geteilte Wiki via `memory_*`-Tools mit `source: "wiki"`-Filter; Auto-Inject zeigt index.md-Overview als Header
2. **Schreiben (geteilt):** Dream-B konsolidiert agent-Memory ins Wiki alle 12h (oder via `wiki_run_promotion`-Tool sofort), respektiert mtime-Konflikte mit User-Edits
3. **Konflikt-Erkennung:** Dream-A liest auch Wiki-Pages (für Stubs + via Recall), erkennt Widersprüche zwischen Session und Wiki, schlägt memory_write auf Stub-Slug vor → Dream-B integriert beim nächsten Run

### Was NICHT in `2026.05.08.2` ist (kommt mit Stufe 5+6)

- **Dream-C / Lint** (Stufe 5): wöchentliche Wiki-Health-Checks für Widersprüche, stale claims, broken links, orphans
- **Bootstrap-Migration** (Stufe 6): einmaliger Run um existing 16 hans-Memories ins Wiki zu promoten

Beide nicht zwingend für ersten Real-Test — Lint wird erst bei Wiki-Drift relevant, Bootstrap kann durch normale Dream-B-Runs organisch ersetzt werden.

### Real-Welt-Test offen

Stufe 1-4 ist mit Smoke-Tests und Mock-LLM-Dispatcher verifiziert (74 Tests gesamt grün: Stufe 1=30, Stufe 2=37, Stufe 3=28, Stufe 4=8). **Was offen ist:** echtes Dream-B-Verhalten gegen einen realen Worker-LLM (gemma4big oder opus). Beim ersten echten Run wird Prompt-Tuning vermutlich nötig sein — aktuelle Prompts sind erste Iteration.

### Aktivierung

`config.wiki.enabled: false` ist Default. Zum Aktivieren minimal:

```yaml
wiki:
  enabled: true
  promotion:
    model: openrouter/anthropic/claude-opus-4-5   # smart Modell, kein Approval
  lint:
    model: openrouter/anthropic/claude-opus-4-5   # noch nicht implementiert
```

Vault muss in agent.yaml konfiguriert sein. Wiki landet in `<vault>/somora/`.

### Pickup-Satz für nächste Session

> "2026-05-08 sehr-spät — Release `2026.05.08.3` ist live: Multi-Engine Dream-B Dispatcher. Wiki-Layer ist in `~/.somora/config.yaml` aktiviert mit `promotion.model: opus` (via claude-cli, Subscription). 7/7 routing-smoke grün gegen real-LLMs (opus + gpt-5.5). **Nächster Schritt von Renes Seite:** Server restarten, dann via TUI auf Hans `wiki_run_promotion` aufrufen — das wird Dream-B mit echtem Opus über alle hans-Memories laufen lassen, wahrscheinlich Prompt-Tuning nötig. **Code-seitig nächstes:** Stufe 5 (Dream-C / Lint) + Stufe 6 (Bootstrap-Migration) sind die letzten 2 von 6 Stufen, beide nicht zwingend für ersten Run."

---

## Vorheriger Stand (Stand: 2026-05-08 abend — Erstes Release `2026.05.08.1` + Service-Mode-Workflow)

**HEAD: nach diesem Commit auf main, plus git tag `2026.05.08.1`.**

Heute (2026-05-08) wurden zwei Diskussions-Runden durchgezogen und die Service-Mode-Implementierung gebaut:

### DECISIONS

- **#41 Versionierung** (CalVer `YYYY.MM.DD.N` zero-padded, Schema-Version separat als integer pro Store, auto-migrate)
- **#42 Service-Mode** (single-active mit Lockfile-Disziplin, npm-globaler Distribution, CLI-Wrapper)

### Service-Mode-Implementierung (alle in diesem Commit)

- `bin/somora.mjs` — bin-entry, exposed via `package.json:bin` als `somora`
- `src/cli/somora.ts` — Top-level CLI mit subcommands: `init`, `server start|stop|restart|status`, `tui`, `update`, `--version`, `--help`
- `src/server/lockfile.ts` — single-active enforcement, PID-Liveness-Check, stale-lock-Reclaim
- `src/server/index.ts` — Lockfile beim Start (refuse on busy), released bei SIGTERM/SIGINT
- `src/version.ts` — single source of truth, liest `package.json:version`
- `package.json` — version `0.0.1` → `2026.05.08.1`, `bin`-Eintrag, `files`-Whitelist (bin/src/tsconfig/package.json/README/LICENSE), tsx von devDeps zu deps verschoben (Runtime-Dep für npm-globalen Install)
- `.gitignore` — `somora-*.tgz` ignoriert (npm-pack-Artefakte)

### Lokal installiert + smoke-getestet

```
~/.npm-global/bin/somora                          ← binary
~/.npm-global/lib/node_modules/somora/            ← prod copy (echte Copy, kein Symlink)
~/.config/systemd/user/somora.service             ← systemd User-Unit (von somora init)
~/.somora/locks/server.lock                       ← runtime lockfile
```

Smoke-Battery durchlaufen:
- `somora --version` → `2026.05.08.1`
- `somora --help` → Usage-Block sauber
- `somora init` → idempotent (created+kept-Listen, beim zweiten Run alles "kept")
- `somora server start` → läuft als systemd-User-Service, PID 997543 (lebte beim Test)
- `somora server status` → Lockfile + systemd-status korrekt
- HTTP `/agents` → liefert hans/jarvis/lisa
- `somora server stop` → Lockfile gelöscht, systemd inactive
- `somora tui` → Ink rendert (TTY-emuliert getestet, weil unsere Sandbox nicht TTY ist)

### Wichtige Lessons aus dem Bau

1. **`npm install -g .` macht einen SYMLINK**, kein Copy → defeats den Sinn von prod-vs-dev-Code-Trennung. **Lösung:** `npm pack` + `npm install -g <tarball>` macht echte Copy.
2. **tsx braucht `--tsconfig <path>`-Flag** wenn von außerhalb des Package-Verzeichnisses aufgerufen — sonst fällt JSX auf classic statt automatic mode zurück und alle .tsx files crashen mit `ReferenceError: React is not defined`.
3. **`process.argv[1]` ist die TS-Source unter tsx**, nicht die bin-entry. Für systemd-ExecStart muss die echte bin-entry-Pfad explizit durchgereicht werden — bin/somora.mjs setzt `SOMORA_BIN_PATH` env, src/cli/somora.ts liest's.

### Pickup-Satz für nächste Session

> "2026-05-08 spät-abend — Release `2026.05.08.1` ist live (commit `9695a04`, tag `2026.05.08.1`), Service-Mode läuft als systemd-User-Service mit Lockfile, `docs/install-and-release.md` als komplettes User-Manual. **Plus:** Phase-4-Diskussion (Memory/Dream/Obsidian Review) komplett durchgegangen — Architektur ist verbindlich entschieden, festgehalten in `private/wiki-design.md`. Kernentscheidungen: 2-Tier-Memory (per-agent short-term + server-global Wiki im Obsidian-Subfolder); 3 Dream-Modi (A=session→memory mit Approval, B=memory→wiki auto, C=Lint mit Approval); Stub-Pattern mit `## Recent observations` für Memory→Wiki-Pfad; Search-Ranking mit Source-Tags (wiki/memory/vault); Auto-Inject mit Wiki-Overview-Block. **Nächstes:** Implementation in 6 Stufen wie im Doc skizziert (Foundation → Read-Side → Dream-B → Dream-A wiki-aware → Dream-C → Bootstrap), 5-8 Bau-Tage geschätzt. Plus open: `feat(release)` Commit `71aa424` (claude-cli stale-session fix) sitzt auf main, wartet auf nächsten Bump. Phase Y (Multimodal) bleibt „halb getestet" — finaler Retest mit Phase Y.B. Public-Repo-Vorbereitung als eigene Diskussion bevor das anrollt."

---

## Vorheriger Stand (Stand: 2026-05-08 ~00:15 — Phase Y halb getestet, finaler Retest gemeinsam mit Y.B)

**HEAD: nach diesem Commit auf main, gepusht.** Phase Y.A.1 (`2ccde5d`) + Phase Y.A.2 (`da1c6b1`) live + cross-engine smoke-getestet, plus `pdf`-Capability config + openrouter-Provider-Setup + Test-PDF/Image im Workspace + Hans-Verifikations-Files für künftige Replays.

> **Wichtig — User-Verdict 2026-05-08 morgen:** Phase Y NICHT als „verifiziert komplett" abhaken. Der vollständige End-to-End-Retest erfolgt **zusammen mit Phase Y.B** (User-Attachments via TUI paste/drop), weil dann der UX-Pfad echt durchlaufen wird. Bis dahin gilt: live + smoke-getestet, aber Vollverifikation steht aus.

### Hans-Verifikations-Run 2026-05-07 spätnacht (Zwischenstand, nicht final)

User-driven 8-Modell × 7-Tests-Battery via TUI. Ergebnis: **claude-cli und codex-cli vollständig PASS, openai-compatible Engine-Pfad confirmed via Logs, kleinere Modelle nicht kompetent für Markdown-Test-Plan-Ausführung.**

| Modell | Engine | Status |
|---|---|---|
| Opus, Sonnet, Haiku | claude-cli | ✅ alle 7 Tests PASS |
| GPT-5.5 (fresh run) | codex-cli | ✅ 7/7 — das ist die wichtigste Bestätigung. Disproved meine Hypothese „codex-cli MCP image-Forwarding evtl. kaputt" |
| Gemma4big | openai-compatible (omlx) | ⚠️ T1+T2+T5-T7 PASS, T3+T4 (file_read polymorph) FAIL mit ollama `TypeError: terminated` nach 8 min unter Multimodal-Content-Load. Mein vorher-curl-Smoke gegen gemma war erfolgreich (Falke-Beschreibung returned) → Server-Capacity-Issue, kein somora-Adapter-Bug. |
| Haiku via openrouter (orhaiku) | openai-compatible (openrouter) | Pipeline confirmed via engine.init+turn logs, ABER Hans hat keine tool_use gefeuert (Small-Model-Pattern-Matching, siehe neue Memory) |
| MiniMax27, Kimi25 | openai-compatible (openrouter) | nicht systematisch durchgeführt — Modelle pattern-matchen Konversation ohne Tool-Calls auszuführen |

**Resultat-Files im Workspace:**
- `~/somoraworkspace/2026-05-07-phase-y-tests.md` (Test-Plan, dokumentarisch)
- `~/somoraworkspace/2026-05-07-phase-y-results.md` (alle Sektionen + Master-Tabelle am Ende)
- `~/somoraworkspace/2026-05-07-phase-y-findings.md` (Hans's Bug-Notes — gemma file_read polymorph Failure)
- `~/somoraworkspace/test-rechnung.pdf` + `rene_falcon_desert.png` als Test-Ressourcen (bleiben drin für künftige Replays)

### Memory-Lessons heute hinzugefügt (kumulativ)

- `feedback_tui_paste_burst.md` (Bug 10 Wurzel)
- `feedback_tmux_control_keys.md` (Bug 11 Wurzel)
- `feedback_dual_tool_registries.md` → `registerAllTools()` als Single Source
- `feedback_test_plans_for_small_models.md` (heute spätnacht): Markdown-Test-Plans funktionieren nur mit Top-Tier-Modellen. Für Cross-Engine-Verifikation lieber curl-Smokes vom Coding-Agent — was ich heute selbst erfolgreich gemacht habe gegen alle 3 Engines in 5 min.

### Lessons specifically für Phase Y

**Codex-cli MCP image-Forwarding funktioniert** — das war meine größte offene Sorge bei Y.A.2 (siehe Vorab-Recherche zu MCP content union: `text/image/audio/resource`, kein `document`). GPT55-fresh-run 7/7 PASS hat das definitiv geklärt. PDF-Polymorph-Pfad geht trotz fehlendem MCP-document-Type weil wir PDFs server-side zu PNG-pages rendern und als image-content forwarden. Beide CLI-Engines passen das nativ durch.

**Openai-compatible adapter image_url im tool_result** funktioniert für Cloud-Provider (Anthropic/OpenAI via openrouter). Bei lokalen Servern (ollama-style) je nach Server-Capacity unter Last fragil — aber das ist Server-Side, kein Adapter-Bug.

### Pickup-Satz für nächste Session

> "2026-05-08 ~00:15 — Phase Y ist live + smoke-getestet (claude-cli + codex-cli PASS, openai-compatible Pipeline OK), aber **explizit NICHT als verifiziert komplett abhaken** (User-Verdict 2026-05-08 morgen). Vollverifikation erfolgt gemeinsam mit Phase Y.B wenn der UX-Pfad (paste/drop) echt durchlaufen wird. HEAD auf main mit pdf-cap+openrouter-config+test-PDF+Verifikations-Files. Tool-count 36. **Nächstes:** zwei Diskussions-Runden (Versionierung à la OpenClaw datum-basiert + Service-Mode-Workflow somora server start mit shared `~/.somora/`), dann Phase 4 (Memory/Dream/Obsidian Review). Phase Y.B (User-Attachments via TUI/web) bleibt für eigenen Tag offen — wenn sie drin ist, wird Phase Y gesamt nochmal getestet."

---

## Vorheriger Stand (2026-05-07 sehr-spät — Phase Y.A.2 commit)

**HEAD: `da1c6b1`** auf main (Push folgt). Phase Y.A.1 (analyze_file + file_read MIME guard, commit `2ccde5d`) UND Phase Y.A.2 (file_read polymorph cross-engine + PDF→PNG render, commit `da1c6b1`) sind live und end-to-end gegen real-Claude verifiziert.

### Phase Y.A.2 — file_read polymorph cross-engine

ToolDefinition-Vertrag erweitert um `MultimodalToolResult` ({_somoraMultimodal:true, contentBlocks:[...]}). Registry detect+forward, MCP-Server emit `{type:'image',data,mimeType}` content-array (Protocol unterstützt image nativ, NICHT document — daher PDF→PNG-Render im Tool). openai-compatible adapter pusht image_url-Content im tool-message. ToolContext.activeModel durch alle 3 Engine-Pfade: in-process via run-turn.ts, MCP-Child via `SOMORA_ACTIVE_MODEL` env (claude-cli + codex-cli launcher setzen das jetzt). Capability-Gate: `image` capability für Image UND PDF (PDF wird ja gerendert).

PDF-Rendering via `pdf-to-img` (pure JS via pdfjs-dist, kein System-Dep wie poppler). Default 20 Seiten max, 1.5× scale. Truncation-Marker als text-Block bei Overflow.

**Live-Smoke-Battery:**
| Engine | Image | PDF |
|---|---|---|
| claude-cli/Opus | ✅ Falke + Wüste detailgetreu | ✅ "12345 / 1500 EUR" exakt |
| openai-compat/gemma4big | ✅ "Falke in Wüstenlandschaft" | ⚠️ Pipeline OK, gemma-OCR halluziniert (kein Code-Bug) |
| codex-cli/gpt-5.5 | nicht in Session getestet | nicht getestet (gleiche MCP-Pipeline wie claude-cli, high confidence) |

**Konsequenz für UX:** workspace-drop + reden funktioniert jetzt für Bilder UND PDFs gegen alle drei Engines. Genau das was der User explizit erfragt hatte.

### Phase Y.B — explizit offen für Folgetag

User-Attachment-Pfad (TUI paste/drop, /chat/send body extension um attachments[], Content-addressed Storage in `~/.somora/attachments/<sha256>.<ext>`, JSONL persistence path-ref+hash+mime, native PDF-document-blocks bei Anthropic, native input_file bei OpenAI). Multimodal-Helper-Module sind bereits passend designt für diesen zweiten Pfad.

### Pickup-Satz für nächste Session (überschreibt früheren)

> "2026-05-07 sehr-spät: Phase Y.A.2 ist drin (`da1c6b1`). file_read polymorph für Image + PDF, PDF→PNG render via pdf-to-img, Cross-Engine-Plumbing (ToolDefinition-Vertrag, MCP-Forwarding, openai-compatible adapter, ToolContext.activeModel). Live-verifiziert claude-cli + openai-compatible. Phase Y damit funktional komplett. Tool-count 36. **Nächstes:** Phase Y.B (TUI-Attachment + /chat/send body extension), oder direkt Phase 4 (Memory/Dream/Obsidian Review). User wollte nach Phase Y zwei Diskussionen: Versionierung (datum-basiert wie OpenClaw) + Service-Mode-Workflow (somora server start als systemd, parallel dev-Mode, gleiches `~/.somora`). Beide nur-Diskussion, kein unilateraler Build."

---

## Vorheriger Stand (2026-05-07 spätnacht — Phase Y.A.1 Multimodal drin)

**HEAD: `2ccde5d`** auf main, gepusht. Nach dem Tagesabschluss-Commit (`c392543`) ein zusätzlicher Build-Block: **Phase Y.A.1 Multimodal**.

### Phase Y.A.1 — Vision/PDF analyze_file + file_read MIME-Guard

User-Diskussion vorab: drei Optionen abgewogen (claude-code-style unified `Read`, Hermes-style split mit sub-LLM, Hybrid). Recherche bestätigt dass Hermes und OpenClaw NICHT claude-code's polymorph-Pattern folgen — split + capability-routing ist branchenüblich. User-Entscheidung: **Hybrid** mit Hauptmodell-Capability als Routing-Signal, ein globaler Vision-Worker (statt OpenClaw's 3-stufiger pdfModel→imageModel→default-Chain), optionaler `pdfWorker` für Cost-Splitting.

**Gebaut (`2ccde5d`):**
- `analyze_file({path, prompt?})` — neues Tool (Toolset `file`), dispatcht via openai-compatible SDK an `config.vision.worker` (oder `pdfWorker` für PDFs). Returns text analysis. v1-Constraint: Worker muss openai-compatible engine sein (gleicher Pattern wie Dream).
- `file_read` MIME-Guard — Magic-Bytes-Detection, refused binary files mit klarem Pointer auf `analyze_file`.
- `config.vision.{worker, pdfWorker}` — globale Config plus Validation am Server-Start (warn-and-degrade bei missing capabilities, hard-fail nur bei nicht-resolvable model-ref).
- `pdf` neu in ModelCapabilitySchema-Enum (`text/image/pdf/reasoning`).
- `src/multimodal/` — drei Module (mime/load/blocks), engine-agnostic, designed um auch Phase Y.B (Client-Attachments) zu bedienen.

Tool-count: 35 → 36.

Live verifiziert via curl gegen den laufenden Server: file_read auf PNG → clean error mit redirect, file_read auf TXT → normal, analyze_file ohne Worker-Config → klarer Hinweis auf config.yaml. Plus Smoke durch die multimodal-Pipeline direkt (PNG/TXT/PDF → richtige Content-Block-Shapes).

**Phase Y.A.2 explizit deferred:** `file_read` polymorph mit Cross-Engine-Content-Block-Plumbing. Heißt ToolDefinition-Vertrag um `{contentBlocks:[...]}`-Variante erweitern, MCP-Server-Forwarding (Protokoll unterstützt image nativ), openai-compatible adapter im chat.completions-Loop. ~2-3h Refactor — nächste Session frisch angehen statt spätabends reinquetschen.

**Phase Y.B explizit deferred:** Client-Attachments (TUI/web paste/drop, /chat/send body extension, Content-addressed Storage in `~/.somora/attachments/<sha256>.<ext>`, JSONL persistence path-ref+hash+mime). Multimodal-Module sind bereits passend designt.

### Pickup-Satz für nächste Session (überschreibt früheren)

> "2026-05-07 spätnacht — Phase Y.A.1 ist drin (`2ccde5d`): analyze_file Tool dispatcht Image+PDF via openai-compatible SDK an config.vision.worker, returnt text description. file_read hat MIME-Guard. pdf als neue Capability. Hybrid-Konzept gemäß User-Wunsch. Tool-count 36. **Nächstes:** Phase Y.A.2 — file_read polymorph (Cross-Engine-Content-Block-Plumbing), ~2-3h Refactor an ToolDefinition-Vertrag + MCP-Forwarding + openai-compatible adapter. Danach Phase Y.B (Client-Attachments) oder direkt Phase 4 (Memory/Dream/Obsidian Review). User wollte nach Phase Y zwei Diskussionen: Versionierung (datum-basiert wie OpenClaw) + Service-Mode-Workflow (somora server start als systemd, parallel dev-Mode, gleiches `~/.somora`)."

---

## Vorheriger Stand (2026-05-07 abend — Phase 1 + Phase X komplett, Tool-Registry konsolidiert)

**HEAD: `0e1d7f0`** auf main, gepusht. Heutige Commits in Reihenfolge:

- `f293aec` — fix(tmux): suppress trailing M-Enter so multiline_safe with trailing \n actually submits (Hans's Bug 10 round 1)
- `990c9f6` — fix(tmux): insert 100ms gap before final Enter so codex doesn't paste-detect the submit (Hans's Bug 10 round 2 — die echte Wurzel)
- `88e0f7a` — feat(tmux): add `key` field for sending control/function keys symbolically (Hans's Bug 11 — Esc/C-c/C-u via JSON kaputt)
- `b2eb670` — feat(tmux): add `wait_idle` action — pattern-free poll until pane stops changing (Phase 1 Quick-Win)
- `9d385aa` — feat(skills): Phase X scaffold — parser + loader + filter + registry + skill tool
- `2b131c7` — feat(skills): teach agents how to create skills via skill tool description
- `23be832` — fix(mcp): register skillTools() on the MCP server too (Hans war blind aufs Skill-Tool)
- `148938d` — refactor(tools): consolidate tool registration into single `registerAllTools()` (Drift strukturell unmöglich gemacht)
- `0e1d7f0` — docs(skills): add `docs/skills.md`, update `docs/tools.md` for new toolset + registry consolidation

### Bug-Block 2026-05-07 (Hans's Codex-Session-Test-Battery + Phase-X-Findings)

Hans hat in echten codex+tmux-Sessions weitere Bugs gefunden, plus die Phase-X-Implementierung hat zwei Architektur-Lücken aufgedeckt. Alle gefixt.

**Bug 10 — `multiline_safe:true` mit trailing \n submittet nicht in codex.** Zwei-stufige Diagnose:
1. *Erste Vermutung:* stray M-Enter zwischen letztem Literal und Submit-Enter (Code-Bug). Fix `f293aec` hat das entfernt — aber das eigentliche Problem überlebt.
2. *Echte Wurzel:* codex hat **Paste-Burst-Detection**. Zwei `tmux send-keys` via `&&` kommen innerhalb ms an, codex interpretiert das als bracketed paste, unterdrückt submit. Live verifiziert in codex 0.128.0. Fix `990c9f6`: `sleep 0.1` zwischen letztem Keystroke und finalem Enter (nur wenn was vorhergeht). Claude Code ist lenienter — gleiche Sequenz submittet dort auch ohne Gap. Verifiziert dass der Gap Claude Code nicht bricht.

**Bug 11 — Control-Keys (Esc/C-c/C-u) erreichen TUI nicht via `keys`.** Diagnose: Bug nicht in tmux/codex-Interaktion (raw `\x1b` via `tmux send-keys -l` interruptet codex direkt), sondern in der **JSON-Pipeline**: LLMs können Control-Bytes in JSON nicht zuverlässig encodieren (`\x1b` ist kein gültiges JSON-Escape, `` schon, aber LLMs raten oft falsch oder schreiben Shell-Substitution-Tricks als Literaltext). Fix `88e0f7a`: neues `key`-Feld am tmux-Tool, mutually exclusive mit `keys`, akzeptiert symbolische tmux-Key-Namen (`Escape`, `C-c`, `C-u`, `F1`, `C-x C-c`). Validation `^[A-Za-z0-9_-]+(\s+...)*$` schließt Shell-Metacharacters aus. Geht ohne `-l` an `tmux send-keys` → echte Key-Events statt Literaltext. Hans-Verifikation alle 4 Tests grün (Esc-Interrupt, C-u-Buffer-Clear, Mutex-Check, Multi-Key-Sequence).

**Phase 1 — `wait_idle` als neue tmux-Action.** Pattern-free Polling bis Pane für `idle_stable_ms` stabil bleibt. Wiederverwendet existierende Tunables. Result `{content, became_idle, ms}`. Selbsttest: 5×0.5s Output + 0.5s Stabilität → 3002ms (erwartet ~3000), continuous-tick mit 3s Timeout → 3204ms became_idle:false. Hans-Verifikation 4/4 grün. `since_last` und `watch` aus dem FUTURE-Eintrag bewusst NICHT mitgebaut, kommen bei realem Bedarf.

**Phase X — Skills komplett scaffolded und end-to-end verifiziert.** Vorab Recherche-Runde (drei parallele Agents über claude-code-source, OpenClaw, agentskills.io+Hermes) ergab erstaunlich konvergente Industry-Patterns. User-Diskussion zu allen 9 FUTURE-Fragen gelaufen. Design-Doc unter `private/skills-design.md` lockschrieben. Implementierung:
- `src/skills/load.ts` — Parser + Loader + `requires.bins`/`requires.config`-Check via `which` und Config-Lookup
- `src/skills/registry.ts` — Per-Agent-Filter + XML-Renderer mit Compact-Format-Fallback bei Overflow (Limits OpenClaw-Defaults: 150 Skills / 18 000 chars / 256 KB)
- `src/tools/skill/` — `skill({name})`-Tool, Body-Refresh per Aktivierung, klare Error-Wortlaute
- `src/persona/loader.ts` — `agent.yaml.skills`-Allow-List durchgereicht als `Persona.skillsAllowList`
- `src/server/run-turn.ts` — Registry-Inject in cached prefix zwischen `persona.systemPrompt` und ephemeral Memory
- `src/config/types.ts` — `SkillsConfigSchema` mit Tunables

End-to-end-Test live durch Hans: Skill via `file_write` selbst angelegt (Self-Bootstrap aus Tool-Description), im nächsten Turn im `<available_skills>`-Block sichtbar, via `skill({name})` aktiviert, korrekt mit "Hallo Welt!" geantwortet. Phase X.1 Schritt 6 (echte Skills) bleibt bewusst offen — kommt organisch wenn echte Workflows als Skill aufploppen.

**Bonus-Refactor — Dual-Registry-Drift strukturell unmöglich gemacht.** Phase-X-Scaffold hat aufgedeckt dass somora ZWEI ToolRegistry-Sites hat (`server/index.ts` für openai-compatible+HTTP, `mcp/server.ts` für claude-cli/codex-cli) und dass ich die `skillTools()`-Registrierung in nur einer eingetragen hatte → claude-cli sah's nicht. Fix in zwei Stufen:
1. `23be832`: skillTools auch im MCP-Registry (akute Lücke schließen)
2. `148938d`: Single `registerAllTools(registry)` in `src/tools/index.ts`, beide Sites rufen das. Process-Trennung bleibt (MCP läuft als Child pro Turn), aber der Code der die Registries füllt ist jetzt einer. Memory `feedback_dual_tool_registries.md` umgeschrieben — beschreibt jetzt die saubere Architektur statt der Stolperfalle.

**Docs-Update (`0e1d7f0`):**
- `docs/skills.md` neu (224 Zeilen, user-facing Reference: Mental Model, Schema, Layer-Trennung, agent.yaml-Allow-List, Config)
- `docs/tools.md` — neuer Skills-Toolset-Eintrag, "Where tools are wired"-Sektion auf neue Architektur umgeschrieben

### Tool-Count: 35

Vorher 34, jetzt 35 (`skill` neu). Die `tmux`-Action-Liste hat eine Action mehr (`wait_idle`) plus ein neues Input-Feld (`key`), aber bleibt ein Tool — unverändert in der Count-Statistik.

### Memory-Lessons heute hinzugefügt

Drei neue feedback-Memorys die nicht-offensichtliche Gotchas zementieren:
- `feedback_tui_paste_burst.md` — coding-TUIs (codex strict, claude-code lenient) detektieren rapid input bursts als pastes; `sleep 0.1` nur vor finalem Enter, niemals vor embedded M-Enter
- `feedback_tmux_control_keys.md` — Agents können raw control bytes nicht zuverlässig in JSON encoden; symbolische tmux-Key-Namen als separates Feld neben Text-Input ist die robuste Antwort
- `feedback_dual_tool_registries.md` — somora's zwei ToolRegistry-Instanzen werden beide aus `registerAllTools()` befüllt; einzelne Registrierung ist ein bug-Pattern das jetzt strukturell unmöglich ist

### Roadmap-Memory aktualisiert

`project_roadmap_2026-05-07.md` — User-bestätigte Reihenfolge:
1. ~~tmux quick-wins~~ DONE
2. ~~Phase X Skills~~ SCAFFOLD + DOCS DONE; Schritt 6 (echte Skills) bewusst offen
3. Phase Y Vision (nach Skills, schon als FUTURE-Eintrag)
4. Memory/Dream/Obsidian Review (Konzept-Review-Phase, hier hängen Backlinks + Dream-Worker-Priorisierung als Sub-Themen)
5. Restlicher Backlog

**Deferred:** Marathon-Turn TUI-Display-Gap — User-Hypothese vom 2026-05-07: war wahrscheinlich nur Optik/Scroll, nicht echter Bug. Wartet bis Wiederauftreten.

### Pickup-Satz für nächste Session

> "2026-05-07 war ein voller Tag: zwei Bug-Fixes (Bug 10 multiline_safe paste-burst, Bug 11 control-keys via JSON), Phase 1 (`tmux wait_idle`) und Phase X (Skills) komplett scaffolded + Hans-verifiziert + dokumentiert (`docs/skills.md`). Plus Tool-Registry-Konsolidierung in single `registerAllTools()` damit Engine-Pfade nicht mehr drift'en können. HEAD `0e1d7f0` auf main gepusht. Tool-count 35. **Nächstes:** Phase Y (Vision/Multimodal) wenn User soweit ist, oder Phase X.1 Schritt 6 wenn ein realer Workflow als Skill auftaucht. Marathon-Gap als deferred markiert (User-Hypothese: war wohl Scroll-Optik, kein echter Bug)."

---

## Vorheriger Stand (2026-05-06 spätnacht — Hans's Bug-Report 2 + 3 (TUI-Session-Lessons))

**HEAD: 53d0307** auf main. Heutige Spätnacht-Commits über den TUI-
Catchup hinaus:
- `caa49bf` — feat(tui): history-replay + ESC-to-abort across 3 engines
- `b407d33` — docs(status): TUI auf Ist-Stand
- `6cf9663` — docs(tools): list missing tool families (Hans's Bug 3)
- `666aec4` — fix(ssh): expand ~ for SFTP paths instead of literal (Hans's Bug 1)
- `0a86f8e` — fix(tmux): match wait_pattern when buffer idle (Hans's Bug 2)
- `73de484` — docs(status): record Bug-Report 2 sweep
- `e04187f` — fix(exec): blacklist only system dirs (Hans's rm -rf observation)
- `6a33d0a` — feat(tmux): wait_mode + multiline_safe + include_ansi (Bugs 4/5/8)
- `7309310` — docs(exec): nudge timeout_ms for long sleeps (Bug 7)
- `53d0307` — docs(future): wait_idle / since_last / watch proposals (Bug 6)

### Hans's Bug-Report 2 (2026-05-06-bugs.md) abgearbeitet

Hans hat ~30 Tools selbst durchgetestet und drei reproduzierbare Issues
gefunden:

**Bug 1 (hoch) — `file_write` SFTP-Tilde-Expansion.** SFTP expandiert
`~` NICHT (anders als Login-Shell). `resolveRemotePath` baute den
Pfad als literalen String `~/foo` und SFTP legte einen Ordner namens
`~` direkt unter `$HOME` an. file_read/list/patch waren konsistent
auf demselben falschen Pfad, nur `exec` (echte Shell) sah die
Divergenz. **Fix:** Pool cached jetzt das remote-`$HOME` per
`sftp.realpath('.')` (SFTP-Session startet in $HOME nach Login),
neuer `expandRemotePath(name, resource, path)`-Helper, alle
SFTP-basierten file_*-Ops verwenden ihn. file_search bleibt unverändert
(routet via ssh-exec'd ripgrep, läuft in echter Shell). Live verifiziert
gegen mac-studio mit Hans's exaktem Repro.

**Bug 2 (mittel) — `tmux capture wait_pattern` mit fast-Command.**
`echo MARKER\n` dann capture lief in Timeout, weil die count-based
Logik das Pattern bereits bei Baseline-Zeit sah und auf eine NEUE
Occurrence wartete, die nie kam. **Fix:** zweite Match-Condition
neben Count-Growth — wenn das Pattern im Content ist UND der Buffer
mit einem Shell-Prompt-Sigil endet (`$`/`#`/`>` am Ende der letzten
nicht-leeren Zeile), gilt der Command als fertig. Funktioniert
sowohl bei Shells die getippten Input einmal rendern als auch bei
solchen mit Doppelt-Render (z.B. ble.sh). Count-based-Logik bleibt
für „long-running command produziert Pattern als Output"-Shape
(Hans's Test 2). Vier-Fälle-Smoke-Matrix grün:
fast=109ms, delayed-echo=2198ms, never-appears=3s timeout,
delayed-printf-mit-fremdem-Marker=1571ms.

**Bug 3 (niedrig, docs) — `docs/tools.md` Tabelle outdated.** Es
fehlten exec, process, tmux und die ganze agents-Familie
(spawn_subagent, spawn_subagents, subagent_status, subagent_result,
subagent_list, agent_ask). Tabelle ergänzt, registerMany-Liste auf
Stand gebracht.

**Anhang aus Hans's Report:** ~28 Tools voll grün inkl. Edge-Pfade
(file_patch Mehrfach-Match-Reject, obsidian readonly-block,
idempotentes memory_delete, spawn_subagent wait:true exact roundtrip,
exec sync local + remote, background mit process poll/log/list,
resource_test reachability, web_search/fetch). Substantielle Issues
also nur die drei oben.

### Hans's Bug-Report 3 (Tetris-Session) abgearbeitet (2026-05-06 spätnacht)

Hans hat parallel ein Tetris-Spiel via Claude-Code-in-tmux bauen
lassen und über mehrere Stunden andere Klassen Stolpersteine
gefunden, die der Selftest nicht zutage gebracht hat. UX/Effizienz-
Probleme primär, keine „Tool kaputt"-Bugs — aber für TUI-Sessions
spürbar. Aufschlag agnostisch gehalten, kein claude-cli-spezifischer
Code:

**rm -rf-Blacklist zu grob (`e04187f`):** Pattern `/[a-zA-Z]` blockte
jeden absoluten Pfad, also auch `/Users/<u>/...` und `/tmp/...`.
Explizite System-Dir-Liste eingeführt — userspace passiert sauber
durch, System-Pfade (/, /bin, /etc, /Library, /System, …) gesperrt.
20/20 Smoke-Cases.

**Bug 4/5/8 — tmux-Opt-In-Params (`6a33d0a`):** Drei neue Felder, alle
agnostisch, agent deklariert pro Call:
- `wait_mode: 'auto' | 'present' | 'idle'` — auto bleibt smart-für-
  Shell, present matcht auf reine Anwesenheit (für TUIs mit
  statischem Panel-Content), idle wartet auf Stabilität
- `multiline_safe: bool` — \\n als M-Enter (Soft-Newline-Convention)
  statt nacktem CR. Behebt das „Multi-Line-Prompt zerteilt" bei
  Claude Code / Codex / IPython / fish.
- `include_ansi: bool` — capture mit `-e` Flag, ANSI-Escapes
  preserved. Erlaubt dem Agent dim-Auto-Suggestions vom echten
  User-Input zu unterscheiden — sicherheitskritisch (Hans's Vorfall
  #3 hätte ein Projekt-Delete ausgelöst).
Plus Safety-Paragraph in der Tool-Description: niemals Enter auf
einen Buffer den du nicht selbst getippt hast.

**Bug 6 (Polling-Cost) → FUTURE.md (`53d0307`):** Drei orthogonale
Ideen festgehalten — `wait_idle`-Action, `since_last`-Capture-Mode,
`tmux watch` Background-Job — mit Priorisierung. `wait_idle` wäre
der größte Quick-Win (~30 Min), Build folgt bei Bedarf.

**Bug 7 (sleep-Timeout) → Doku-Tweak (`7309310`):** `exec`
description suggeriert jetzt `timeout_ms: (N+5)*1000` für
`sleep N`-Cases. Default bleibt 60s, aber Agent stolpert nicht mehr
ahnungslos.

**Neue Doku `docs/tmux.md`:** kompletter Guide für Shell-vs-TUI-
Sessions, alle drei Opt-In-Params mit Beispielen, Auto-Suggestion-
Safety-Rule prominent. Cross-link aus `tools.md`. Auto-discovery via
`somora_docs_list` greift, Hans sieht das ab nächstem Turn.

### TUI auf Ist-Stand gebracht (2026-05-06 nacht, commit `caa49bf`)

### TUI auf Ist-Stand gebracht (2026-05-06 nacht, commit `caa49bf`)

Zwei lange offene TUI-Lücken in einem Aufwasch geschlossen:

**History-Replay bei Session-Open.** TUI lud bisher nur SSE ab dem
Moment des Öffnens — JSONL-Events wurden ignoriert, Scrollback war
leer beim Wechsel. Jetzt: scrollback clearen → `/chat/history` fetchen
→ NormalizedEvents → Turn[] mappen (deltas/turn-boundaries/errors
skippen, tool_call/tool_result respektieren `showTools`) → SSE öffnen.
Neue Sessions fallen sauber durch mit 0 Events. Damit sieht User auch
A2A-Inbounds (`↬ hans`-Tag aus 6c) beim Lisa-Session-Open ohne Reload.

**ESC-to-Abort über alle drei Engines.** Vorher: ESC clearte nur den
Input-Buffer. Jetzt: while streaming abortet ESC den laufenden Turn
server-side; sonst clear-as-before. Header zeigt
„streaming · ESC to abort" als Hint.

Server-Wiring:
- `src/server/chat-aborts.ts` (neu) — per-session AbortController
  Registry, `registerChatAbort` + `triggerChatAbort`, Idempotent,
  In-Memory-Only (Server-Restart killt alle laufenden Subprocesses
  ohnehin)
- `/chat/send` registriert Controller, threaded `signal` durch
  `runChatTurn` → engine baseInput, released im finally
- `POST /chat/abort?agent=…&session=…` — neue Endpoint, returnt
  `{aborted, ms_running}`
- `TurnInput.signal?: AbortSignal` (engine/types.ts) als
  Cross-Engine-Vertrag

Engine-Adapter alle drei eigenständig handle:
- **claude-cli**: bridged in `claude-agent-sdk`'s `abortController`
  option (SDK akzeptiert nur Controller, nicht Signal — daher
  Mirror-Pattern), removeEventListener im finally
- **codex-cli**: SIGTERM auf das spawned subprocess, `abortFired`
  flag damit der exit-handler nicht als „spawn failed" interpretiert
- **openai-compatible**: `{signal}` als zweites Arg an
  `chat.completions.create()`. WICHTIG: omlx schließt den stream auf
  Abort *ohne zu throwen* — daher zusätzlicher
  `if (signal?.aborted) throw` Check innerhalb der for-await UND nach
  dem Loop. Sonst silent-truncate ohne Marker.

Alle drei emittieren auf Abort: kumulierte Tokens bisher +
`\n\n[somora] aborted by user` als final-`assistant_message`, dann
sauberes `turn_end`. Keine Error-Events. Persistiert ins JSONL, daher
Replay zeigt's beim nächsten Open auch.

Live-Smoketests via curl alle grün:
- claude-cli (sonnet): aborted nach 10.2s mid-Zählung „1…4", Marker im
  final
- codex-cli (gpt54mini): aborted nach 11.3s vor erstem Token, „aborted
  by user" als ganzer final
- openai-compatible (gemma4small): aborted nach 7.0s mid-Kapitel-2,
  Kapitel-1 + Anfang-Kapitel-2 + Marker im final

History-Endpoint zeigt user_message + turn_start + assistant_message
(mit Abort-Marker) + turn_end für die Test-Session — Replay
funktioniert.

Files: `src/cli/tui/{api,app,header}.tsx` +
`src/engine/{claude-cli,codex-cli,openai-compatible,types}.ts` +
`src/server/{chat-aborts,index,run-turn}.ts`. +332/-47 LOC.

---

## Vorheriger Stand (2026-05-05 abend — Phase 6c agent_ask live, A2A komplett validiert)

Zwei Commits 2026-05-05:
- `8ada555` — phase 6c-prep: long-task timeout politik (DECISION #39)
- `3335f0b` — phase 6c: agent_ask — live A2A messaging

**Phase 6 ist damit komplett** — beide Modi live über alle drei Engines:
- **Modus 1** (sealed delegation, fresh sub-session) — Phase 6b validiert 2026-05-04
- **Modus 2** (live A2A messaging in target's existing session) — Phase 6c
  validiert 2026-05-05

### DECISION #39 — Long-task timeout politik

Drei-Schicht-Config in `agentLoop` (`src/config/types.ts`):
- `toolCallTimeoutMs: 30s` — fast tools (memory, web, file, time, obsidian)
- `longTaskDefaultTimeoutMs: 5min` — slow A2A default wenn caller kein
  timeout_ms setzt (subagent_result wait_until_done, agent_ask)
- `longTaskMaxTimeoutMs: 30min` — hartes Maximum auch bei explizitem
  timeout_ms

Plus die CLI-Layer hochgezogen:
- `claudeCli.mcpToolTimeoutMs: 1800000` (von 600000)
- `codexCli.toolTimeoutSec: 1800` (von 600)

**Beide MÜSSEN ≥ longTaskMaxTimeoutMs sein** — sonst kappt die CLI's
MCP-Layer durch bevor unsere eigene Ceiling greift. Im Default jetzt
by-design alle drei bei 30 Min.

Read-at-call-time-Pattern in `src/tools/agents/long-task-timeouts.ts` —
Module-Level-Cache populated bei Server-Boot und MCP-Child-Boot. Tools
lesen `longTaskDefaultMs()` / `longTaskMaxMs()` per Call, also greift
eine Config-Änderung ohne Restart.

**Pattern Wall-Clock + Pending statt Heartbeat** — das ist eine
bewusste Politik-Entscheidung. DECISION #37 macht den „Default" zu
einem Checkpoint statt einem Death-Sentence: Tool-internes Timeout
returnt `state:"pending"` (NICHT Error), Sub läuft im Hintergrund
weiter, Caller adaptiert mit höherem timeout_ms. Heartbeat-basiert
wäre theoretisch ehrlicher, aber teurer (Streaming-Awareness durch
alle Engines, neue Wire-Format-Felder). Wall-Clock + Pending = 80%
des Werts zu 20% des Aufwands.

### Phase 6c — agent_ask live messaging

`agent_ask({agent, message, session?, timeout_ms?})` postet eine
Frage in die main-Session der Ziel-Persona, Lisa läuft einen normalen
Turn (Memory-Auto-Inject, Persona, Tools — alles), die Antwort kommt
blockierend zurück. Beide Turns sichtbar in Lisas main wenn User
später öffnet. Hans's tool_call/tool_result sichtbar in hans's main.

**Was Phase 6c gebaut hat:**

- `src/server/session-queue.ts` — neue Datei. Per-Session-Lock mit
  Two-Class-Priority-Queue (`user` > `agent`). User-Entries springen
  vor wartende agent-Entries (Variante b aus der Diskussion). FIFO
  innerhalb jeder Klasse. AbortSignal-aware. In-Memory only.
- `src/tools/agents/ask.ts` — neue Datei. agent_ask-Tool mit
  Pending-Pattern, UUID-call_id (FUTURE-async-Pfad vorbereitet),
  5min/30min Timeout via longTask-Config, Self-Call-Guard.
- `src/types/events.ts` — `agent_ask_call_id?` auf user_message,
  neuer SSE `user_message`-Event für A2A inbound live.
- `src/server/run-turn.ts` — plumb-through `agentAskCallId`,
  publishSse emittiert user_message-Event wenn fromAgent gesetzt.
- `src/server/index.ts` — `/chat/send` und `/chat/send-sync`
  acquiren Session-Lock mit Priority basierend auf fromAgent. Plus
  agent_ask_call_id Body-Param. Plus publishSse auch in send-sync.
- `src/cli/tui/{types,stream,app,turn-views}.tsx` — TUI rendert
  `↬ hans` Cyan-Tag bei A2A inbound (statt grünem `user`-Tag).

**Was bewusst NICHT in Phase 6c kam (FUTURE):**

- `agent_ask_result(call_id)` async-Retrieval — wenn Caller bei
  Pending später die Antwort programmatisch abholen will. Heute landet
  die Antwort nur im Target-JSONL, Caller hat keinen Zugriff. Bauplan
  in `private/A2A-design.md` FUTURE-Sektion.
- Persistente Queue mit Crash-Recovery — MVP nur In-Memory.
- Deadlock-Detection bei A2A-Cycles — theoretisch möglich, durch
  30min-Cap eh begrenzt. Cycle-Detection im Lock-Graph wäre FUTURE.
- History-Replay im TUI bei Session-Open — pre-existierende Lücke,
  unabhängig von 6c.

### Test-Validierung 2026-05-05

7 Tests durchgeführt, alle grün:

| # | Test | Ergebnis |
|---|---|---|
| 1 | agent_ask cross-engine jarvis(opus) → lisa(gpt55) | ✅ 12s, korrekte Antwort, call_id present |
| 2 | Pending-Pattern bei `timeout_ms: 3000` | ✅ pending nach 3001ms, Target-Turn lief im Hintergrund weiter |
| 3 | Lock-Serialisierung — parallele agent_asks | ✅ A1@4150ms, A2@7976ms (sequenziell, kein JSONL-Race) |
| 4 | User-Priority — User springt vor wartendem agent_ask | ✅ JSONL-Order: A1 → USER → A2, obwohl A2 zuerst enqueuete |
| 5 | spawn_subagent self-clone wait:true Regression | ✅ 6.3s, sub-self-894-2cnw erstellt |
| Pattern 2 | async Lifecycle: spawn-status-result mit pending+done+default | ✅ alle 5 Steps, neuer schema-default funktioniert |
| Pattern 5 | Recursion-Cap depth=3 | ✅ deterministisch via direct-handler-call |

**Persistenz verifiziert** — `from_agent` und `agent_ask_call_id` landen
sauber in `~/.somora/agents/lisa/sessions/main.jsonl`. Reihenfolge-
Beweis für User-Priority im JSONL: Hans-A1 → User-Turn (kein
from_agent) → Hans-A2.

**Was bewusst NICHT re-getestet wurde** — Patterns 1, 3, 4 vom
2026-05-04 (Payment-Orchestration, Per-Spawn-maxRounds, Cross-Engine-
Spawning). Die testen Engine-Behavior das in Phase 6c nicht angefasst
wurde — DECISION #37 (Engine-Tool-Race) ist von 2026-05-04. Wenn wir
später Engine-Adapter ändern, dann diese Patterns wieder mitziehen.

### Bug-Fixes nach A2A-Abschluss — alle 4 Bugs durch

Hans hat 2026-05-05 vier Bug-Reports geliefert (`~/somoraworkspace/2026-05-05-bugs.md`).
Alle vier sind drin und committed:

- **Bug 2** (commit `64ca680`) — `file_list` glob ohne `/` matcht jetzt
  korrekt gegen Basename auch im rekursiven Walk. Root-Cause war
  `globRe.source.includes('/')` der den kompilierten Regex inspizierte
  (immer `/` wegen `[^/]*`) statt das Original-Glob-String. Fix:
  CompiledGlob-Wrapper mit `hasSlash`-Flag, in local.ts + remote.ts.
  Verifiziert live: `*.md` recursive findet jetzt 10 Files in
  Unterordnern statt 3 Top-Level.
- **Bug 4** (commit `64ca680`) — Resources hot-reload via lazy
  mtime-check. Neuer `getFreshConfig()`-Helper in
  `src/config/loader.ts` cached + stat'd config.yaml, re-load nur bei
  mtime-Änderung. resource_list / resource_test / file_*-mit-target
  switchen auf `visibleResourcesForAgentFresh()` /
  `resolveVisibleResourceFresh()`. Agent kann jetzt config.yaml
  editieren und beim nächsten Tool-Call die neue Resource sehen ohne
  Restart. Verifiziert live: nach Hans' spiderman-Addition jetzt
  sichtbar.
- **Bug 1** (commit `c707065`) — Paused dreams akkumulierten weil
  `resumeDream` das alte `.paused.md`-File nicht löschte: `runDream`
  generiert einen neuen timestamp-basierten ID und schreibt fresh.
  Wenn der neue Run wieder abgebrochen wurde → noch ein paused-File.
  Fix: `resumeDream` unlinked das alte paused vor dem Rerun. Plus
  `consolidateStalePausedDreams` als Server-Start-Housekeeping
  drainiert den bestehenden Backlog (pro source-session nur das
  neueste paused behalten). Verifiziert live: tsx-watch reload
  hat 4 von 5 hans-paused-Dreams automatisch entfernt, nur das
  neueste (20260504-202507) bleibt zur Wiederaufnahme.
- **Bug 3** (commit `66c5d37`) — Optionales `DREAMRULES.MD` pro Agent
  unter `~/.somora/agents/<name>/` (zu AGENTS.md / SOUL.md / USER.md
  passend). Freitext-Markdown, wird verbatim als
  `## Per-agent rules`-Block in den Dream-Worker-System-Prompt
  injiziert. Loader mit mtime-Cache, optional (fehlende Datei →
  altes Verhalten). Per-Agent statt global weil Dream-Behavior und
  Vault-Zugriff schon per-Agent sind. Hans's Starter-DREAMRULES legt
  „Vault ist Single Source of Truth"-Regel + Anti-Duplikations-Regel
  fest; Lisa hat keine (opt-in). Doku in `docs/dream-mode.md`.

### TODO für nächste Session

Hans's Bug-Reports vollständig abgearbeitet — A2A + Dream-Worker-Pflege
sind durch. Nächste mögliche Themen:

### Phase 5 abgerundet — lokales PTY (2026-05-06 spätabend, commit `69cb1a7`)

Letztes Loose-End geschlossen: `exec({pty:true, target:'local'})` war
seit der ersten 5a-Iteration als no-op markiert. Jetzt via `node-pty`
gebaut. Tool-Description ehrlich (kein „FUTURE" mehr).

- `node-pty 1.1.0` als runtime dep (~5MB, native compile at install)
- `localExecSyncPty()` in src/tools/exec/local.ts — pty.spawn mit
  xterm-256color + cols/rows + cwd/env
- Output merged in einen Stream wie bei real-terminal + remote-pty
- Background-Mode ignoriert pty:true (= TUI im Hintergrund nutzlos)

Smoke verifiziert: ohne pty `tty` sagt „not a tty", git log = plain
text. Mit pty `tty` returnt `/dev/pts/5`, line-endings switchen auf
\\r\\n, git log emittiert ANSI-color-Escapes. Klares Verhalten-
Differential.

### Phase 5b — tmux Tool gebaut (2026-05-06 abend, commit `1e47eac`)

Single `tmux`-Tool mit action-enum (`create`, `send`, `capture`, `list`,
`kill`) plus `target: 'local'|<resource-name>`-Pattern wie alle anderen
exec-Familie-Tools. Drei Files:

- `src/tools/tmux/local.ts` — wrapper um localExecSync, baut richtige
  tmux-CLI-Befehle für jede action
- `src/tools/tmux/remote.ts` — selbe wrapper aber via ssh remoteExec
- `src/tools/tmux/tools.ts` — Tool-Definition, Schema, action-Routing,
  smarte send-keys-Behandlung für multi-line, count-based wait_pattern

**Use-Case:** Agent startet claude --dangerously-skip-permissions /
codex / vim / REPL als persistente Session, treibt sie über viele
Turns an, killt sie wenn fertig. exec für one-shot Commands, tmux für
„persistent multi-turn session" — saubere Trennung.

**Spezial-Detail wait_pattern:** count-based (nicht substring-match)
weil der getippte Befehl oft selbst das Pattern enthält. Match nur
wenn occurrence-count nach Polls > baseline-count. Plus 100ms pre-
baseline delay um tmux's Render-Tick zu fangen. Verifiziert: 2196ms
für `sleep 2; echo XXX` korrekt match'd, 1509ms timeout für nicht-
vorhandenes Pattern.

Tools 33 → 34. **Phase 5 (exec + tmux) ist damit komplett.**

### Phase 5a polish — Loose-Ends durch (2026-05-06 spätnachmittag, commit `625bb53`)

Drei Loose-Ends aus der ersten 5a-Iteration sauber geschlossen:

- **Remote PTY** für sync exec — ssh2 pty option durchgereicht,
  TUI-Tools funktionieren auf remote ohne tmux-Wrapper für „kurzer
  interaktiver Bedarf"
- **Remote-Background** via nohup-Pattern — POSIX-portable
  (macOS-kompatibel, kein setsid), spawn-and-poll, output streamt
  auf remote-host, kurzlebige ssh-Connections für poll/log/kill.
  Live-Verifikation gegen mac-studio: voller Lifecycle grün
- **Concurrency-Caps** in `agentLoop.execMaxConcurrent{PerAgent,Global}`
  konfigurierbar, Default 8/32. Slot-Release wired für local + remote,
  9. Spawn correct rejected mit klarem Hint.

Damit ist exec **wirklich komplett** — tmux (Phase 5b) behält sauberen
Scope „persistent multi-turn sessions" statt als Workaround-Overflow.

Local PTY bewusst FUTURE gelassen (würde node-pty install + native
compile brauchen). Remote PTY deckt 90% der Real-World-Cases.

### Phase 5a — exec + process gebaut (2026-05-06 nachmittag, commit `fa10122`)

Erstes Code-Stück der exec-Phase ist live + smoke-getestet:

- `exec`-Tool mit allen design-doc-Feldern (command, target, cwd, env,
  background, timeout_ms, pty, description). Sync local und sync
  remote über SSH-Resources funktionieren. Background-local
  spawnt detached mit Disk-Output (stdout.log + stderr.log + meta.json).
  Background-on-remote v1 mit klarem Fehler-Hinweis abgelehnt.
- `process`-Tool mit action-Enum: `list`, `poll`, `log`, `write`,
  `kill`. Alle 5 Actions getestet end-to-end mit einem 5-Sekunden-
  Counter-Job.
- Hard-Blacklist (13 Patterns) blockt rm -rf /, dd if=, mkfs, sudo,
  fork bomb, system halt, chmod 777 auf system, private SSH key
  reads, curl|sh / wget|sh.
- Server-start orphan-recovery analog zu Dream: jobs mit `running`
  zur Server-Crash-Zeit werden auf `failed` gesetzt mit Reason
  „orphaned by server restart".

Tools gehen 31 → 33 (`exec` + `process` neu).

12-Test Smoke-Matrix alle grün: sync local + sync remote (mac-studio
uname) + 2× blacklist-trigger + background-lifecycle (spawn/list/
poll/log/kill) + remote-background-rejection + bad-target-rejection.

Phase 5b (tmux mit local + remote target-support) folgt.

### Cache-Strategie konsolidiert (2026-05-06 mittag)

DECISION #40 + `docs/cache-strategy.md` dokumentieren jetzt die ganze
Cache-Story als kanonische Referenz. Vier Pfade alle strukturell
korrekt:

1. **chat / claude-cli** — Memory inline in user-message-Text;
   resumed session; 95-98% cache hit
2. **chat / codex-cli** — Memory in stdin-payload; resumed thread;
   ~70% cache hit
3. **chat / openai-compatible** — `ephemeral?:string` pro
   user_message in JSONL persistiert; buildMessages reconstructs
   byte-identisch; cached_tokens omlx-side null aber Struktur korrekt
4. **dream-extractor** — stable content (memory + vault) vor variable
   transcript; multi-chunk-cache-win bei langen Sessions

**Lessons-Learned** in zwei feedback-memories und in DECISION #40 als
verbindliche Regel: per-Turn variable Inhalte ans Ende, stable nach
vorne; nicht nur cached_tokens-Zahlen vertrauen, sondern Position-
für-Position via instrumentiertem 2-Turn-Dump verifizieren.

### Memory-Inject Position Fix (zwei Iterationen)

**Iteration 1 (`49c682a`, 2026-05-05):** „late-system"-Variante in
openai-compatible eingebaut + Variante B in claude-cli. Hat für
claude-cli funktioniert (cache 73%→95%), für openai-compatible
verifiziert NICHT (Memory-Position wanderte durch die wachsende
History → byte-mismatch).

**Iteration 2 (`cb9f429`, 2026-05-06):** Strukturell korrekter Fix —
ephemeralContext wird pro Turn in JSONL persistiert (`ephemeral?:
string` Field auf user_message), buildMessages reconstructs jeden
user_message mit seinem eingefrorenen Memory-Block. Turn N+1
reproduziert Turn N's Prompt byte-perfekt → Prefix-Cache hält
strukturell.

Pre-Build-Research (DECISION #38) gemacht: OpenClaw + Hermes machen's
nicht state-of-the-art für stateless openai-compatible. Wir hier
besser als die Referenz-Repos.

**omlx-Limitation gemeldet aber nicht aus somora fixbar:** omlx
returnt `cached_tokens: null` selbst bei byte-identischen Direct-
Curl-Requests. Entweder Reporting-Bug oder Cache nicht aktiv für
gemma-4-31b-it-8bit Setup. Aus unserer Sicht ist die Struktur jetzt
korrekt, runtime-Cache-Effekt auf omlx hängt von deren
Implementation ab.

**Smoke-Matrix Iteration 2:**
- claude-cli (jarvis/opus): 98% cache hit auf Follow-up
- codex-cli (lisa/gpt55): 68% cache hit
- openai-compatible: byte-perfekte history-Reconstruction verifiziert
  via instrumentiertem messages_dump
- Memory-Recall funktioniert weiter

Schema-Vereinfachung: `memoryInjectMode` enum dropped `late` (war die
kaputte Variante). Nur noch `inline-user` (default mit JSONL-Persistenz)
und `system` (legacy fallback).

Detail in `private/FUTURE.md` Sektion „Memory-Inject Position".

### Maintenance-Sweep 1 done (commits `42fee3f` + `5bd7fc1`)

- npm: claude-agent-sdk 0.2.123→0.2.128, hono 4.12.16→4.12.17,
  ink 7.0.1→7.0.2, openai 6.35.0→6.36.0, zod 4.4.1→4.4.3
- binary: codex-cli 0.125.0→0.128.0; claude-cli sync at 2.1.128
- Adapter-Fix in `5bd7fc1`: `general_analytics`-Feature-Flag aus
  `CODEX_DISABLED_FEATURES` entfernt (codex 0.128 hat ihn aus dem
  Catalog entfernt → `--disable general_analytics` errored mit
  `Unknown feature flag` und brach jeden codex-cli-Turn).
- Initial-Smoke vom 42fee3f hatte das **versteckt** — nur
  user-visible Output geprüft, Fallback (lisa→opus) hat das
  silently abgefangen. Fix `5bd7fc1` re-verified mit explizitem
  Engine-Check: provider=openai, model=gpt-5.5, no fallback in
  logs, beide Pattern (Pattern 4 + agent_ask cross-engine) grün.
- Lessons-Learned in `feedback_smoke_must_check_engine.md`.
- Detail in `private/FUTURE.md` Sektion "Dependencies + SDK-Audit-Sweep"

### TODO für nächste Session

A2A + Hans's Bugs + Maintenance-Sweep 1 + Cache + Phase 5 (exec/tmux
inkl. local PTY) + TUI Ist-Stand alle durch. Offene Themen:

1. **Phase X — Skill-Handling** (vorher 9 Diskussionsfragen klären,
   siehe `private/FUTURE.md` Abschnitt „Phase X — Skill-Handling"; **NICHT**
   unilateral starten).
2. **Dream-Worker-Priorisierung** (User-Active-Marker mit
   AbortSignal) — wenn `idleMinutes < 30` wieder gewünscht.
   FUTURE.md hat den halben-Tag-Bauplan.

### Pickup-Satz für nächste Session

> "Phase 6 (A2A), Hans's vier Bugs aus Report 1, Maintenance-Sweep 1,
> Cache-Strategie, Phase 5 (exec + tmux inkl. lokalem PTY), TUI auf
> Ist-Stand (history-replay + ESC-to-abort), Hans's Bug-Report 2 + 3
> (SFTP-Tilde, tmux wait_pattern fast-Command, docs/tools.md gap, plus
> rm -rf-Blacklist tightening, tmux opt-in TUI-Params wait_mode/
> multiline_safe/include_ansi mit Safety-Doku, plus Bug 9 leading-
> dash send-keys mit `--`-Fix) alle durch. HEAD a9c0148. Tool-count 34.
>
> **OFFEN-MORGEN (User explizit erinnern):** Marathon-Turn-TUI-Gap.
> Hans's Verifikations-Run hatte 16+ Tool-Calls in 4.5min, KEINER
> davon im TUI angezeigt — einzelner time_now-Call DANACH funktioniert
> aber. Server-Seite ist bestätigt sauber (JSONL hat alle 172 events,
> SSE-Publish empirisch verifiziert). Vermutung: Race in der TUI-
> for-await-Async-Iterator-Consumption unter Last ODER applyEvent-
> Throw der den Stream silent killed. Brauche Pino-Logs im
> stream.ts-Consumer + Repro-Script mit ~50 schnellen Tool-Calls
> hintereinander. Geschätzt 1-2h.
>
> Offene Themen sonst: Phase X (Skills, vorher diskutieren — 10
> Konzept-Fragen offen), Phase Y (Vision / Multimodale Inputs, kommt
> NACH Skills), Dream-Worker-Priorisierung, tmux wait_idle-Action
> (FUTURE.md, ~30min Quick-Win), formatResult MCP-Wrapper-Bug für
> memory_search-Summary (kosmetisch, '0 hits' obwohl 5 hits)."

---

## Vorheriger Stand (2026-05-04 spätabend — Tool-Timeout-Aware-Engine + cross-engine validiert)

**HEAD: dcbc854** (lokale Hotfixes 2026-05-04 noch nicht committed; tsx-watch
hatte sie aber zur Laufzeit aktiv).

Heute (2026-05-04) waren ein langer Test-Tag plus ein zweischrittiger Bugfix
auf der Engine-Tool-Loop:

### Bugfix-Welle 2026-05-04

Hans hat 2026-05-03 nachts einen sauberen Bug-Report geschrieben über
`subagent_result(wait_until_done)` der nach 30s gekillt wird. Root Cause
war ein pauschaler `Promise.race(invoke, 30s)` in `openai-compatible.ts`
um jeden Tool-Call. Recherche in OpenClaw + Hermes-Repos: niemand baut
einen globalen Engine-Tool-Race mit hartem Cap; OpenClaw hat
`waitForAgentRun({runId, timeoutMs})` mit Status-Tupel ok|pending|
timeout|error und Outer-Buffer `timeoutMs + 2000`.

DECISION #37: Adoptiert. ToolDefinition kriegt `defaultTimeoutMs?`,
`timeoutFromInput?(input)`, `maxTimeoutMs?`. Engine resolved
per-Call: `dynamic ?? static ?? globalToolCallTimeoutMs`, clamped auf
`maxTimeoutMs`. Lang-blockierende Tools (`subagent_result(
wait_until_done)`) returnen `state: "pending"` + `hint`-Feld statt
`{ok:false}`/Error — Modell soll nicht blind retryen sondern
`subagent_status` checken oder mit höherem `timeout_ms` retry'n.

Setting auf `subagent_result`/`spawn_subagent`/`spawn_subagents`:
caller-driven via `wait_until_done` + `wait` in den Inputs. Outer-Buffer
+2s wie OpenClaw. Default 30s greift weiter für alle Tools die nichts
über sich aussagen (memory_*, web_*, time_now, file_*).

Doku: `docs/research/tool-architecture.md` Sektion 6.1 +
`private/DECISIONS.md` #37.

### Cross-Engine Tool-Timeout Findings (Test-Tag-Befund)

Beim Cross-Engine-Test ist aufgefallen: claude-cli und codex-cli haben
**eigene** harte Tool-Call-Timeouts, die unabhängig von unserem
Engine-Race greifen:

- **claude-cli MCP_TOOL_TIMEOUT** ~5min. Hans-on-opus rannte bei sync-
  Test-5 zweimal in 5min-Timeouts, hat dann adaptiv auf async+poll
  umgestellt. Konfigurierbar via `MCP_TOOL_TIMEOUT` ENV des
  claude-agent-sdk subprocess.
- **codex-cli tool_timeout_sec** 60s default. Codex-Test-5 ist mit
  `subagent_result(timeout_ms=600000)` nach 120s vom codex-internen
  Timeout gekillt worden. Konfigurierbar via TOML-Override
  `mcp_servers.<name>.tool_timeout_sec` per `-c`-flag.

Hotfix in zwei neuen Config-Blöcken:

```yaml
claudeCli:
  mcpToolTimeoutMs: 600000      # 10min
  mcpConnectTimeoutMs: 60000

codexCli:
  toolTimeoutSec: 600           # 10min
```

Implementation:
- `applyClaudeCliSdkEnv(config)` setzt `process.env.MCP_TOOL_TIMEOUT` /
  `MCP_TIMEOUT` beim Server-Boot. Subprocess erbt sie automatisch.
- `applyCodexCliEnv(config)` setzt `process.env.SOMORA_CODEX_TOOL_
  TIMEOUT_SEC`; `somoraMemoryCodexFlags()` liest die ENV und emittiert
  `-c mcp_servers.somora-memory.tool_timeout_sec=N`.
- Explicit env wins (override-layer wie überall — DECISIONS-Politik).
- `/env`-Endpoint surfaced beide neue Felder.

### Dream-Worker Idle-Hotfix

Test-Tag-Beobachtung: Auto-Dream-Worker mit `idleMinutes: 3` (alter
Test-Wert) triggerte ständig parallel zu Live-Tests, blockierte den
mlx-omx-Server (sequenzielle Queue pro Modell). Hans-on-gemma hat in
20 Min nicht einen Token generiert, weil Dream-Calls + Sub-Subs den
Slot belegten.

Hotfix: alle agent.yaml `idleMinutes: 60` (von 3). Default in
`loader.ts` ist 30; per-agent override schiebt das hoch.

Eigentliche Lösung in `private/FUTURE.md`: Dream-Worker-
Priorisierung mit User-Active-Marker und AbortSignal. AutoDreamWorker
pausiert sobald Chat-Turn oder sync-Sub läuft, resumed bei nächstem
Idle. Halben-Tag-Bau, in FUTURE eingetragen, nicht heute.

### Test-Matrix 2026-05-04 (Tests 1-5 auf opus / codex / gemma)

Fünf Test-Patterns durchgespielt:

1. **Payment-Orchestration** (Hans's Original-Bug-Report-Prompt) — Sub
   spawnt 3 Sub-Subs parallel mit web_search/web_fetch, wartet, baut
   Vergleichs-Markdown.
2. **Pending-Status** — async spawn + `subagent_result(timeout_ms=20000)`,
   sehen ob `state: pending` sauber durchpropagiert.
3. **Per-Spawn maxRounds** — Orchestrator-Sub mit `maxRounds: 32` per
   User-Hint, sehen ob Hans's Tool-Description-Hint adoptiert.
4. **Cross-Engine** — Hans-on-X spawnt Lisa/Jarvis auf einem anderen
   Engine, sync wait.
5. **Recursion-Cap** — sync 3-level chain, sub3 versucht sub4,
   `recursion depth 3 exceeds limit 3` wird sauber durchpropagiert.

Ergebnis-Übersicht:

| Test | opus (claude-cli) | codex (codex-cli, gpt55) | gemma (openai-compatible) |
|---|---|---|---|
| 1 Payment-Vergleich | ✅ 11min, 4.5k-char Markdown | ✅ 9min, 5.5k-char Markdown | ✅ 9.6min, 3.9k-char Markdown |
| 2 Pending-Status | ✅ 47s, hint-Feld korrekt | ✅ 38s, hint korrekt | ✅ 4.8min (mlx-Queue), pending OK |
| 3 maxRounds | ✅ 32 proaktiv (auch ohne Hint) | ✅ 32 proaktiv | ⚠️ default — gemma listet Tool-Hints schwächer als die größeren |
| 4 Cross-Engine | ✅ → Lisa-on-gemma 63s | ✅ → Lisa-on-gemma 66s | ✅ → Lisa-on-opus 189s |
| 5 Recursion-Cap | ✅ via JSONL verifiziert | ✅ 2.4min (mit 600s-Hotfix) | ✅ 4.4min, sauber durchpropagiert |

**Engine-Race-Fix Beweis** (auf gemma, das war ja die kaputte Engine):
- 60s `wait_until_done` 3x sauber durchgewartet, kein 30s-Kill mehr
- Hans-on-gemma adaptiert selbständig auf `timeout_ms: 120000` wenn
  `pending` mehrfach kommt — `hint`-Feld wirkt als Selbst-Korrektur

**Concurrency-Beobachtung:** mlx-omx queue't sequenziell pro Modell.
Bei 5+ parallelen gemma-Subs (Test-Subs + Auto-Dream-Worker) blockt
der nächste Hans-Turn massiv. Mit `idleMinutes: 60`-Hotfix entschärft;
strukturell löst das aber erst der FUTURE-Eintrag (User-Active-Marker).

### Status der Phase 6

Phase 6 Modus 1 (sealed delegation) ist **vollständig validiert**:
- ✅ async (default) und sync wait
- ✅ Self-Clone und cross-persona spawning
- ✅ Cross-Engine in alle Richtungen (opus↔gpt55↔gemma)
- ✅ Recursion-Cap (max depth 3) — code-deterministisch
- ✅ Concurrency-Cap (4 per agent, 16 global) — code-deterministisch
- ✅ Race-Slug-Fix (parallele spawn_subagents alle unique sessions)
- ✅ pending-Pattern statt Errors bei Tool-Internal-Timeouts
- ✅ Tool-aware Engine-Race statt pauschaler 30s-Cap
- ✅ Tool-Timeout-Hardlimits aller drei CLIs konfigurierbar (10min default)
- ✅ Auto-Dream-Idle hochgedreht (60min) gegen Concurrency-Stau

### Workflow-Konvention seit 2026-05-05 (DECISION #38)

Vor **jeder** neuen Phase oder größeren Design-Diskussion: 30 Min
Skim in `claude-code-source/` + `~/.openclaw/dist/` + unserem
`docs/research/tool-architecture.md`. Konkrete Phase-Pointer in
`private/FUTURE.md` „Cross-Reference: 3-Repo-Research-Pointers".
Findings als knapper „was die machen / was wir adoptieren / was
weglassen"-Block ins Phase-Design-Doc.

### TODO für nächste Session

- **Phase 6c — `agent_ask` Modus 2** (live messaging zwischen Agents),
  ODER **Phase 5 — exec mit Hard-Blacklist** + tmux-Familie. User-
  Entscheidung steht aus. Vor Start: Cross-Reference-Pointer in FUTURE
  durchgehen (DECISION #38).
- **Dream-Worker-Priorisierung** bauen wenn `idleMinutes < 30` wieder
  gewünscht ist (FUTURE-Eintrag, halber Tag).
- **Maintenance-Sweep 1 — Dependencies + SDK-Audit:** geplant
  *nach* Phase 5 + 6c. Stand 2026-05-04: claude-agent-sdk 0.2.123 vs
  latest 0.2.126, codex-cli 0.125.0 vs latest 0.128.0; binary
  `claude` ist sync (2.1.126). Plus `npm outdated` für andere Deps.
  Sweep läuft mit derselben 5-Pattern-Test-Matrix vom 2026-05-04
  als Smoke-Test. Details: `private/FUTURE.md`.
- **Phase X — Skill-Handling (vorher unterhalten):** als eigene große
  Phase reserviert, NICHT in Phase 4-Polish reingerutschen lassen.
  Wir haben mit ~25 Tools die Schwelle wo Skills sich lohnen längst
  überschritten, aber 9 offene Fragen müssen vor Bau diskutiert sein
  (Skills-vs-Tools-Trennung-Strenge, Storage-Location, Discovery-
  Mechanik, Self-Improvement-Loop, Verhältnis zu Memory + Persona,
  AgentSkills.io-Kompatibilität). Reihenfolge wahrscheinlich nach
  Phase 5 + 6c, plus Aufwand 3-5 Tage. Diskussions-Liste:
  `private/FUTURE.md` Abschnitt „Phase X — Skill-Handling".

### Dateien-Pointer

- `src/tools/types.ts` — ToolDefinition Timeout-Felder
- `src/engine/openai-compatible.ts` — tool-aware Race-Resolver
- `src/tools/agents/status.ts` — pending-Pattern, hint-Feld
- `src/tools/agents/spawn.ts` — sync spawn timeout
- `src/config/types.ts` — claudeCli + codexCli config-Blöcke
- `src/config/loader.ts` — applyClaudeCliSdkEnv, applyCodexCliEnv
- `src/mcp/config.ts` — somoraMemoryCodexFlags mit tool_timeout_sec
- `~/.somora/agents/{hans,lisa,jarvis}/agent.yaml` — idleMinutes 60
- `docs/research/tool-architecture.md` Sektion 6.1
- `private/DECISIONS.md` #37
- `private/FUTURE.md` — Dream-Worker-Priorisierung Konzept

### Pickup-Satz für nächste Session

> "Phase 6 Modus 1 ist voll validiert über alle drei Engines (opus,
> codex, gemma) inkl. cross-engine. Tool-Timeout-Architektur ist
> tool-aware: Tools deklarieren ihre Wartezeit selbst, lang-blockierende
> Tools returnen pending statt error. Drei CLI-spezifischen Hard-Limits
> (claude-cli MCP_TOOL_TIMEOUT 5min, codex-cli tool_timeout_sec 60s,
> openai-compatible 30s-Race) jetzt alle auf 10min konfigurierbar via
> config.yaml claudeCli/codexCli. Dream-Worker idle 60min als Hotfix
> gegen Concurrency-Stau; eigentliche Lösung (User-Active-Marker) in
> FUTURE. Nächste Entscheidung: Phase 6c (agent_ask) oder Phase 5
> (exec)."

---

## Vorheriger Stand (2026-05-03 spätabend — A2A Modus 1 live, alle drei Engines)

**HEAD: dcbc854** auf github.com/thenaxon/somora_agent (private).

Phase 6 (Agent Orchestration) — Modus 1 (sealed delegation) ist live
über alle drei Engines. Hans kann andere Personas oder Self-Klone als
Sub-Agents spawnen, async (default) oder sync, mit Recursion-Cap und
Concurrency-Cap, mit Cross-Engine-Composition (Hans-auf-opus → Lisa-
auf-gpt55 → Jarvis-auf-gemma).

### 6a — Foundation (commit 52cdc08)
- `NormalizedEvent.user_message.from_agent?: string` auf der Wire
- `TurnInput.fromAgent` + `subagentDepth` durch alle drei Adapter
- `withFromAgentHeader` helper — alle Engines prependen denselben
  `[Message from agent X]`-Header konsistent
- Replay-Prefix labelt A2A-Pairs als `User (from agent X)`

### 6b — Modus 1 sealed task (commit 1f98c25)
- `spawn_subagent({persona?, model?, task, wait?, maxRounds?})`
- `spawn_subagents({tasks, wait?})` — bis zu 8 parallel
- Sub-Sessions via `createSession()` mit ms+rand Slug-Suffix
- spawn-Meta in SessionMeta: `{ kind, parent_agent, parent_session,
  task_summary }`
- Tools nur in-process registriert, MCP-Pfad fehlt noch (kommt 6b.1)

### 6b.1 — HTTP-Fallback für MCP (commit 0f5ff8a)
- `POST /chat/send-sync` Endpoint — sync wrapper um `runChatTurn`
- spawn_subagent fällt auf HTTP zurück wenn injectedDeps null
- SOMORA_HOST + SOMORA_PORT env vars in MCP child config (für beide
  CLI-Engines via `somoraMemoryServerSpawn` + `somoraMemoryCodexFlags`)
- Bug-Fix nachgereicht (commit 2fcff4d): alte injectedDeps-Guard
  entfernt die den Fallback blockierte

### 6b.2 — Async wait:false default + status/result (commit 949870f)
- spawn default jetzt `wait: false` — Hans kriegt task_id, Turn
  endet, User chattet weiter
- `subagent_status({task_id})` — running/done/failed
- `subagent_result({task_id})` — Final-Result wenn done
- In-Memory Task-Store `src/server/async-tasks.ts`
- Endpoints: `POST /spawn-async`, `GET /spawn-status`,
  `GET /spawn-result`, `GET /spawn-list`
- Session-Naming-Race-Fixes: ms+rand Slug, `createSession`
  Collision-Retry mit `wx`-flag, `sessionMetaStore.set` tmp mit
  pid+ts+rand (commit dd72577)

### 6b.3 — Hans's Bug-Report-Fixes (commit dcbc854)
Hans hat einen sauberen Bug-Report geschrieben über `result: ""` wenn
ein Orchestrator-Sub maxRounds erreicht ohne final-message. Vier Fixes
gelandet:
- **Force-Summary:** wenn Loop bei maxRounds ohne content endet → ein
  letzter LLM-Call ohne Tools mit "use all rounds gone, summarize now"
- **wait_until_done auf subagent_result:** Block server-side bis fertig,
  verbrennt KEINE caller-side rounds (vorher Poll-Loop nötig)
- **Synthetic Marker:** wenn auch Force-Summary failt → klare
  `[somora] Sub reached cap of N rounds...` Message statt leerer String
- **Per-Spawn maxRounds:** `spawn_subagent({maxRounds: 32})` für
  Orchestrator-Subs die mehr Budget brauchen

---

## TODO morgen (2026-05-04)

### Test-Checkliste
1. **Same payment-orchestration test wie Hans gestern**
   ```
   "schicke einen subagent los der 3 payment orchestration firmen sucht
    er kann auch gerne selbst subagents losschicken sie sollen auch die
    webseiten dazu anschauen und dir alle infos geben damit du dann
    einen vergleich der 3 anbieter machen kannst"
   ```
   - Sollte mit Force-Summary + wait_until_done sauber durchlaufen
   - Wenn nicht: bug-trace, Hans's Format adoptieren

2. **wait_until_done UX prüfen** — Hans sollte beim Vergleichen NICHT
   Poll-Loops bauen sondern `subagent_result(task_id, wait_until_done:
   true, timeout_ms: 300000)` aufrufen

3. **Per-spawn maxRounds testen** — Hans (oder Sub-Hans) muss bei
   Orchestrator-Tasks `maxRounds: 32` o.ä. setzen. Description sagt's
   ihm, mal sehen ob er's adoptiert

4. **Cross-Engine Spawning** — `spawn_subagent({persona: 'lisa', model:
   'gemma4big', task: '...'})` — Hans-on-opus delegiert an Lisa-on-gemma
   sollte über HTTP-Fallback gehen

5. **Recursion-Cap (depth=3)** — verifizieren dass tief verschachtelte
   Subs sauber refusen

### Build-TODOs (in Reihenfolge)

**Phase 6c — Modus 2 `agent_ask` (live messaging):**
- Tool: `agent_ask({agent: 'lisa', message: '...'})` — postet AS Hans
  in Lisas main, blockt bis Lisas Antwort, beide Turns sichtbar in
  Lisas main
- Lock-Semantik: Lisa hat per-session-lock, fail-fast wenn Lisa busy
- Memory + Dream durchlaufen normal (Lisas auto-inject sieht den
  from_agent-Turn)
- TUI-Rendering: from_agent-User-Messages mit Sender-Icon statt
  User-Icon — siehe `src/cli/tui/turn-views.tsx` UserTurn

**Phase 6c.1 — TUI-Rendering Phase 6a foundation auch sichtbar machen**
- TUI parst `from_agent` aus user_message events
- UserTurn rendert mit Sender-Icon plus Marker

**Phase 5 — exec + tmux (großer separater Design-Block):**
- Vor-Bau: User wollte exec mit Hard-Blacklist (kein Approval-Flow),
  Sandbox-Dir per Agent, target=local|<resource>, PTY-Support,
  Background-Jobs+notify_on_complete
- Hard-Blacklist-Liste schon dokumentiert in
  docs/research/tool-architecture.md
- tmux-Tool-Familie als Phase 5b: tmux_create / tmux_send /
  tmux_capture / tmux_list / tmux_kill — analog zu OpenClaws
  tmux-agent-teams skill aber typed, nicht prompt-getrieben
- Smart-Approval-LLM-Layer (à la Hermes) explizit out-of-scope —
  User wollte simple Blacklist
- Konkretes File: privat/A2A-design.md hat Mode-3-Sketch unten

**Phase 4-Polish (kleiner Kram):**
- Anthropic Prompt-Caching aktiv markieren
- Multimodal Image-Routing für openai-compatible
- Token-Counting-Genauigkeit
- Obsidian Wikilink-Awareness im Memory-Layer

**Phase 6d — Skills-Layer (FUTURE):**
- AgentSkills.io spec, OpenClaw-style Frontmatter mit `requires.bins`
- Erst sinnvoll wenn 10+ Tools rechtfertigen, aktuell ~25

### Offen / unklar morgen zu klären
- Hat Hans den Force-Summary-Pfad tatsächlich getroffen? (= sah er
  vorher leeres Result, jetzt Markdown-Summary?)
- Race beim parallel Spawn voll behoben? (3 Subs mit ms-Kollision
  sollten alle saubere unique Slugs kriegen)
- agent_ask Modus-2 oder erst exec? — Bauchgefühl: agent_ask, weil
  es auf der A2A-Foundation aufsetzt und die Mode-Trennung sauber
  abschließt. exec ist eigene größere Diskussion

### Dateien wo's morgen weitergeht
- `private/A2A-design.md` — vollständige Architektur-Skizze, alle
  Decisions A-E + Detail-Fragen 1-5 gelocked
- `docs/research/tool-architecture.md` — exec Hard-Blacklist
  Referenz, OpenClaw + Hermes-Vergleich
- `~/.openclaw/skills/tmux-agent-teams/SKILL.md` — Vorbild-Pattern
  für Phase 5b

### Pickup-Satz für nächste Session
> "Phase 6 Modus 1 (spawn_subagent) ist live über alle drei Engines
> mit async-default, wait_until_done auf subagent_result, und
> per-spawn maxRounds. Hans's Bug-Report-Fixes sind drin. Erstes
> Test-Vorhaben: payment-orchestration-Vergleich nochmal,
> verifizieren dass Force-Summary + wait_until_done UX sauber sind.
> Dann Phase 6c (agent_ask Modus 2) oder Phase 5 (exec mit
> Hard-Blacklist) — User entscheidet."

---

## Vorheriger Stand (2026-05-03 abend — Phase 1 Tools komplett, Skeleton-Refactor durch)

Das System ist jetzt End-to-End mit echten Tools nutzbar — nicht mehr
nur Memory/Dream. Hans kann googeln, Webseiten lesen, Notes im Vault
schreiben und verschieben (mit Wikilink-Preservation), Datum/Uhrzeit
abfragen. Drei Engines weiterhin parity, Tool-Surface ist
engine-agnostisch.

**Heute (2026-05-03) — alles getestet, gepusht:**

Bugfix-Welle (commit 00e0003):
- resetSession touched leere jsonl (non-main sessions waren nach reset
  unauflösbar)
- /agent+/session validieren Existenz vor switchTo
- SSE bricht bei 4xx ab statt endlos zu reconnecten
- /show memory|tools on|off mit Config-Defaults (server-zentrisch via
  /tui-config Endpoint)
- Tool-Format-Logik vom TUI auf Server gezogen (callId→tool
  Korrelation, pre-formatted summary auf der SSE-Wire). Behebt nebenbei
  Bug dass per-tool result summaries nie liefen
- TUI-Polish: autocomplete window scrolling, header zeigt show-Status

Thinking-Steuerung Stufe 1+2 (commit 295151f):
- cross-engine `/thinking off|low|medium|high` plus persona-default in
  agent.yaml
- claude-cli mappt auf effort/disabled (SDK-recherche bestätigt),
  codex-cli auf -c model_reasoning_effort, openai-compatible auf
  reasoning_effort body field
- Capability-getrieben: Modelle ohne `reasoning` in capabilities →
  dormant-Anzeige (gelb) im Header statt silent placebo
- Reasoning-Token-Count im Header (`↓ 387 (1.2k 🧠)`)
- Stream-Phase-Indikator "🧠 thinking…" während Pre-Content
- Doku: docs/thinking.md
- Stufe 3 (Block-Sichtbarkeit) bewusst zurückgestellt → FUTURE.md

/verbose framework (commit e55a2e9):
- /verbose tools|memory|system on|off
- tools → volle Input/Output Payload unter jedem Call/Result
- memory → voller Inject-Block-Volltext unter [memory · …]
- system → einmaliger System-Prompt-Print via neuer Endpoint
- Server hängt `details`/`fullText` immer auf SSE Wire, Client filtert
- Doku: docs/display.md

Codex Disable-Liste verschärft (commit 37da701):
- 14 → 41 disabled features. All-own-tools-Posture.
- Web_search-Hallucination bestätigt: enovom.com Test mit dem neuen
  web_fetch zeigte dass Hans damals halluziniert hat, kein Tool-Leak

Tool-Architektur Recherche (commit 2087479):
- docs/research/tool-architecture.md (525 Zeilen) — Vergleich OpenClaw
  + nousresearch/hermes-agent. Beide Repos gelesen, verbatim Snippets
- Skeleton-Erweiterungen: ToolDefinition.toolset (required),
  maxResultSizeChars (default 100k, registry truncates JSON-string),
  available(ctx) (filter aus listAvailable, hidden vor Modell)
- ToolContext um config: Config erweitert
- /tools Debug-Endpoint zeigt toolset, cap, hasAvailabilityCheck

Phase 1 Tools (commits 41a01c6 ... 1f597f6):
- ✓ time_now (commit 41a01c6) — Datum/Zeit/Wochentag/Wochennummer,
  IANA-Timezone-Param, validiert via Intl.DateTimeFormat
- ✓ web_search (commit b7d932a) — Brave Search API, query+count+
  country+freshness, available() gated auf config.web.brave.apiKey
- ✓ web_fetch (commit d0fce00) — Mozilla Readability + jsdom +
  turndown, SSRF-Guard (RFC1918+loopback+link-local+CGNAT+IPv4/v6
  metadata), 750 KB Body-Cap, Re-Check nach Redirect, prompt-injection
  wrapping `<external_content source="web_fetch" warning="...">`
- ✓ obsidian_write/move/delete (commit 1f597f6) — Vault-Pfad-Sandbox
  via realpath, readOnlyPaths-Enforcement, frontmatter-Merge via
  gray-matter, **Wikilink-preserving Move** (basename + relative-path
  patterns mit |display und #heading), soft-delete in `.trash/<ts>-...`
- Smoke-tested end-to-end durch Rene: web_search, web_fetch, obsidian
  alle live geprüft, funktionieren

Brave-API-Key in `~/.somora/config.yaml` (gitignored, nicht im Repo).
Hans hat reasoning-Capability bei opus/sonnet/gpt55/gpt54mini/codex53,
gemma4big/small bewusst nicht (zeigen dann ehrlich „dormant").

---

## Was als nächstes ansteht

**Phase 2 — File-Tools (`file_read/write/patch/search`):**
- Braucht Sandbox-Design: was ist Agent's Workspace? Default
  `~/.somora/agents/<name>/workspace/`?
- readOnlyPaths-Pattern wie obsidian
- Realpath-Guards gegen Symlink-Escapes (haben wir bei obsidian schon)
- Adaptive Paging (OpenClaw-Style: 10% des aktiven Modell-Windows pro
  Page) oder einfacher fester Cap?
- Search via ripgrep-binary spawnen oder pure-TS Implementierung?
- ~5-7 Tage Aufwand wenn ohne unforeseen issues

**Phase 3 — `exec`-Tool (große separate Diskussion vor Bau):**
- Backend: lokal direct? Docker-Sandbox? andere?
- Hard-Blacklist (kein Approval-Flow, kein Override) — Liste in
  docs/research/tool-architecture.md schon dokumentiert
- Per-Pattern path-Whitelist (kein Schreiben in ~/.ssh, /etc, etc.)
- Working-Dir per Agent
- Cancellation
- Background-Jobs + notify_on_complete (Hermes-Pattern)
- PTY-Support für TUI-Tools (Codex/Claude-Code-Subprozesse als Tool)
- Wie verhalten sich claude-cli und codex-cli wenn ihr eigenes
  shell_tool disabled ist und unser exec zur Verfügung steht?

**Phase 4 — Polish:**
- Anthropic Prompt-Caching aktiv markieren
- Multimodal Image-Routing für openai-compatible (Schema hat's,
  Adapter ignoriert)
- Token-Counting-Genauigkeit (statt 4-chars/token Heuristik)
- Obsidian Wikilink-Awareness im Memory-Layer (Recall-Expansion)
- Skills-Layer (FUTURE.md hat Eintrag, eigene Phase wenn 10+ Tools
  rechtfertigen)

**Phase 5+ — Frontends:**
- Voice/Realtime
- Telegram
- Web-Client (Orbit) — Tool-Surface ist schon engine-agnostisch und
  dünn-client-fähig, Wire-Protocol komplett dokumentiert

---

## Vorheriger Stand (2026-05-01 spätabend — Phase 2-Stufe-B/C/D MVP komplett)

**Phasen 1, 2-Stufe-A, B, C, D-MVP durch.** System ist End-to-End
benutzbar mit Memory + Tools + Dream-Mode (manueller Trigger). Drei
Engines im Gleichstand bei Konversation, Compaction, Tool-Surface und
Memory-Anbindung. Auto-Dream (Idle-Trigger) noch offen, agreement to
build steht.

**Phase 2-Stufe-A** (Three-Engine-Parität): `npm run dev:server` +
`npm run dev:cli` läuft, alle drei Engines reden, Sessions
persistieren, `/model`-Switching live, Compaction greift cross-engine.

**Phase 2-Stufe-B (Memory-Layer) komplett.** Markdown-as-Source +
SQLite/sqlite-vec-Index, lokale Embeddings (all-MiniLM-L6-v2 default,
~30MB), Hybrid-Retrieval (Vector 0.7 + BM25 0.3), Auto-Inject pro Turn.
Memory-Tools (search/get/list/write/edit/delete) als MCP-Server
exponiert für claude-cli + codex-cli, plus in-process für openai-
compatible. Obsidian-Vault als optionale Read-Source mit `readOnlyPaths`.
DECISIONS #25–#31 dokumentieren das Konzept.

**Phase 2-Stufe-C (Agent-Loop für openai-compatible) komplett.**
TurnInput.tools + ToolInvoker, openai-compatible erkennt tool_calls
aus dem Stream, dispatcht via in-process ToolRegistry, max 8 Rounds
(konfigurierbar via `agentLoop.maxRounds`), per-Tool-Timeout
(`agentLoop.toolCallTimeoutMs`). Drei-Engine-Tool-Parität erreicht.

**Phase 2-Stufe-D MVP (manueller Dream-Trigger via /reset)
komplett.** Async LLM-Extraktion über JSONL-Delta, Findings als
konkrete Aktionen (memory_write/edit/delete/vault_hint), strukturierte
Markdown-Files unter `~/.somora/agents/<name>/memory/.dreams/` mit
Status-Lifecycle (running/paused/failed/completed/processed). Tool-
Surface (dream_list/get/apply/dismiss) sowohl in-process als auch via
MCP. Crash-Recovery für orphan running-Dreams beim Server-Start.

**Sicherheits-Audit komplett.** Beide CLI-Engines haben jetzt
Defense-Layer gegen Host-Context-Leaks:
- claude-cli: 5-Layer (settingSources/tools/disallowedTools/canUseTool/
  managedSettings.autoMemoryEnabled=false)
- codex-cli: --ignore-user-config, --ignore-rules,
  project_root_markers=[], plus 14 disabled built-in features
  (shell/exec/browser/JS/web-search/personality/memories/...)
Auto-Memory-Leak (Claude Code's project-memory in agent prompts) und
codex' AGENTS.md walk-up identifiziert + geschlossen.

---

### Auf einen Blick — was Hans heute kann

| | claude-cli (opus) | codex-cli (gpt55) | openai-compatible (gemma) |
|---|---|---|---|
| Chat | ✓ | ✓ | ✓ |
| Memory READ (Auto-Inject) | ✓ | ✓ | ✓ |
| Memory WRITE (Tools) | ✓ via MCP | ✓ via MCP | ✓ via Agent-Loop |
| Dream-Tools | ✓ via MCP | ✓ via MCP | ✓ via Agent-Loop |
| somora-managed Compaction | — (Anthropic-intern) | — (codex-intern) | ✓ |
| Vault als Recall-Source | ✓ | ✓ | ✓ |

---

### Was bewusst noch offen ist

- **AutoDreamWorker (Idle-Trigger)** — Phase 2-Stufe-D Phase B. Manuell
  geht, Idle-Trigger fehlt. Design steht (idleMinutes per agent, Pause
  via AbortSignal bei chat.send, Resume on next idle, dreamReadThroughTs-
  Marker pro Session).
- **Anthropic Prompt-Caching aktiv markieren** — opus subscription-User
  profitiert eh implizit, aber für eventuelle API-Key-User später
  relevant. DECISIONS #20 Polish.
- **`obsidian_write` Tool** — User-getriggertes Vault-Schreiben mit
  `readOnlyPaths`-Beachtung.
- **Obsidian Wikilink-Awareness** — FUTURE.md, Lebensqualität.
- **Phase 3+** — Voice/Realtime, Telegram, andere Frontends.

---

### Veraltete Sektionen — historisch erhaltene Phase-2-Stufe-B-Entstehungsnotizen

(Bleiben für Audit-Trail; Inhalt ist „eingerollt" in den Stand oben.)

**Phase 2-Stufe-B im Bau.** Konzept-Doku + Foundation + Memory-Core
sind durch (siehe DECISIONS #25–#30, FUTURE.md):

- DECISIONS #25–#30 dokumentieren Memory-Layer + Config-Migration
- FUTURE.md hält Dream-Mode + Agent-Loop für openai-compatible fest
- `compaction:`- und `memory:`-Sektion im config.yaml verfügbar
  (DECISION #30: config statt Env-Var). Schema-Defaults greifen wenn
  config-Block leer
- `SOMORA_COMPACTION_*` Env-Vars sind jetzt Override-Layer über
  `config.yaml.compaction`, nicht mehr Primärquelle
- AGENTS.md-Frontmatter aufgeräumt: model/fallback in `agent.yaml`,
  Frontmatter nur noch Identity (name/description/icon)
- CLI-SSE-Stream-Bug behoben (Server-Heartbeat alle 20s, Cleanup toter
  Subscriber on writeSSE-Fail, Client-Auto-Reconnect mit Backoff)
- **Memory-Core gebaut** in `src/memory/`:
  - `storage.ts`: SQLite + sqlite-vec (FTS5-Fallback wenn vec nicht lädt),
    Schema-Migration, Chunk-Replace-Transactions
  - `chunking.ts`: Markdown → Paragraph-Chunks mit Overlap, Frontmatter-Strip
  - `embeddings.ts`: Provider-Abstraktion. Default `local` via
    `@huggingface/transformers` (`Xenova/all-MiniLM-L6-v2`, 384-dim,
    ~30MB First-Run-Download). Aliases für gemma + mpnet vorbereitet
  - `retrieval.ts`: Hybrid Vector+BM25 mit Min-Max-Norm-Fusion, FTS5-
    Sanitization
  - `watcher.ts`: chokidar mit per-Pfad-Debounce (1500ms default)
  - `manager.ts`: per-Agent Public-API (search/list/get/write/delete +
    reindex on file change)
  - `registry.ts`: process-wide Manager-Cache mit lazy init, agent.yaml
    obsidian-Konfig wird hier eingelesen
  - `inject.ts`: Auto-Inject-Block-Builder, Token-Cap, `<memory-context>`-
    Wrapper mit Hinweis-Header
- **Auto-Inject in `chat/send` aktiv:** Server augmentiert pro Turn den
  systemPrompt mit Recall-Block. Nicht-persistierend (JSONL bleibt
  unangetastet)
- **Smoke-Test grün:** „italienisches Auto" findet Fiat-Note (Synonym),
  „Versicherung" findet sie via BM25-Boost. End-to-end Embed→Index→
  Hybrid-Search funktioniert

**Steht als nächstes an (Phase 2-Stufe-B Abschluss):**
1. Memory-Tools für Hans (`memory_search`, `memory_get`, `memory_write`,
   `memory_edit`, `memory_delete`, `memory_list`)
2. Lokaler MCP-Server, Hookup in claude-cli + codex-cli
3. Obsidian-Integration end-to-end testen (Konfig wird schon gelesen,
   aber kein Vault gegen-getestet)
4. Eventuelles `obsidian_write`-Tool für selektives Schreiben

---

## Phase 2-Stufe-B + C Abschluss (2026-05-01 mittags)

Stufe B + C vollständig durch:

- **Memory-Tools** gebaut + via MCP-Server in claude-cli und codex-cli
  hookt — sechs granulare Tools (DECISION #31), source-agnostic Read,
  source-spezifischer Write
- **MCP-Server** als spawned Child-Prozess pro CLI-Turn, Pino-Logger
  schreibt nur in File (Phase 2j.5 fix), `default_tools_approval_mode
  = "approve"` für non-interactive auto-approve auf codex-Seite
  (Phase 2j.6 fix)
- **codex-cli Built-In-Tools deaktiviert** (DECISION #23) — shell, exec,
  browser, JS, image-gen, web-search etc. abgeschaltet, nur somora-memory
  als Tool-Surface
- **Obsidian-Vault end-to-end** getestet gegen `/mnt/naxon/obsidian`
  (48 Files), `readOnlyPaths` für `Infrastruktur` markiert (Phase 2g)
- **Ephemeral Context Refactor** (Phase 2j.1) — TurnInput hat jetzt
  `systemPrompt` (stable, cacheable) + `ephemeralContext` (per-turn).
  Behebt den codex-resume-Bug wo Memory-Block nach Turn 1 droppte
- **Phase 2-Stufe-C: Agent-Loop für openai-compatible** (Phase 2k):
  TurnInput.tools, openai-compatible-Engine erkennt `tool_calls` aus
  dem Stream, dispatched via in-process ToolRegistry, max 8 Rounds.
  Damit Hans-auf-gemma vollständig — kann jetzt aktiv `memory_*`
  callen genau wie Hans-auf-opus / Hans-auf-gpt55.

**Drei-Engine-Parität auf Tool-Level:**

| Engine | Tool-Surface |
|---|---|
| claude-cli | MCP-Server via SDK, `canUseTool` Allowlist `mcp__somora-memory__*` |
| codex-cli | MCP-Server via `-c` TOML, `default_tools_approval_mode="approve"`, alle Built-ins disabled |
| openai-compatible | In-process Agent-Loop, OpenAI-Tools-API, max 8 Rounds, Tool-Calls direkt durch ToolRegistry |

CLI rendert `[memory · …]` (Auto-Inject), `[tool call · …]` und
`[tool result · …]` einheitlich für alle drei.

**Was als nächstes ansteht:**
- **Phase 2-Stufe-D — Dream-Mode**. Konzept in FUTURE.md fest. Liest
  JSONL-Delta seit letztem Marker, extrahiert Memory-würdiges Material,
  hinterlegt Findings. User-Approval-Loop danach. Adressiert die
  „Memory-Verlust bei interner Compaction der CLIs"-Sorge ohne dass wir
  Compaction zurücknehmen müssen.
- **Obsidian-Wikilink-Awareness** (FUTURE.md) — Wikilinks beim Chunking
  extrahieren, Recall-Expansion über verlinkte Notes.
- **`obsidian_write`-Tool** — explizites User-getriggertes Schreiben in
  den Vault, respektiert `readOnlyPaths`.

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

### Slash-Commands im CLI (aktuell)

```
/help, /quit, /exit
/agents                          list agents
/agent <name> [session]          switch agent
/sessions                        list sessions of current agent
/session <slug-or-id>            switch session (slug → newest match)
/new <slug>                      create new session, switch into it
/main                            back to current agent's main
/reset                           preview reset of current session
/reset YES                       archive current session, start fresh
                                 (auto-spawns dream if dream.enabled)
/models                          all configured models with aliases
/model                           current effective model + source
/model <alias-or-ref>            override for this session
/model default                   clear override
```

### HTTP-API (aktuell)

```
GET  /healthz
GET  /env                                          effective env vars
GET  /agents
GET  /tools                                        tool catalog incl. dream_*
POST /agents/:agent/tools/:name                    invoke tool directly (debug)
GET  /agents/:agent/sessions
POST /agents/:agent/sessions                       { slug }
POST /agents/:agent/sessions/:session/reset        archive + reset, spawn dream
GET  /agents/:agent/memory/notes                   indexed memory list
GET  /agents/:agent/memory/search?q=…              hybrid recall debug
GET  /chat/history?agent=&session=
GET  /chat/stream?agent=&session=                  (SSE incl. memory + tool events)
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

- **Memory-Layer-Implementation** — Konzept ist 2026-05-01 abgesegnet
  (siehe DECISIONS #25–#28), Bau läuft als Phase-2-Stufe-B. Storage
  (Markdown + sqlite-vec), Embeddings (lokal via node-llama-cpp),
  Auto-Inject (Hermes-style, Runtime nicht Agent), Memory-Tools,
  Obsidian-Vault als optionale Read-Source — alles entschieden,
  nicht gebaut.
- **Agent-Loop für `openai-compatible`** — Phase-2-Stufe-C, kommt
  direkt nach Memory. Sodass openai-compatible Memory-Tools + andere
  Tools genauso aufrufen kann wie claude-cli/codex-cli es eingebaut
  haben. Siehe FUTURE.md.
- **Dream-Mode** — Phase-2-Stufe-D oder später. Konzept in FUTURE.md
  fixiert: Read-Only-Träumer findet Inkonsistenzen Memory ↔ Sessions
  ↔ Vault, hinterlässt Findings, User+Hans approven manuell. KEIN
  Auto-Promotion à la OpenClaw.
- **Eigenes Tool-System** — Memory-Tools sind der Anfang davon.
  Allgemeines Tool-System mit Allowlist pro Agent, MCP-Hookup, etc.
  baut darauf auf in späteren Phasen.
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
> „Phase 2-Stufe-B/C/D-MVP durch. Hans hat Memory (Read+Write via Tools),
> Vault-Anbindung, und Dream-Mode mit manuellem /reset-Trigger.
> Drei-Engine-Parität auf Tool- und Memory-Ebene. Sicherheits-Audit
> beider CLI-Engines komplett (Auto-Memory + AGENTS.md-Walk-Up
> geschlossen). Offen: AutoDreamWorker (Idle-Trigger), Phase 2-Stufe-D
> Phase B. Plus Obsidian-Wikilinks, obsidian_write, prompt-caching
> activation, Phase 3-Themen (Voice/Telegram)."

Falls die nächste Session direkt am AutoDreamWorker einsteigt: Design
steht in DECISIONS-Eintrag „Dream-Mode" + den Konversations-Notizen.
extract.ts unterstützt schon AbortSignal; nötig sind:
- per-Agent Idle-Tracker (resetten auf chat.send, fire nach idleMinutes)
- chat.send hooked → bestehenden Dream-AbortController abbrechen
- dreamReadThroughTs-Marker im SessionMeta
- Resume-Loop: paused-Dreams werden beim nächsten Idle re-ranned

Memory-Layer-Konzept (Kurzform, Details in DECISIONS #25–#28):

- Markdown auf Disk = Source-of-Truth (`memory/notes/<slug>.md`)
- SQLite + sqlite-vec als abgeleiteter Index (`memory.db`)
- Lokale Embeddings (`embeddinggemma-300m` via node-llama-cpp)
- Auto-Inject pro Turn (letzte 3 Turns als Query, Top-5, Score+Token-Cap)
- Tools: `memory_search`, `memory_get`, `memory_write`, `memory_edit`,
  `memory_delete`, `memory_list`
- MCP-Server für claude-cli/codex-cli; openai-compatible bekommt
  Direct-Bridge wenn Agent-Loop in Stufe-C gebaut ist
- Obsidian-Vault als optionale Read-Source pro Agent
  (`agent.yaml` → `obsidian.vault`, `obsidian.readOnlyPaths`),
  Schreiben nur über `obsidian_write` auf User-Aufforderung
- Pro-Agent `workspace`-Pfad in `agent.yaml` (für freie Files via Tools)

Vorgehen:
1. SQLite + sqlite-vec einbinden (Schema, File-Watcher, Re-Index)
2. Embeddings (node-llama-cpp + GGUF download), Chunking
3. Hybrid-Retrieval (Vector + FTS5)
4. Auto-Inject in Server-Turn-Pipeline
5. Memory-Tools + lokaler MCP-Server
6. claude-cli/codex-cli MCP-Hookup
7. Obsidian-Source-Indexer
8. STATUS-Update auf Stufe-B-Done

### Test-Sessions zum Aufräumen

Während Stufe A wurden mehrere Test-Sessions in
`~/.somora/agents/hans/sessions/` angelegt: `codex-smoke`,
`codex-smoke2`, `codex-resume`, `tokens-test`, `crossengine`,
`compaction-test`, `smartcompact`, `crossworker`, `codexworker`,
`codexworker2`. Können bei Gelegenheit per `rm` weg.

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
