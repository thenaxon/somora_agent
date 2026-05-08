# Wiki-Design — Memory/Dream/Obsidian-Architektur (Phase 4)

Working draft nach Konzept-Diskussion 2026-05-08 mit Rene, anschließend
an Karpathys „LLM Wiki"-Pattern (gist 442a6bf...). Alle F-Punkte (F1–
F6) und G-Punkte (G1, G2) sind ✓ vom User abgesegnet, plus die Lint-
Frage durchgesprochen (Dream-C wird mit-gebaut).

Gilt als verbindliche Architektur für die Phase-4-Implementierung. Was
implementations-seitig offen ist (Wiki-Page-Templates, Dream-Prompts,
Tool-Surface) steht am Ende als TODO.

---

## Grundprinzip

**Memory wird in zwei Tiers aufgeteilt:**

- **Kurzzeitgedächtnis** (per-Agent, agent-private): existierender
  Memory-Layer in `~/.somora/agents/<name>/memory/*.md`. Was der Agent
  in Konversation lernt landet hier. Approval-Gate via Dream-A-User-
  Loop wie heute.
- **Langzeitgedächtnis** (server-global, alle Agents geteilt): neues
  „somora-Wiki" als designierter Subfolder im Obsidian-Vault, vom
  Dream-Worker konsolidiert geschrieben, mit Wikilinks und
  auto-gepflegtem Index.

Konsolidierung passiert im **Dream-Worker, jetzt aufgeteilt in drei
Modi:**

- **Dream-A: session → memory** — wie heute, mit Approval, billig+
  lokal, häufig
- **Dream-B: memory → wiki** — neu, ohne Approval, smart+teuer,
  selten
- **Dream-C: wiki-Lint** — neu, mit Approval (wegen Korrekturen),
  smart+teuer, sehr selten

Karpathys 3-Operations-Mental-Model (Ingest/Query/Lint) entspricht
bei uns: Ingest = Dream-A+B, Query = Auto-Inject + memory_*-Tools,
Lint = Dream-C.

**Was vom Karpathy-Gist nicht übernommen wird:** das Gist ist
absichtlich abstrakt — keine konkreten Templates, Prompts oder
Strukturen darin. Wir nehmen das **Pattern** (compounding artifact
statt re-derive-each-query, LLM-maintained cross-refs, lint als
Erste-Klasse-Operation), schreiben unsere eigenen Templates und
Prompts.

---

## Mental Model — Vier Layer

| Layer | Source | Schreiber | Leser | Search-Prio |
|---|---|---|---|---|
| **L1 Sessions** | `~/.somora/agents/<name>/sessions/*.jsonl` (raw, append-only) | Runtime | Dream-A (Input) | nicht durchsucht |
| **L2 Short-term Memory** | `~/.somora/agents/<name>/memory/*.md` | Agent (memory_write) + Dream-A (mit Approval) | Agent + Dream-B | hoch (zweitens) |
| **L3 Long-term Wiki** | `<vault>/<somorawiki-subfolder>/**` | Dream-B (auto) + Dream-C (mit Approval) + User (manuell) | alle Agents | hoch (erstens) |
| **L4 Rest-of-Vault** | `<vault>/**` außerhalb des somorawiki-Subfolders | nur User | alle Agents (read-only) | niedriger |

**Single-writer-pro-File-Invariante:**

| File-Bereich | wer schreibt |
|---|---|
| `agents/<name>/memory/*.md` | nur Agent + Dream-A |
| `<vault>/<somorawiki>/**` | nur Dream-B + Dream-C + User (manuell) |
| Rest-of-Vault | nur User |

Niemand schreibt parallel auf dasselbe Ziel. Das macht Konflikt-
Resolution einfach: Dream-B/C respektieren mtime-Änderungen seit ihrem
Read und überspringen ggf. mit Log-Eintrag.

---

## Drei Dream-Modes — Verbindliche Spec

