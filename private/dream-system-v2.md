# Dream-System v2 — Architektur-Redesign

**Status:** Design-Doc, Stand 2026-05-09. Substituiert die in `wiki-design.md` 
festgehaltene Dream-A/B/C-Mechanik. Implementation noch nicht begonnen — 
phasenweise Migration nach diesem Doc.

**Trigger der Überarbeitung:** Konversation 2026-05-09 nach realem Betrieb 
(naxon-Migration, Dream-B mit 117 Kandidaten, Dream-C mit 152 noisy 
findings). Drei Erkenntnisse haben das Redesign motiviert:

1. **Stub-Pattern ist ein Friedhof.** Memory-Files werden nach Promotion 
   zu hohlen Pointern → Dream-A's Dedup-Check funktioniert nicht mehr 
   weil das Memory leer ist. Konzept war von Karpathy's single-agent-Wiki 
   übernommen wo Memory komplett wegfällt; in unserer Multi-Agent-
   Erweiterung wurde der Stub als Brücke gehalten — leistet aber nichts.

2. **Dream-B's Multi-Gate-Logic ist zu kompliziert.** Heute trifft Code 
   (`classifyCandidate`) Routing-Entscheidungen vor dem LLM, dann gibt's 
   separate System-Prompts für Promote vs. Merge, plus `queued_merge` 
   Approval-Loop bei Slug-Collisions. Vertrauen an Opus delegieren würde 
   das massiv vereinfachen.

