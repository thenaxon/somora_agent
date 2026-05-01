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

## Phase 3+ — Voice / Realtime, Telegram-Channel, andere Frontends

Steht im STATUS noch als „Phase 3". Kein neues Konzept hier, nur Notiz
dass diese Themen explizit hinter den oben genannten anstehen.