| | Dream-A | Dream-B | Dream-C |
|---|---|---|---|
| **Aufgabe** | session → memory | memory → wiki | wiki-Lint |
| **Trigger** | per-Agent idle (heute 60min) + Pre-Dream-B-Sweep (siehe unten) | server-global, Real-Clock-Default + manueller Tool-Trigger | server-global, wöchentlich + manueller Tool-Trigger |
| **Default-Cadence** | reaktiv (idle-trigger) | alle 12h | wöchentlich |
| **Read-Scope** | session-range + agent's eigenes memory (inkl. Stubs) **+ wiki** + referenced rest-of-vault | alle agents' memory (Stubs mit `## Recent observations`) + wiki | wiki only |
| **Write-Scope** | nur agent's eigenes memory (inkl. Stub-Observations) | nur wiki + wiki/index.md + wiki/logs/YYYY-MM.md + Stub-Cleanup in agent-memory | proposed wiki-fixes (User-approval) + nach Approval: wiki-Updates |
| **Approval** | ja (per-Agent-Chat, wie heute) | **nein** | ja (per-Agent-Chat, irgendein Agent — vermutlich der Mensch-nahe wie Hans) |
| **Modell-Profil** | billig & lokal (Default: gemma4big) | smart & teuer (Default: opus oder Sonnet) | smart & teuer (Default: opus) |
| **Approval-UX** | per-Agent dream_list/get/apply/dismiss wie heute | nicht zutreffend | per-Agent dream_list/get/apply/dismiss, Findings sind Wiki-Korrektur-Vorschläge |

### Dream-A Verhaltens-Detail

Heute: Worker liest session + existing_memory (slugs+content) + referenced_vault. Output = Findings (memory_write/edit/delete proposals).

**Neu:** zusätzlich liest Dream-A den Wiki-Subfolder als Read-Source — weil agent-memory nach Promotion aus Stubs besteht und Substanz fehlt für Konflikt-Vergleich. Das ist die einzige Read-Scope-Erweiterung.

Output bleibt: nur Proposals zu agent-memory. Wiki bleibt für Dream-A read-only.

**Konflikt-Pattern (Beispiel: Hans-Session erwähnt „Luca ist 9", Wiki sagt „Luca, 8"):**

1. Worker erkennt Widerspruch zwischen Session und Wiki
2. Proposal: append zu `agents/hans/memory/luca.md` `## Recent observations`:
   ```
   - 2026-05-08: Luca ist 9 (Session-Erwähnung; Wiki sagt noch 8)
   ```
3. User approves via dream_apply
4. Stub-Observations-Section ist befüllt → Dream-B beim nächsten Run integriert ins Wiki

### Dream-B Verhaltens-Detail

**Server-global**: ein Worker pro Server-Prozess, nicht pro Agent. Verarbeitet alle Agents' Stubs in Sequenz.

**Pre-Dream-B-Sweep:** ~1h vor jedem Dream-B-Run forciert der Sweep einen Dream-A für jeden Agent dessen unprocessed Sessions seit dem letzten Dream-A liegen. Damit hat Dream-B die Garantie, dass alle aktuellen Findings im Memory liegen.

**Promotion-Logik:**

```
für jeden Agent:
  für jeden agent-memory-File ohne promoted_to-Frontmatter:
    Worker entscheidet: ist der Inhalt promotion-würdig (langfristig
    relevant, nicht nur Tagesnotiz)?
    falls ja:
      schreibe wiki-Page in passende Sub-Direktive (personen/projekte/...)
      mit Wikilinks zu existing wiki-pages wenn topical überlappend
      mit Frontmatter (siehe Page-Template unten)
      ersetze agent-memory-File mit Stub (siehe Stub-Pattern unten)
      append wiki/logs/YYYY-MM.md: "promoted X aus <agent>/<slug>"
      append wiki/index.md update (oder am Ende des Runs einmal komplett)

  für jeden Stub mit befüllter ## Recent observations:
    Worker liest existing wiki-page + observations
    Merge-Prompt: "integrate diese Beobachtungen ins existing wiki"
    schreibt wiki-page neu (mtime-check vor write — siehe Konflikt)
    leert Stub's ## Recent observations
    bumpt Stub's promoted_at
    append wiki/logs/YYYY-MM.md mit der Revision
```

**mtime-Konflikt-Schutz:** Worker liest mtime einer wiki-page bevor er drüber schreibt. Vor dem Write nochmal check — wenn mtime geändert seit Read (User hat parallel manuell editiert), ABORT mit Log-Eintrag „skipped <file>, user-edited during dream-B run". Im nächsten Run mit deinem Stand wird's wieder probiert.

### Dream-C / Lint Verhaltens-Detail