3. **Dream-C deterministisch produziert reines Rauschen.** Auf 67 Pages 
   152 Findings, davon 112 one_way_link (User: „würd ich pauschal 
   dismissen"), 30 broken_wikilink (semantisch ambivalent), Rest Index-
   Hygiene. Signal-zu-Rausch katastrophal. Ein Opus-Run mit vollem Wiki-
   Kontext liefert qualitativ andere Befunde.

---

## Mental Model

```
KURZZEITGEDÄCHTNIS                       LANGZEITGEDÄCHTNIS
~/.somora/agents/<agent>/memory/         /mnt/naxon/obsidian/<wiki-subfolder>/

"Inbox" / "Notizzettel"                  "Konsolidierte Wahrheit"
volatile, files leben kurz               kanonisch, persistent, geteilt
nur was noch NICHT konsolidiert ist      single source of truth

         │                                          ▲
         │ memory_write                             │
         │ (agent direkt oder via REM)              │ Deep
         │                                          │ (Memory → Wiki)
         ▼                                          │
   [memory/foo.md]  ──── Deep konsolidiert ─────────┘
                         und LÖSCHT memory/foo.md

                   Lucid läuft nur über Wiki:
                   Widersprüche, Stale Claims, Cleanup
```

**Invariante:** Ein Faktum lebt entweder im Memory (noch nicht prozessiert) 
ODER im Wiki (konsolidiert) — niemals in beiden gleichzeitig. Ausnahme: 
Skip-Memories die bewusst nicht promotet wurden (siehe Hash-Cache).

---

## Die drei Phasen — REM / Deep / Lucid

### Phase REM (formerly Dream-A)

**Job:** Session → Memory. Pro Agent. Liest unverarbeitete Session-Range, 
schaut in Memory + Wiki was schon bekannt ist, extrahiert neue Findings 
als Memory-Write/Edit-Vorschläge mit Approval.

| Eigenschaft | Wert |
|---|---|
| Scope | Pro Agent (private Memory) |
| Auslöser | manuell `/reset` oder idle-Timeout |
| Frequenz | ~30 min (heute: 60, zu konservativ) |
| Worker-Model | gemma4big lokal (config-overridable auf opus) |
| Approval | erforderlich (dream_apply / dream_dismiss) |
| Output | Findings → Memory-Files (Write/Edit/Delete-Vorschläge) |

**Wichtige Eigenschaft die heute fehlt:** REM muss VOR der Extraktion 
sowohl Memory-Files als auch relevante Wiki-Pages laden, um zu dedupen.

Heute lädt der Worker nur:
- stub-pointer-derived Wiki-Pages (3 von 67 bei hans-Run)
- recall-derived Wiki-Pages aus Session-Embeddings

Zukünftig:
- `wiki/index.md` als Topology-Header (immer, kompakt)
- Top-N Wiki-Pages via Embedding-Search auf Session-Content
- Plus: für jeden in Session erwähnten Wiki-Slug die volle Page

So sieht REM tatsächlich was schon im Langzeitgedächtnis konsolidiert 
ist. Der heutige Bug („gemma returnt [] weil sie alles schon im Memory-
Index sieht") wird behoben weil das Memory bei Pfad-4 eh leer ist und 
das Wiki vollständig sichtbar wird.

**System-Prompt-Anpassung:** Die Anti-Duplikations-Regel wird klarer: 
„extrahiere nur was im Wiki noch NICHT steht". Wiki ist canonical, Memory 
ist nur Inbox — REM weiß das jetzt explizit.

### Phase Deep (formerly Dream-B)

**Job:** Memory aller Agents → Wiki. Plattform-weit. Konsolidiert Memory-
Files ins shared Wiki, löscht Memory-Files nach erfolgreicher Konsolidierung.

| Eigenschaft | Wert |
|---|---|
| Scope | Plattform-weit (alle Agents) |
| Auslöser | Schedule (~12h) oder manuell `dream_run({phase:'deep'})` |
| Frequenz | 1-2× pro Tag |
| Worker-Model | opus via claude-cli (subscription) |
| Approval | nicht erforderlich (auto-apply) |
| Output | Wiki-Page-Writes/Updates + Memory-File-Deletes |

**Vereinfachte Logic — Single-Prompt statt Multi-Gate:**

Heute existieren zwei separate System-Prompts (`PROMOTE_SYSTEM_PROMPT`, 
`MERGE_SYSTEM_PROMPT`) und davor `classifyCandidate` als Code-Routing. 
Plus `queued_merge` Outcome bei Slug-Collisions die manual approval 
braucht. Plus `wiki_promote: false` Skip-Marker. Plus Stub-Pattern.

Neuer Single-Prompt:
```
Du bist Deep, der Wiki-Konsolidierer von somora. Hier ist eine Memory-
Notiz von Agent <agent>:

<memory-content>

Hier ist die existierende Wiki-Topologie:
<wiki/index.md>

Hier sind relevante Wiki-Pages (basierend auf Topic-Embedding-Match):
<top-N-page-bodies>

Aufgabe: entscheide was mit dieser Memory-Notiz passieren soll.

Optionen:
1. SKIP — wenn transient, irrelevant, oder schon vollständig im Wiki.
   Begründung erforderlich.
   
2. PROMOTE — neues Wiki-Topic. Subfolder-Wahl, Slug, Page-Body, 
   Cross-Refs. Du darfst neue Subfolder erfinden wenn sinnvoll.
   
3. MERGE — Topic existiert schon im Wiki. Welche Page (slug), welcher 
   Body-Update integriert die neue Information.

Output: ein JSON-Object mit der Entscheidung.
```

Opus entscheidet alles in einem Schritt. Kein Code-Routing davor, kein 
queued_merge-Limbo, kein Stub-Pattern.

**Lifecycle nach Deep-Action:**

| Outcome | Memory-File-Aktion |
|---|---|
| PROMOTE (Wiki-Page geschrieben) | LÖSCHEN |
| MERGE (Wiki-Page aktualisiert) | LÖSCHEN |
| SKIP (transient/duplicate) | UNVERÄNDERT lassen |

**Skip-Hash-Cache:**

Skipped Memory-Files bleiben im Memory-Dir. Damit Deep sie nicht jedes 
Mal erneut LLM-bewertet:

`~/.somora/agents/<agent>/memory/.deep-skip-cache.json`:
```json
{
  "<slug>": {
    "hash": "<sha256:16>",
    "skipped_at": "2026-05-09T...",
    "reason": "..."
  }
}
```

Beim nächsten Deep-Lauf:
- Memory-File hash unverändert + im Cache + outcome=skip → durchwinken ohne LLM-Call
- Memory-File hash geändert (User hat ergänzt) → re-evaluieren mit Opus
- Memory-File neu (kein Cache-Eintrag) → evaluieren

So bleiben transient-skipped Memories billig im laufenden Betrieb.

### Phase Lucid (formerly Dream-C)

**Job:** Wiki-Wartung. Plattform-weit. Findet Widersprüche, stale 
time-relative claims, schlägt Splits/Merges/Refactorings vor. **Komplett 
LLM-driven**, keine deterministischen Checks mehr.

| Eigenschaft | Wert |
|---|---|
| Scope | Plattform-weit (gesamtes Wiki) |
| Auslöser | Schedule (~wöchentlich) oder manuell `dream_run({phase:'lucid'})` |
| Frequenz | 1× pro Woche |
| Worker-Model | opus |
| Approval | erforderlich (dream_apply / dream_dismiss) |
| Output | Findings → Wiki-Edit-Vorschläge |

**Cluster-Strategie für Skalierung:**

Bei aktuellen 67 Pages und ~500-800 KB Total-Wiki passt alles in einen 
Opus-Window-Call. Aber wir designen für Wachstum:

| Wiki-Größe | Strategie |
|---|---|
| 1-300 Pages | **Single-Pass.** Gesamtes Wiki in einem Opus-Call. Findet alle Probleme global. |
| 300-1500 Pages | **Subfolder-Pass.** Pro Subfolder (`personen/`, `projekte/`, ...) ein Cleanup-Run. Plus ein Cross-Subfolder-Pass mit nur den Page-Headers + Cross-Refs als Input — fängt Subfolder-übergreifende Widersprüche. |
| >1500 Pages | **Hierarchisch.** Innerhalb jedes Subfolders Topic-Embedding-Cluster. Drei Stufen: in-cluster, cross-cluster-within-subfolder, cross-subfolder. Erst implementieren wenn nötig. |

Trigger für Stufenwechsel: token-budget. Wenn ein zusammengefasster 
Cluster > 150k chars wäre → split.

**Was Lucid SUCHT (LLM-Prompt):**
- **Widersprüche zwischen Pages**: zwei Pages die divergente Fakten zum 
  gleichen Subjekt enthalten → Update-Vorschlag
- **Stale time-relative claims**: „nächsten Monat", „dieses Jahr", 
  „aktuell" prüfen ob noch valid (bei stale: Update oder Anonymisieren)
- **Page-Splits**: zu große Multi-Subject-Pages → Split-Vorschlag mit 
  Cross-Refs
- **Tote Cross-Refs context-aware auflösen**: `[[personen/rene]]` 
  existiert nicht — Opus entscheidet zwischen Redirect, neue Page, 
  Link entfernen basierend auf Kontext
- **Veraltete Information markieren**: alte Notizen die durch neue 
  Pages obsolet werden
- **Wanted-Pages identifizieren**: Topics die häufig referenziert 
  werden aber keine Page haben (≥3 Refs + recent activity → Vorschlag 
  „Page erstellen, Substanz aus folgenden Memory-Files")

**Was Lucid NICHT mehr macht** (im Vergleich zu heute):
- ❌ broken_wikilink ohne Kontext-Bewertung
- ❌ orphan_page automatisch-flag
- ❌ index_missing / index_stale (Deep regeneriert Index nach jedem Lauf, 
  das sollte nie pending werden)
- ❌ one_way_link

**Findings-Output:**
Strukturierte Liste, jedes Finding mit:
- Kind (contradiction / stale / split / dead-ref / outdated / wanted-page)
- Affected pages
- Konkreter Fix-Vorschlag (Diff-artig oder als Page-Spec)
- Confidence (Opus's Eigeneinschätzung)

User reviewt mit dream_apply / dream_dismiss wie heute.

---

## Lifecycle-Vertrag

### Memory-File-Lifecycle

```
ENTSTEHT durch:
- agent's memory_write Tool-Call (während Session)
- REM-Phase Approval (Dream-A nach /reset)

LEBT WÄHREND:
- noch nicht von Deep evaluiert
- ODER von Deep mit SKIP-Outcome bewertet (Hash-Cache aktiv)

WIRD GELÖSCHT durch:
- Deep PROMOTE (erfolgreich Wiki-Page geschrieben)
- Deep MERGE (erfolgreich Wiki-Page aktualisiert)
- Agent's memory_delete Tool-Call (manueller Eingriff)
```

### Wiki-Page-Lifecycle

```
ENTSTEHT durch:
- Deep PROMOTE
- (Bootstrap: einmalige Migration aus Memory beim Phase-4-Rollout)

LEBT WÄHREND:
- aktive Konsolidierung (Deep merged neue Memory-Inhalte rein)
- ODER stable (keine neuen Memories zum Topic)

WIRD MODIFIZIERT durch:
- Deep MERGE (neue Inhalte einkonsolidiert)
- Lucid Approval (Widerspruchs-Fix, Update, Cleanup)
- User manuell in Obsidian (legitim, Watcher reindexiert)

WIRD GELÖSCHT durch:
- Lucid „outdated"-Finding mit Approval
- User manuell in Obsidian (legitim)
- Lucid „split"-Vorschlag mit Approval (alte Page wird durch mehrere neue ersetzt)
```

### Skip-Cache-Lifecycle

```
ENTSTEHT durch:
- Deep SKIP-Outcome auf einem Memory-File

LEBT WÄHREND:
- Memory-File-Hash unverändert

WIRD INVALIDIERT durch:
- Memory-File-Hash ändert sich (User hat ergänzt)
- Memory-File wird gelöscht (Cache-Entry kann mit aufgeräumt werden)
- Manuell via `dream_run({phase:'deep', force:true})` (alle Skip-Caches ignorieren)
```

---

## Migration aus heutigem Stand

### Ist-Stand der Codebasis

| Bereich | Datei | Heutiger Zweck |
|---|---|---|
| Dream-A Runner | `src/dream/runner.ts` | Session→Memory mit gemma |
| Dream-A Auto-Worker | `src/dream/auto-worker.ts` | Idle-Timer + Pre-Sweep |
| Wiki-Context | `src/dream/wiki-context.ts` | Stub-pointer + recall Wiki-loading |
| Dream-B Runner | `src/wiki/dream-b-runner.ts` | Memory→Wiki Orchestrator |
| Dream-B Prompts | `src/wiki/dream-b-prompts.ts` | PROMOTE + MERGE separate prompts |
| Dream-B Actions | `src/wiki/dream-b-actions.ts` | applyPromote (Stub-konvertieren), applyMerge |
| Dream-B Worker | `src/wiki/auto-worker.ts` | Schedule-Worker |
| Dream-C Runner | `src/wiki/lint-runner.ts` | Deterministische Lint-Checks |
| Dream-C Detectors | `src/wiki/lint-detector.ts` | broken_wikilink/orphan/index/one_way |
| Dream-C Actions | `src/wiki/lint-actions.ts` | Auto-Fix pro Finding-Kind |
| Templates | `src/wiki/templates.ts` | Stub-Build + parse |
| Tools | `src/tools/dream/tools.ts` | dream_run/list/get/apply/dismiss |

### Phasenweise Migration

**Stufe v2.1 — Naming + Tool-Surface (klein, low-risk)**
- `dream_run({mode:'a'\|'b'\|'c'})` → `dream_run({phase:'rem'\|'deep'\|'lucid'})`
- Backward-compat: `mode` als Alias akzeptieren mit deprecation-warning
- Doku in `docs/dream-mode.md` umbenennen + verweisen
- Tool-Descriptions anpassen
- ~1h Aufwand, keine konzeptionelle Änderung

**Stufe v2.2 — Stub-Pattern abschaffen, Memory-File-Delete (mittel)**
- `applyPromote`: writeStub → unlink Memory-File
- `applyMerge`: clearObservations → unlink Memory-File
- `classifyCandidate`: vereinfachen, Stub-Detection raus
- `templates.ts`: isStub/parseStub/buildStub deprecaten (für Bootstrap-
  Migration noch lesbar halten, aber nicht mehr schreibend verwenden)
- Bestehende Stubs bei erstem Deep-Run nach Upgrade: als Memory-Files 
  behandeln, mit Recent-observations als Body. Outcome: meist re-merge 
  in existierende Wiki-Page, dann Memory-File weg.
- ~3h Aufwand, höhere Komplexität

**Stufe v2.3 — Single-Prompt-Logic in Deep (mittel)**
- `PROMOTE_SYSTEM_PROMPT` + `MERGE_SYSTEM_PROMPT` → ein gemeinsamer 
  `DEEP_SYSTEM_PROMPT` mit drei Optionen (skip/promote/merge)
- `dream-b-dispatcher.ts`: callOneShotLLM mit neuem Prompt + erweitertem 
  Context (wiki-summary + relevant-page-bodies)
- `processCandidate`: Routing-Code raus, alles via LLM-Output
- `queued_merge` Outcome verschwindet — Slug-Collisions sind jetzt 
  immer auto-merge via LLM
- ~4h Aufwand

**Stufe v2.4 — Hash-Cache für Skips (klein)**
- `.deep-skip-cache.json` pro Agent
- Deep-Runner: vor LLM-Call Cache-Check, nach LLM-Call ggf. Cache-Update
- ~1.5h Aufwand

**Stufe v2.5 — REM Wiki-Awareness (mittel)**
- `wiki-context.ts` erweitern: index.md als default, Top-N Embedding-
  Match-Pages, plus alle in Session erwähnten Slugs
- System-Prompt klarstellen: „Wiki ist canonical, dedupe gegen Wiki, 
  nicht gegen Memory"
- ~2h Aufwand

**Stufe v2.6 — Lucid LLM-driven (groß)**
- `lint-runner.ts` und `lint-detector.ts` beide ausmustern
- Neuer `lucid-runner.ts` der Wiki-Pages an Opus übergibt mit dem 
  Cleanup-Prompt
- Cluster-Strategie initial: Single-Pass für <300 Pages
- Findings-Schema neu: contradiction/stale/split/dead-ref/outdated/wanted-page
- `lint-actions.ts` ersetzt durch `lucid-actions.ts` mit LLM-output-
  driven Apply-Pfaden
- Approval-Loop bleibt strukturell wie heute
- ~6h Aufwand

**Stufe v2.7 — Cluster-Awareness aktivieren (deferred)**
- Erst bei >300 Wiki-Pages relevant
- Subfolder-Pass + Cross-Subfolder-Pass implementieren
- Token-Budget-Watcher
- Im FUTURE-Backlog notieren, jetzt nicht implementieren

**Reihenfolge / Empfehlung:**
1. v2.1 (Naming) zuerst — niedriges Risiko, sofortige UX-Verbesserung
2. v2.2 (Stub-Abschaffung) als nächstes — entkernt das größte Konzept-
   Problem
3. v2.3 (Single-Prompt Deep) und v2.4 (Hash-Cache) zusammen
4. v2.5 (REM Wiki-Awareness) parallel oder danach — REM kommt heute eh 
   selten an die Schmerzgrenze, aber konzeptionell wichtig
5. v2.6 (Lucid LLM-driven) als letztes — größter Brocken, schließt das 
   Redesign ab

Total Aufwand grob geschätzt: 17-20h Implementierung + Testing + 
Migration verifying. Verteilt auf 3-5 Sessions möglich.

---

## Risiken / Bekannte Trade-offs

**Risiko 1 — Memory-File-Verlust bei Deep-Bug**
Wenn ein Bug in Deep dazu führt dass das Memory-File gelöscht wird OHNE 
dass die Wiki-Page erfolgreich geschrieben wurde, ist Information weg. 
Mitigation: zwei-Phasen-Commit. Erst Wiki-Write committen, dann Memory-
File löschen. Bei Wiki-Write-Failure bleibt Memory-File. Heute hat 
Dream-B schon mtime-aware optimistic concurrency — den Pattern weiter-
verwenden.

**Risiko 2 — Token-Kosten Deep**
Single-Prompt-Deep mit größerem Wiki-Kontext (index.md + relevant-pages) 
erhöht Tokens pro Call. Bei aktuell ~67 Pages, ~10-20k Token Context 
pro Call. Wenn Wiki auf 500 Pages wächst und wir naiv den vollen Index 
plus Top-10 Pages laden: ~50-80k pro Call × 100 Memories ≈ 5-8M Tokens 
pro Run. Bei Opus über Subscription verkraftbar, bei API-Mode teurer.
Mitigation: smarter Context-Selection (nur N relevanteste Pages), und 
Skip-Cache reduziert die Anzahl der LLM-Calls drastisch.

**Risiko 3 — Lucid-False-Positives**
LLM-Findings sind nicht deterministisch. Opus könnte „Widersprüche" 
melden die keine sind. Mitigation: Approval-Loop bleibt — User filtert. 
Plus: Confidence-Field im Output, low-confidence-Findings können in der 
TUI farblich markiert werden.

**Risiko 4 — Migration-Phase-Inkonsistenz**
Während Stufe v2.2 (Stub-Abschaffung) gibt's eine Mischphase wo bestehende 
Stubs koexistieren mit neuen Memory-Files. Mitigation: Stub-Detection im 
Deep-Runner bleibt für 1-2 Releases lesend kompatibel; bei jedem Stub-
Encounter wird's behandelt wie ein normales Memory-File mit dem 
Recent-observations-Body als Inhalt. Nach erfolgreicher Verarbeitung 
verschwindet auch der Stub. Innerhalb weniger Deep-Runs ist alles 
konvertiert.

**Risiko 5 — Approval-Backlog**
REM und Lucid haben Approval-Loops. Bei häufigerem REM-Run (30 min) 
können Findings akkumulieren. User muss aktiv durchklicken. Mitigation: 
TUI-Notification wenn Pending-Findings > N; Auto-Dismiss für Findings 
die zu alt geworden sind ohne Action.

---

## Was nach diesem Redesign weiter offen bleibt

- **Wiki-Refactor-Worker** (eigene Phase „Refactor" oder als Lucid-
  Erweiterung): Page-Splits bei Multi-Subject-Wachstum, Topic-Renames 
  bei Subfolder-Reorg. Ist heute im Backlog (FUTURE.md), Lucid kann 
  das teilweise abdecken via Split-Findings.
- **Cross-Refs Wiki → Vault-außerhalb-Wiki**: heute bewusst nicht 
  unterstützt. Bleibt im Backlog.
- **Bootstrap-Compaction**: einmaliger Lauf der ältere Daily-Logs aus 
  openclaw-Migration zu monatlichen Summaries komprimiert, bevor Deep 
  sie evaluiert. Kann nach v2.6 als optionales Tool gebaut werden.
- **REM Auto-Apply für High-Confidence-Findings**: heute bei jedem 
  Finding Approval. Möglicher künftiger Modus: Findings mit confidence 
  ≥ 0.9 werden auto-applied, nur lower-confidence kommen in die 
  Approval-Queue. Aufschiebbar.

---

## Bezug zu existierenden Memories und FUTURE-Items

- `feedback_no_design_deviation.md`: Design-Doc ist verbindlich. Dieser 
  Doc ist die neue Quelle, ersetzt diesbezügliche Teile von 
  `wiki-design.md`.
- `feedback_no_phase_jumping.md`: Migration in den Stufen v2.1 → v2.6 
  abgearbeitet, nicht parallel. Jede Stufe wird verifiziert bevor 
  nächste anfängt.
- `feedback_research_before_build.md`: Vor v2.6 (Lucid-LLM-Redesign) 
  noch eine Recherche-Runde, was anderen Multi-Agent-Wiki-Systemen 
  ihre Cleanup-Mechanik macht (z.B. Mem.AI, Personal AI). 30-Min-
  Schmöker-Sweep.
- FUTURE.md `Bootstrap-Compaction`: bleibt relevant, kommt nach v2.6.
- FUTURE.md `Optional IDENTITY.md-Slot`: orthogonal zu diesem Redesign, 
  unabhängig.
- FUTURE.md `Cross-Refs Wiki → Vault-außenrum`: orthogonal, bleibt.
- FUTURE.md `transitive Wikilink-Expansion`: orthogonal, bleibt.

---

## Nächste Schritte

1. **User-Review dieses Docs** — Konzept-OK, dann erst Code.
2. **Eintrag in DECISIONS.md**: „v2-Redesign Dream-System: REM/Deep/Lucid, 
   Stub-Abschaffung, LLM-driven Lucid" als formaler Decision-Marker.
3. **Stufe v2.1 (Naming) implementieren** — schnell, niedriges Risiko, 
   sofort spürbar.
4. **Stufenweise weiter** entlang der Migration-Reihenfolge.