Worker liest komplettes Wiki + index.md. Sucht nach:

1. **Widersprüche zwischen Wiki-Pages** (zwei Pages sagen widersprüchliche Sachen über dasselbe Subjekt)
2. **Stale time-relative Behauptungen** ("in 4 Wochen", "letzten Monat" — wenn Page-mtime ≥ 1 Monat alt + Page enthält time-relative Sprache)
3. **Broken Wikilinks** (`[[X]]` zeigt auf nicht-existierende Page)
4. **Orphan-Pages** (existieren aber nirgends verlinkt + nicht im Index)
5. **Index-Drift** (Pages im Subfolder die nicht in index.md auftauchen)
6. **Strukturelle Lücken** (einseitige Verlinkung — A erwähnt B namentlich aber B verlinkt nicht zurück)

Output: Findings als Korrektur-Vorschläge, formal wie Dream-A's Findings (User approves via dream_apply). Bei Approval führt das Tool die Wiki-Updates aus.

---

## Vault-Struktur

**Subfolder-Pfad konfigurierbar.** Default-Vorschlag: `somora/`. Heißt:
falls dein Vault `/mnt/naxon/obsidian` ist, lebt das Wiki in
`/mnt/naxon/obsidian/somora/`.

```
<vault>/<somorawiki>/
├── index.md                       — Dream-B-maintained Inhaltsverzeichnis
├── personen/
│   ├── rene.md
│   ├── luca.md
│   ├── conny.md
│   └── ...
├── projekte/
│   ├── somora.md
│   ├── ixopay.md
│   ├── flugschule.md
│   └── ...
├── wissen/                        — Konzepte, Fakten, Erlerntes
│   ├── ...
└── logs/
    ├── 2026-05.md
    ├── 2026-06.md
    └── ...
```

**Subfolder-Auswahl:** Dream-B entscheidet beim Promotion welcher
Subfolder passt. Initial-Set ist `personen/`, `projekte/`, `wissen/`.
Dream-B darf neue Subfolder anlegen wenn ein Topic nicht passt
(z.B. `orte/`, `werkzeuge/`) — index.md trackt was es gibt.

### Wiki-Page-Template

```markdown
---
slug: luca
type: person                       # person | projekt | konzept | ...
created: 2026-04-01
updated: 2026-05-08
sources:                            # welche agent-memory-slugs / sessions
  - hans/familie-luca-podcast       # haben zur page beigetragen
  - lisa/familie-rene
related:                            # explizite Cross-Refs
  - personen/rene
  - projekte/familie-luca-podcast
---

# Luca

## Aktueller Stand
(konsolidierte aktuelle Wahrheit, prosaisch)

## Eigenschaften
- Alter: 9 (Stand 2026-05-08)
- Tochter von [[personen/rene]] und [[personen/conny]]
- Macht Podcast (siehe [[projekte/familie-luca-podcast]])

## Zeitleiste
- 2026-04-01: Wiki-Page angelegt aus hans/luca
- 2026-05-08: Alters-Update 8→9 (via hans's session)

## Notizen
(freitext, kann auch deine manuellen Edits enthalten)
```

**Frontmatter-Felder verbindlich:** `slug`, `type`, `created`,
`updated`, `sources`, `related`.

**Section-Struktur konventionell:** `## Aktueller Stand`,
`## Eigenschaften` / `## Schlüsseldaten`, `## Zeitleiste`,
`## Notizen`. Dream-B hält sich daran, du darfst manuell andere
Sections einführen — Dream-B respektiert deine Struktur und
ergänzt nur.

### index.md-Format

```markdown
# somora-Wiki Index

Letztes Update: 2026-05-08 12:00 von Dream-B

## Personen
- [[personen/rene]] — Wenningvater des Hauses, Pilot in Ausbildung
- [[personen/luca]] — Renes Tochter (9), Podcast-Host
- [[personen/conny]] — Renes Frau

## Projekte
- [[projekte/somora]] — Local-first AI agent gateway, in Entwicklung
- [[projekte/ixopay]] — Renes Arbeitsgeber, Boardmeeting alle 6 Wochen
- [[projekte/flugschule]] — Renes Pilotenausbildung, Theorieprüfung 2026-04
- [[projekte/familie-luca-podcast]] — Lucas Podcast-Projekt

## Wissen
- [[wissen/...]] — ...

## Letzte Updates
- 2026-05-08: [[personen/luca]] (8→9)
- 2026-05-07: [[projekte/somora]] (Service-Mode-Workflow)
- ...
```

**index.md ist von Dream-B vollständig regeneriert.** Kein Append.
Der Worker liest am Ende seines Runs alle Pages, sortiert nach
Subfolder, schreibt index.md neu.

**„Letzte Updates"-Section:** letzte 10 Wiki-Edits aus logs/. Damit
ein Agent beim Lesen von index.md sofort sieht was sich geändert
hat.

### log.md-Format (monatlich rolling)

`logs/2026-05.md`:

```markdown
# Wiki-Log Mai 2026

## 2026-05-08

### Promoted
- [[personen/luca]] aus hans/luca (initial)
- [[projekte/somora]] aus hans/somora (initial)

### Updated
- [[personen/luca]] (8 → 9, source: hans-session 2026-05-08T12:34)

## 2026-05-07
...
```

**Append-only innerhalb des Monats.** Beim Monatswechsel legt
Dream-B `logs/2026-06.md` an. Logs ab 12 Monaten werden NICHT
automatisch archiviert (kosten kaum Speicher, agent kann hist.
Kontext nutzen).

---

## Memory-Struktur (Short-term)

### Stub-Pattern

Wenn Dream-B einen agent-memory-File ins Wiki promoted, wird der
File zu einem Stub:

```markdown
---
slug: luca
promoted_to: somora/personen/luca
promoted_at: 2026-05-08T12:00:00Z
---

→ Konsolidiertes Wissen: [[somora/personen/luca]]

## Recent observations (will be promoted next dream-B)

- (leer wenn nichts neues; agent appendet hierhin)
```

### memory_write-Verhalten

Tool-Verhalten nach dieser Architektur:

| Slug-Status | memory_write tut |
|---|---|
| Slug existiert nicht | normale neue Datei wie heute |
| Slug existiert + KEIN `promoted_to`-Frontmatter | normale overwrite wie heute |
| Slug existiert + HAT `promoted_to`-Frontmatter | append zur `## Recent observations`-Section, schreibt nicht den ganzen File neu |

**Detail:** appen passiert mit Datums-Bullet-Format:
`- YYYY-MM-DD: <kurzer Text vom Agent>`. Dream-B parst das beim
nächsten Run.

### Memory-Frontmatter — neue Felder

Bestehende slugs bleiben kompatibel — kein Frontmatter Pflicht. Neue
Felder die Dream-B nutzt:

- `promoted_to: <wiki-pfad-ohne-md>` — markiert Stub
- `promoted_at: <ISO-timestamp>` — letzter Promotion-Zeitpunkt

Stubs ohne diese Felder existieren nicht — entweder ist's ein voller
Memory-File (kein Stub) oder ein Stub mit beiden Frontmatter-Feldern.

---

## Search & Auto-Inject

### Drei Quellen, klare Priorisierung

| Source | Tag im Hit | Default-Boost |
|---|---|---|
| L3 Wiki (`<vault>/<somorawiki>/**`) | `[wiki]` | 1.0 (höchste) |
| L2 Short-term Memory (`agents/<name>/memory/`) | `[memory]` | 0.85 |
| L4 Rest-of-Vault | `[vault]` | 0.65 |

Boost wird auf den vector-similarity-Score multipliziert vor dem
Top-K-Cutoff. Heißt: bei gleicher Embedding-Ähnlichkeit gewinnt
Wiki, dann Memory, dann Rest-of-Vault.

**Source-Tag IMMER im Hit-Text sichtbar:**

```
[wiki/personen/luca] (similarity: 0.81)
Luca ist 9 Jahre alt, Tochter von Rene und Conny...

[memory/hans/familie-luca-podcast] (similarity: 0.74)
"Luca arbeitet an Episode 5 ihres Podcasts..."

[vault/Notizen/Familie-2026.md] (similarity: 0.51)
"...Familienurlaub Mai 2026 Italien..."
```

Damit der Agent (und du beim Lesen der Hits in Auto-Inject) sieht
ob die Info aus konsolidiertem Wiki, frischem Memory oder
ungefiltertem Vault-Material kommt.

### Auto-Inject — neuer Aufbau

Heute: nur Hits-Block.

**Neu:**

```
[memory-context]
== Wiki-Overview ==
(verkürzte Version von index.md — sub-headings + slug-Liste, ohne Beschreibungen)
Personen: rene, luca, conny, ...
Projekte: somora, ixopay, flugschule, ...
Wissen: ...

Letzte Updates: luca (heute), somora (gestern), ...

== Hits zur aktuellen Frage ==
[wiki/personen/luca] (sim 0.81)
...
[memory/hans/familie-luca-podcast] (sim 0.74)
...
[/memory-context]

eigentliche user-message hier
```

**Wiki-Overview ist immer dabei** — auch wenn keine Hits matchen.
Damit der Agent weiß welche Topics existieren und kann ggf. selber
ein `memory_get` / `wiki_get` machen wenn er was Spezifisches will.

**Größe der Wiki-Overview:** soll klein bleiben (~500-1500 chars)
damit Auto-Inject nicht den Cache sprengt. Wenn Wiki sehr groß wird,
listet Overview nur die N häufigst-referenzierten Slugs (Heuristik:
nach Anzahl Inbound-Wikilinks sortiert). Konkrete N-Schwelle TBD im
Bau.

---

## Konflikt-Strategie

**Single-writer-pro-File** ist die Hauptverteidigung. Edge-Cases:

### User editiert manuell im Wiki während Dream-B läuft

- Dream-B liest mtime einer wiki-page bevor er den Merge-Prompt
  losschickt
- Vor dem Write nochmal mtime check
- Wenn mtime sich seit Read geändert hat → ABORT mit Log-Eintrag
  „skipped <file>, user-edited during dream-B run, will retry next
  run"
- Im nächsten Run wird mit deinem aktualisierten Stand wieder
  probiert

### User editiert manuell im Memory (Stub-Bereich)

- Stubs sind primarily Pointer; manuelle Edits in `## Recent
  observations` sind valide Beiträge
- Dream-B respektiert sie wie agent-eigene Observations
- Manuelle Edits außerhalb der Observations-Section + ohne
  `promoted_to`-Frontmatter werden vom Worker gleichbehandelt mit
  Agent-Writes

### Zwei Agents widersprechen sich

- Hans's Stub-Observations-Section sagt „Luca ist 9"
- Lisa's Stub-Observations-Section sagt „Luca ist 8" (älterer Stand)
- Dream-B beim Merge: nimmt **recency-Sieger** (jüngeres Datum
  gewinnt) und vermerkt in `logs/`: „resolved conflict between hans
  (2026-05-08) and lisa (2026-04-02), kept hans"
- Bei gleichzeitigem Datum (sehr selten): Dream-B hält's offen, append
  beide Versionen mit Attribution, User soll manuell auflösen — als
  Lint-Finding markiert

### Wiki-Page schon gelöscht (User hat Page gelöscht)

- Dream-B will Stub mit Observations promoten, aber Wiki-Page
  existiert nicht mehr
- Worker entscheidet: Page wird neu angelegt aus Stub-Inhalt, mit
  Log-Eintrag „re-created <page>, was previously deleted"
- Wenn User die Page intentional gelöscht hat (nicht Wiki-würdig),
  muss er stattdessen den agent-memory-Stub auch löschen — sonst
  wird's beim nächsten Dream-B-Run wieder reanimiert

---

## Multi-Agent-Scaling (F5)

**Heute:** Dream-A per-Agent, idle-getriggered (60min). Bei 3 Agents
unproblematisch.

**Mit dem neuen Modell — bei N Agents:**

```
Dream-A-Trigger 1 (organisch):  per-Agent idle-Timer (status quo)
Dream-A-Trigger 2 (sweep):       Pre-Dream-B-Sweep, ~1h vor jedem
                                 Dream-B-Run, forciert Dream-A für alle
                                 Agents mit unprocessed Sessions
Dream-B-Trigger 1 (real-clock):  alle 12h (default, konfigurierbar)
Dream-B-Trigger 2 (manual):      Tool-Trigger
Dream-C-Trigger 1 (real-clock):  wöchentlich (default)
Dream-C-Trigger 2 (manual):      Tool-Trigger
```

**Approval-Flow bleibt per-Agent.** Du gehst zu Hans, fragst „was hast
du geträumt", siehst hans's Findings, approvest. Dann zu Lisa, etc.
Dream-B/C Findings gehen an EINEN designierten Approval-Agent
(Default: hans, konfigurierbar) damit's nicht in jedem Agent-Chat
auftaucht.

**Ressourcen-Annahmen:**

- Dream-A pro Agent: ~30s-2min mit gemma4big lokal
- Pre-Sweep bei 20 Agents: 10-40min
- Dream-B mit opus über alle Memories: ~5-15min
- Dream-C mit opus über alles Wiki: ~5-30min je nach Wiki-Größe

Bei 20 Agents pro 12h-Cycle: ~30min-1h Sweep+Dream-B-Time. Das ist
i.O. wenn nachts geplant.

---

## Migration / Bootstrap (F6)

**Einmaliger Bootstrap-Run** wenn das Wiki-System aktiviert wird:

1. User triggert via Tool: `wiki_bootstrap` oder ähnlich
2. Worker liest **alle existing memories aller Agents** + relevante
   Vault-Notizen die häufig in Sessions referenziert wurden
3. Identifiziert Topic-Cluster (Personen, Projekte, Konzepte)
4. Schlägt initial-Wiki-Pages vor — als Findings, mit Approval
5. User approved batch oder einzeln
6. Worker schreibt approved Pages ins Wiki
7. Markiert die zugehörigen agent-memory-Files als Stubs
8. Bootstrap-Done-Marker in Config schreiben damit's nicht zweimal
   läuft

**Was nicht gebootstrapped wird:**
- Vault-Notizen außerhalb der referenzierten — die gehören zu Rest-of-
  Vault (L4), nicht ins Wiki
- Sehr alte memories die seit 6+ Monaten nicht mehr referenziert
  wurden — vermutlich obsolet, User entscheidet manuell

**Approval-Bandbreite:** mit ~20-50 initial-Pages ist das ein
größerer Approval-Block. UX: Findings werden als Batch in der TUI
gezeigt, User kann „approve all" / „approve selected" / Einzeln
entscheiden.

---

## Config-Layout (F5)

### Server-global, in `config.yaml`

```yaml
wiki:
  enabled: true
  vault_subfolder: somora              # relativ zum agent's vault-pfad
                                        # (Vault selber kommt aus agent.yaml)

  # Welche Subfolder Dream-B per default nutzt — kann erweitern
  default_subdirs: [personen, projekte, wissen]

  promotion:                            # Dream-B
    enabled: true
    intervalHours: 12
    model: openrouter/anthropic/claude-opus-4-5
    pre_sweep_minutes: 60               # wie viel vor B-Run der Sweep
    require_approval: false

  lint:                                 # Dream-C
    enabled: true
    intervalDays: 7
    model: openrouter/anthropic/claude-opus-4-5
    require_approval: true
    approval_agent: hans                # wer kriegt die Lint-Findings

  search:
    boost_wiki: 1.0
    boost_memory: 0.85
    boost_vault: 0.65
    overview_max_chars: 1500            # Auto-Inject Wiki-Overview cap
    overview_top_n_slugs: 30
```

### Per-Agent in `agent.yaml` — minimal

```yaml
dream:
  enabled: true                         # session→memory still per-agent enabled
  model: gemma4big                      # Dream-A worker model
  idleMinutes: 60
  chunkTokens: 50000
  chunkTimeoutMs: 600000

  participate_in_wiki: true             # darf der agent ins Wiki promotet werden?
                                         # Default true, einzelne agents können
                                         # opt-out (z.B. test-agents)
```

**Vault-Pfad bleibt per-Agent** in `agent.yaml.obsidian.vault` — heißt
verschiedene Agents können verschiedene Vaults haben. Dann ist das Wiki
automatisch im jeweiligen Vault unter dem konfigurierten Subfolder.

In der Praxis ist's meist ein Vault für alle Agents → ein Wiki, alle
schreiben rein.

---

## Tool-Surface — Erweiterungen statt neuer Tools

**Entscheidung 2026-05-08 abend:** keine separaten `wiki_*`-Tools.
Wiki ist eine weitere Source im selben Datenmodell — die existierenden
`memory_*`-Tools können das alles abdecken sobald sie source-aware
werden. Tool-Count bleibt schlank, Mental-Model bleibt einfach.

**Erweiterungen (Stufe 2 implementiert):**

- `memory_search` → optionaler `source: "memory"|"wiki"|"vault"|"all"`
  Filter (default `"all"`)
- `memory_get` → akzeptiert `wiki/<pfad>`, `vault/<pfad>`, `memory/<slug>`
  als Reference-Form
- `memory_list` → optionaler `source`-Filter und `pathPrefix`-Filter
  (z.B. `personen/`)
- `memory_write` → Stub-Detection: bei `promoted_to`-Frontmatter
  appendet zu `## Recent observations` statt overwrite
- Auto-Inject erweitert um Wiki-Overview-Block (verkürzte index.md)

**Schreib-Tools für Agents bewusst NICHT**: Dream-B + Dream-C sind
die einzigen Writer ins Wiki (plus User manuell). Ein Agent will was
im Wiki ändern → memory_write ins eigene Memory → nächster Dream-B
promoted's.

**`obsidian_write/move/delete` Tools ENTFERNT (Stufe 2):** das waren
direkte Vault-Writes vom Agent — bricht die L3/L4-Layer-Invarianten
des neuen Modells. Komplett aus `registerAllTools()` raus, Code unter
`src/tools/obsidian/` gelöscht. Tool-Count: 36 → 33. `readObsidianConfigForAgent`
bleibt für die Read-Source erhalten.

**User-Tools (kommen in späteren Stufen):**

- `wiki_bootstrap` — Migration-Run trigger (Stufe 6)
- `dream_b_run_now` — manueller Dream-B-Trigger (Stufe 3)
- `dream_c_run_now` — manueller Dream-C-Trigger (Stufe 5)
- `wiki_status` — zeigt last-runs, queue, errors (Stufe 3+)

---

## Implementation-TODOs (offen — vor dem Bau zu finalisieren)

### Prompts

- [ ] **Dream-A System-Prompt-Erweiterung** — heute existiert er, muss
  um wiki-aware werden (Wiki als Read-Source, Konflikt-Format mit
  Wiki-Referenz)
- [ ] **Dream-B System-Prompt** — neu, von Grund auf zu schreiben.
  Soll: Topic-Cluster erkennen, Subfolder wählen, Wikilinks setzen,
  Frontmatter ausfüllen, mit existing pages mergen, log-Einträge
  formulieren, index.md regenerieren
- [ ] **Dream-C System-Prompt** — neu. Soll: Konflikte zwischen
  Pages erkennen, time-relative Behauptungen entdecken, Broken
  Links finden, Findings im dream_apply-Format formulieren

### Templates

- [ ] **Wiki-Page-Template** Frontmatter-Felder + Section-Struktur
  fix oder weich-konventionell?
- [ ] **index.md-Template** — exakte Struktur Dream-B respects
- [ ] **logs/YYYY-MM.md-Template** — exakte Struktur

### Tool-Implementierung

- [ ] `wiki_*`-Tools (search, get, list, index_get) — analog zu
  memory_*-Tools
- [ ] `wiki_bootstrap`-Tool — User-trigger, Approval-Loop
- [ ] `dream_b_run_now` / `dream_c_run_now` — manual triggers

### Engine-Anpassungen

- [ ] **memory_write Stub-Detection** — bei `promoted_to`-Frontmatter
  append zu `## Recent observations` statt overwrite
- [ ] **Auto-Inject Wiki-Overview-Block** — neuer Block oben in
  ephemeralContext, lädt verkürzte index.md
- [ ] **Search-Boost** für Wiki/Memory/Vault — multiplier auf
  similarity score
- [ ] **Source-Tag** im Hit-Output — Format `[wiki/path]`,
  `[memory/agent/slug]`, `[vault/path]`

### Worker-Implementierung

- [ ] **Dream-B-Worker** als neue Klasse, server-global. Real-Clock
  scheduling + manueller Trigger
- [ ] **Pre-Dream-B-Sweep-Logik** — Dream-A für unprocessed Agents
  forcieren
- [ ] **Dream-C / Lint-Worker** als neue Klasse, server-global.
  Wöchentlich-scheduling + manueller Trigger
- [ ] **mtime-Konflikt-Schutz** für Wiki-Writes
- [ ] **Conflict-Resolution-Strategien** (recency-winner, ties zu
  Lint queue, etc.)

### Config-Schema

- [ ] **`config.yaml.wiki.*`-Section** — Schema definieren, Validation
- [ ] **`agent.yaml.dream.participate_in_wiki`** als opt-out-Toggle

### Migration-Path

- [ ] **Bootstrap-Run-Logik** — Topic-Cluster-Identifikation in
  bestehenden Memories, initial-Page-Generierung, Approval-Batch-UX

---

## Was NICHT im Scope ist (deferred / wahrscheinlich Phase 5+)

- **External-Source-Ingest** (PDFs, URLs, Artikel ins Wiki ziehen) —
  Karpathy hat das, wir machen's später wenn der Bedarf kommt. Heute
  kannst du Files manuell in den Vault dropen, der File-Watcher
  indiziert sie + Dream-A picks sie als referenced_vault auf
- **Wiki-as-Site** (statische HTML-Generation aus dem Wiki) — kein
  Bedarf erkennbar, würde nur Komplexität bringen
- **Per-Agent-Sub-Wikis** (Hans hat sein eigenes Mini-Wiki innerhalb
  des großen Wikis) — wurde verworfen weil's den geteilten-Wissens-
  Vorteil aufweicht
- **Wiki-Page-Versioning** (git-history-style) — git auf dem Vault
  reicht externally; intern keine Versions-Logik
- **Auto-Inject-Off-Toggle pro Modell-Klasse** — wurde diskutiert als
  „Top-Tier-Modelle suchen selber besser", für jetzt deferred. Auto-
  Inject mit Wiki-Overview ist auch für Top-Tier-Modelle nicht störend

---

## Implementation-Reihenfolge (Vorschlag)

Das ist groß. Vorschlag wie wir's chunk-weise bauen damit jeder Chunk
verifizierbar ist:

**Stufe 1 — Foundation (vor allem anderen):**
- Config-Schema (`wiki.*`)
- Wiki-Page-Template + Frontmatter
- mtime-Konflikt-Helper
- Search-Boost-Multiplier + Source-Tag im Hit

**Stufe 2 — Read-Side für Agents (DONE 2026-05-08 abend):**
- `memory_search` mit optionalem `source`-Filter
- `memory_get` akzeptiert `wiki/<pfad>` und `vault/<pfad>` als Reference
- `memory_list` mit `source` + `pathPrefix` Filter
- `memory_write` mit Stub-Detection (append zu `## Recent observations`)
- Auto-Inject erweitert um Wiki-Overview-Block (verkürzte index.md)
- `obsidian_write/move/delete` Tools entfernt (siehe Tool-Surface-Sektion)

Stufe 1+2 erlauben Agents schon manuell ein Wiki zu lesen — bevor
Dream-B existiert. Du kannst Wiki-Pages selber im Vault anlegen
und testen ob die Search-Pipeline + Auto-Inject sich richtig anfühlt.

**Stufe 3 — Dream-B:**
- Worker-Klasse, Scheduler, Pre-Sweep
- Promotion-Logik + Stub-Erstellung
- index.md + logs/ Pflege
- Konfliktbehandlung

**Stufe 4 — Dream-A wiki-aware:**
- Read-Scope-Erweiterung um Wiki
- Prompt-Anpassung für Konflikt-Format mit Wiki-Referenz

**Stufe 5 — Dream-C / Lint:**
- Worker, Scheduler
- Lint-Findings-Format
- Approval-Pfad

**Stufe 6 — Bootstrap:**
- Migration-Tool für initial Wiki-Aufbau aus existing Memories

Pro Stufe ein eigener Phase-4-Sub-Commit, jeder smoke-getestet bevor
der nächste kommt. Insgesamt schätze ich 5-8 Bau-Tage, je nach
wieviel an Prompt-Tuning + Smoke-Iteration nötig ist.

---

## Pickup-Notiz

Wenn wir bauen: dieses Doc ist Single Source of Truth. Bei Konflikt
mit Code → Code anpassen, nicht Doc. Bei Konflikt mit User-Wunsch
→ User-Wunsch gewinnt, Doc anpassen.

Vor dem Bau-Start: Implementation-TODOs durchgehen, alle [ ] in
konkrete Entscheidungen verwandeln. Insbesondere die Prompts —
das ist wo die meiste Iteration nötig sein wird.
