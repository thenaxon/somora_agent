# Tool architecture — comparative research

Vergleichsstudie zweier State-of-the-Art Agent-Frameworks (OpenClaw,
nousresearch/hermes-agent) als Grundlage für somoras eigene Tool-Schicht.
Stand 2026-05-03, vor Tool-Listen-Festlegung.

Quellen: direkter Repo-Lesegang in beiden Codebases — alle hier zitierten
Code-Snippets sind verbatim, mit Datei-Pfaden im Anhang.

---

## TL;DR

- Beide Projekte konvergieren auf **dieselben Patterns**, obwohl sie
  unterschiedliche Sprachen und Domänen haben. Heißt: das ist
  state-of-the-art Konsens, nicht Stilfrage.
- **Granularität:** beide sind **innerhalb der Schemas granular** (12
  Params bei `exec`, 9 bei `read_file`) und **über die Tool-Surface
  coarse** (~30 Tools insgesamt). Aktion-als-Param-Enum schlägt
  Tool-Fan-out (8 separate Process-Tools).
- **File-Ops sind 4-fach** (`read` / `write` / `patch` / `search`). Bei
  beiden. Kein „eines reicht".
- **Exec ist 1 oder 2 Tools** mit reichem Schema, nicht 10. Bei OpenClaw
  zusätzlich ein `process` Dispatcher mit `action`-Enum für laufende
  Prozesse.
- **Web ist 2 Tools** (`search`, `fetch/extract`). Provider werden
  intern gewählt, nie vom Modell.
- **Skills ≠ Tools** ist eine bewusste Trennung. Skills sind Markdown
  mit Frontmatter, kein Code. Sie injecten Anleitung in den Prompt;
  Tools sind getypte Funktionen. OpenClaw hat 60+ Skills + ~30 Tools,
  Hermes hat eigene `skills_list`/`skill_view` Tools die SKILL.md
  Bundles laden.
- **Sandbox ist mehrschichtig**, nie nur Regex: Pfad-Whitelist, SSRF,
  Prompt-Injection-Wrapper für externen Inhalt, Approval-Flow,
  Selbstschutz-Patterns. Beide setzen 4–6 Schichten übereinander.
- **Ein Tool-Result-Envelope-Standard fehlt** in beiden: OpenClaw nutzt
  MCP-Style `{ content[], details, isError? }`, Hermes nutzt Plain-JSON
  mit `{ "error": "..." }` als Konvention. Kein `{ ok, data, error }`.

---

## 1. Tool-Definition

### OpenClaw (TypeScript)

Descriptor-zentrisch. `name + JSON Schema + owner-ref + executor-ref +
availability-expression`. Vier Owner-Typen: `core | plugin | channel |
mcp` — alle laufen durch denselben Planner.

```ts
export type ToolDescriptor = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly owner: ToolOwnerRef;
  readonly executor?: ToolExecutorRef;
  readonly availability?: ToolAvailabilityExpression;
  // ...
};
```

Static-Catalog (`/src/agents/tool-catalog.ts`) listet alle Core-Tools
mit Section-Tag (`fs`, `runtime`, `web`, `memory`, `sessions`, ...) —
treibt Profile (`tools.profile: "minimal"|"coding"|"full"`) und die UI.

### Hermes (Python)

Free-Function + Singleton-Registry. `register(name, toolset, schema,
handler, check_fn, requires_env, is_async, max_result_size_chars, ...)`
am Module-Ende, AST-Scan beim Startup discovert alle Module die
top-level `registry.register(...)` aufrufen.

```python
def register(self, name, toolset, schema, handler,
             check_fn=None, requires_env=None, is_async=False,
             description="", emoji="", max_result_size_chars=None):
```

`toolset` ist die Disable/Enable-Einheit (analog zu OpenClaws section).
`check_fn` (TTL 30s gecacht) ist die runtime-availability-Probe.

### Konvergenz

Beide haben:

| Konzept | OpenClaw | Hermes |
|---|---|---|
| Tool ID | `name` | `name` |
| Schema | JSON Schema (TypeBox-generated) | JSON Schema (handgeschrieben) |
| Gruppierung | `section` (fs/runtime/web/...) | `toolset` (file/terminal/web/...) |
| Verfügbarkeit | declarative `availability` expression | imperative `check_fn` mit TTL-Cache |
| Result-Cap | per-tool im Output | per-tool `max_result_size_chars` |
| Ownership | `core | plugin | channel | mcp` | built-in / plugin / mcp |
| Discovery | Static catalog + plugin registration + MCP | AST-Scan + plugin registration + MCP |

**Für somora:** Wir haben heute schon eine Registry pattern (`src/tools/`).
Das aktuelle `ToolRegistry` ist näher an Hermes' Stil (`name`, `schema`,
`handler` direkt im Tool-Modul). Funktioniert. Was wir lernen können:

1. **Section/toolset-Tag** an jedes Tool anhängen — `memory`, `dream`,
   `file`, `web`, `exec`, `obsidian` — als Basis für späteren
   Profile/Allow-List-Mechanismus
2. **`check_fn`** für runtime-availability. Beispiel: `web_search`
   verfügbar nur wenn `BRAVE_API_KEY` gesetzt; `obsidian_*` verfügbar
   nur wenn `agent.obsidian.vault` konfiguriert
3. **`max_result_size_chars`** im Tool-Descriptor — beide Projekte
   nutzen 100k chars (~25-35k tokens) als Default. Somora hat das nicht.

---

## 2. Granularität — drei konkrete Tool-Familien

### 2.1 File-Ops

**Beide splitten 4-fach.** Bewusst, dokumentiert: man WILL die
unterschiedlichen Operationen unterscheiden weil sie unterschiedliche
Approval-, Stale-Detection- und Recovery-Semantik haben.

| Tool | OpenClaw | Hermes |
|---|---|---|
| Read | `read` (adaptive paging, 32–128 KB context-share) | `read_file` (offset/limit, LINE_NUM\|CONTENT format) |
| Write | `write` (workspace-guard, recovery wrapper) | `write_file` (sensitive-path-guard, refuses status-text) |
| Edit/Patch | `edit` + `apply_patch` (codex *** Begin Patch ***) | `patch` mit mode `replace`\|`patch` (V4A multi-file) |
| Search | (keiner — geht über `exec`) | `search_files` (ripgrep-backed, content/files modes) |

OpenClaw delegiert `read/write/edit` an `@mariozechner/pi-coding-agent`
und wrappt mit Workspace-Guards + Recovery (re-read auf edit-failure,
detect "did edit apply despite throw"). Hermes implementiert selbst
mit Per-Task-Read-Tracker (verhindert Re-Read-Loops, detected externe
Edits zwischen Read und Write).

**Hermes'sche Innovation, die OpenClaw nicht hat:**
- **Read-Loop-Detection** — wenn das Modell dasselbe File 3× hintereinander liest, kommt
  „BLOCKED: file unchanged since last read, refer to earlier read_file result"
- **External-Edit-Detection** — `_check_file_staleness()` warnt wenn
  ein File zwischen Read und Patch von außen geändert wurde
- **Anti-Self-Echo** — `write_file` weigert sich Inhalt zu schreiben
  der wie eine vorherige `read_file`-Status-Message aussieht (häufiger
  Modell-Fehlermodus: copy-and-write des eigenen Tool-Outputs)

**OpenClaw'sche Innovation, die Hermes nicht so hat:**
- **Adaptive Paging via Context-Window** — `read` reserviert max 10%
  des aktiven Modell-Windows pro Page, clamped 32–128 KB. Ehrlicher
  als feste Bytes-Cap.

### 2.2 Exec / Terminal

**Beide: 1-2 Tools mit fettem Schema, nicht Tool-Fan-out.**

OpenClaw `exec` — 12 Params:

```ts
{
  command, workdir?, env?,
  yieldMs?, background?, timeout?,
  pty?, elevated?,
  host: 'auto'|'sandbox'|'gateway'|'node',
  security?, ask?, node?,
}
```

Plus separater `process` als **Dispatcher mit `action`-Enum** (8 Aktionen
für laufende Background-Prozesse: `list`, `poll`, `log`, `write`,
`send-keys`, `submit`, `paste`, `kill`). Bewusste Granularitäts-Wahl:
Schema-Discriminator statt 8 separate Tools.

Hermes `terminal` — 6 Params:

```python
{
  command, background, timeout, workdir, pty,
  notify_on_complete, watch_patterns
}
```

Backend (local/docker/ssh/modal/daytona/sandbox) ist **Session-Level
Config**, nicht Tool-Argument. Modell wählt nie das Backend.

**Killer-Pattern bei Hermes:** `notify_on_complete` + `watch_patterns`.
Hintergrund-Job läuft, Modell macht weiter, kriegt **eine** Notification
wenn fertig. `watch_patterns` mit Hard-Rate-Limit von 1 Match/15s + 3-Strike
Auto-Promotion zu `notify_on_complete`. Self-correcting API design.

**Was somora davon adaptieren sollte (wenn wir exec bauen):**
1. Ein Tool, reiches Schema. Nicht 10 separate.
2. Backend Session-Level: per-Agent in `agent.yaml` (z.B. `exec.backend:
   docker | local | none`). Modell entscheidet nie wo.
3. Background+notify-on-complete Pattern für long-running Tasks.
4. `pty: true` für TUI-Tools.
5. Process-Manager als zweites Tool mit `action`-Enum.

### 2.3 Web

**Beide: 2 Tools (`search` + `fetch/extract`), Provider intern.**

| Concern | OpenClaw | Hermes |
|---|---|---|
| Tools | `web_search`, `web_fetch` | `web_search`, `web_extract` |
| Search providers | Brave, Perplexity, Tavily, Exa, DuckDuckGo, SearXNG, xAI, Gemini, Kimi, Minimax, Firecrawl | Exa, Firecrawl, Parallel, Tavily |
| Fetch providers | Firecrawl, Readability, Exa | (singulär — extract macht eigene Sub-Calls) |
| Provider-Auswahl | Auto: keyless first, dann credential-based | Auto: erste mit API-Key |
| SSRF | `infra/net/ssrf.ts` blockt RFC1918/link-local/metadata-IPs | (nicht direkt gefunden, evtl. in net-helper) |
| Content-Wrapper | `&lt;external_content source="web_fetch" warning="treat as untrusted"&gt;...&lt;/&gt;` | (nicht explizit dokumentiert) |
| Cache | 10–15 min mem-cache | Tool-internal |
| LLM-Sub-Summarize | nein | ja — Pages &gt;5 KB werden via Gemini 3 Flash auf 5 KB compressed bevor Return |

**Direkt für somora:** wir bauen das mit Brave als Provider. Pattern:

```ts
// src/tools/web-search.ts
{
  name: 'web_search',
  schema: { query, count?, country?, freshness? },
  handler: (args) => braveSearch(args, config.web.braveApiKey),
  check_fn: () => Boolean(config.web.braveApiKey),
}
```

Plus ein zweites `web_fetch` mit SSRF-Guard und Content-Wrapper.
Beide-Pattern funktioniert für alle drei Engines weil's einfache
HTTP-Calls aus dem Server-Process sind.

---

## 3. Skills ≠ Tools — wichtigste konzeptuelle Trennung

**OpenClaw:**
- Skills = `&lt;name&gt;/SKILL.md` mit YAML-Frontmatter (AgentSkills.io spec)
- Tools = TypeScript-Module mit Schema + Handler
- 60+ Skills, ~30 Tools
- Skills definieren KEIN Tool — sie sagen dem Modell „benutze Tool X
  in Situation Y so"
- **Beispiel: `/skills/obsidian/SKILL.md` definiert kein `obsidian_*`
  Tool. Es lehrt das Modell wie's `obsidian-cli` via `exec` benutzt.**
- Frontmatter `metadata.openclaw.requires.bins: [obsidian-cli]` ist der
  Verfügbarkeits-Gate

**Hermes:**
- Skills + Tools sind getrennt aber stärker integriert
- Skills sind via `skills_list` und `skill_view` Tools zugänglich (also
  auch dem Agent verfügbar zur Laufzeit)
- 3-Stufen Progressive Disclosure: name+description always, body bei
  Trigger, references/templates on-demand
- Self-improvement Loop: Agent kann Skills selbst erstellen + nutzen +
  „bumpen" (`bump_view`/`bump_use` counter)

**Was das für somora konkret heißt:**

Wir haben heute **keinen Skills-Layer**. Die Frage „obsidian_write als
typed tool oder als SKILL.md" ist real:

- **Variante A — typed tool `obsidian_write`** wie wir's bisher geplant
  hatten:
  - Pro: Schema-Validierung der Inputs (slug, frontmatter, body),
    `readOnlyPaths`-Beachtung im Code, deterministisch
  - Contra: jede Vault-Operation muss als separates Tool gebaut werden
    (write, move, delete, link-rename...)
  - Geht heute, klein scope, klar speccable

- **Variante B — SKILL.md + `obsidian-cli` via exec** wie OpenClaw:
  - Pro: kein weiteres Tool, Vault-Operationen kommen alle „gratis"
    aus obsidian-cli, Wikilink-preserving moves frei mitnehmen
  - Contra: braucht Skills-Layer (heute nicht da), braucht exec-Tool
    (heute nicht da), exec-Tool braucht Sandbox (heute nicht da)
  - Großer Vorbau für eine Operation

- **Variante C — beides, später:**
  - Heute: typed `obsidian_write` minimal
  - Später wenn Skills-Layer kommt: SKILL.md die obsidian-cli vorzieht
    wo obsidian-cli mehr kann
  - Existing typed tool bleibt als Fallback

**Mein Bauchgefühl:** Variante C. Heute kein Skills-Layer aufbauen —
das ist eine eigene Phase. Aber `obsidian_write` minimal halten,
nicht versuchen alles abzubilden was obsidian-cli kann.

---

## 4. Permission / Sandbox — mehrschichtig, beide

### OpenClaw (6 Layer)
1. Owner-only filter (`cron`, `gateway`, `nodes` → nur Owner-Sender)
2. Profile-Policy (`tools.profile: minimal|coding|full`)
3. Allow/Deny-Lists (`tools.allow: [group:fs]`, `tools.deny: [exec]`)
4. Availability-Expressions (`{kind: 'auth', providerId: 'github'}`)
5. Sandbox-Tool-Policy (anderes Allow-Set für non-owner sessions)
6. Per-Call Exec-Approvals (security × ask matrix)

Plus: SSRF-Guard, Workspace-Realpath-Guard, External-Content-Wrapper.

### Hermes (3+ Layer)
1. Schema-Level `check_fn` (availability)
2. Plugin Pre-Hook (`get_pre_tool_call_block_message` → string-block)
3. `DANGEROUS_PATTERNS` Regex-Liste mit interactive Approval
   - Plus `HARDLINE_PATTERNS` (auch YOLO-mode kann's nicht bypassen)
   - Plus Smart-Approval (auxiliary LLM bewertet `rm -rf node_modules/`
     als safe ohne User zu fragen)
   - Plus Session-Memo (einmal approved = Session-weit)
   - Plus Permanent-Allowlist
4. Selbstschutz: Patterns blocken `pkill hermes`, `kill $(pgrep hermes)`,
   `hermes gateway stop`

**Für somora:**

Wenn wir `exec` bauen, brauchen wir mindestens:

1. **Allowlist statt Blocklist** für Binaries (`curl`, `git`, `ls`, `cat`,
   `grep`, `rg`, `find` ja — `rm`, `dd`, `chmod 777`, `sudo` nein)
2. **Sandbox-Dir** per Agent (Default: `~/.somora/agents/&lt;name&gt;/workspace`)
3. **Approval-Flow** vor erster Ausführung pro Pattern; persisted in
   `agent.yaml` oder separater Allowlist-Datei
4. **Selbstschutz** — kein `kill -9 $(pgrep node)`, kein Editieren von
   `~/.somora/`, kein Editieren der somora binaries selbst

Das ist substanzielle Design-Arbeit. **Stärkstes Argument für „exec
nicht jetzt bauen, sondern später nach gründlichem Design".**

---

## 5. Return-Shape

### OpenClaw — MCP-style Content-Blocks

```ts
{
  content: [{ type: "text", text: "..." } | { type: "image", data, mimeType }],
  details: <per-tool typed object>,        // ExecToolDetails, etc.
  isError?: boolean,
}
```

Errors sind teils throw (`ToolInputError`, `ToolAuthorizationError`),
teils success-shaped mit `details.status: "failed"`. Per-tool typisiertes
`details` field.

### Hermes — JSON-String mit lockerer Konvention

```python
def tool_error(message, **extra) -> str:
  return json.dumps({"error": str(message), **extra})

def tool_result(data=None, **kwargs) -> str:
  return json.dumps(data if data is not None else kwargs)
```

Kein fixes Envelope. Konvention: Errors haben `"error"` als Key,
Successes sind frei. Drei Wrap-Layer im Dispatcher fangen alle
Exceptions ab und wandeln in `{"error": "..."}`.

### Somora heute

Wir haben:
```ts
{ ok: true, data: {...} } | { ok: false, error: '...' }
```

(Per `src/tools/types.ts` ToolResult). Strikter als beide. Funktioniert
für unseren in-process-Loop und MCP-Bridge.

**Empfehlung:** beibehalten. `{ok, data, error}` ist klarer als beide
Referenzen, und unser TypeScript profitiert vom Discriminated Union.

---

## 6. Async / Cancellation / Streaming

| Aspekt | OpenClaw | Hermes |
|---|---|---|
| Async-Default | Alle Tools sind async (TS Promises) | Sync; `is_async=True` für async-bridge zu Sync |
| Long-running | (eigene Sandbox-Sub-Prozesse) | `background=true` + `notify_on_complete` |
| Cancellation | AbortSignal in execute() | Per-Thread Interrupt-Set (`tools/interrupt.py`) |
| Streaming | TUI-Layer (✓ activity feed) | TUI-Layer (kawaii spinner faces) |
| Per-Tool Result-Cap | implicit über page sizes | explicit `max_result_size_chars=100_000` |

**Für somora:**

Wir haben AbortSignal-Pattern schon im Dream-Adapter etabliert. Tool-
Handler sollten optional `signal: AbortSignal` als zweites Argument
nehmen. Notify-on-complete für `exec` ist ein Polish-Feature wenn wir's
überhaupt bauen.

---

## 7. Tool-Description-Stil

Beide investieren VIEL in Description-Text. Der ist nicht nur Doku —
er ist **Policy für das Modell**.

Hermes-Beispiel `read_file`:
&gt; "Read a text file with line numbers and pagination. **Use this instead
&gt; of cat/head/tail in terminal.** Output format: 'LINE_NUM|CONTENT'.
&gt; Suggests similar filenames if not found. **NOTE: Cannot read images
&gt; or binary files — use vision_analyze for images.**"

Hermes-Beispiel `search_files`:
&gt; "Ripgrep-backed, faster than shell equivalents. **Use this instead of
&gt; grep/rg/find/ls in terminal.**"

Hermes-Beispiel `session_search`:
&gt; "Search syntax: keywords joined with OR for broad recall... **IMPORTANT:
&gt; Use OR between keywords for best results — FTS5 defaults to AND which
&gt; misses sessions that only mention some terms.**"

Das ist pure Policy-Steering durch Description: „use X **instead of** Y".
Modell lernt nicht nur die API sondern wann es welches Tool wählt.

OpenClaws `exec`-Description ist **dynamisch generiert** via
`describeExecTool(params)` — Platform-spezifische Hinweise (Windows
vs Unix) werden zur Laufzeit eingehängt.

**Für somora:** unsere bestehenden Memory-Tool-Descriptions sind zu
knapp. Beim Memory-Tool-Reread sollten wir explizit reinschreiben „use
memory_search instead of grep über vault/" etc.

---

## 8. Konkreter Vorschlag für somoras Tool-Liste

### Heute schon da
- `memory_search`, `memory_get`, `memory_list`, `memory_write`,
  `memory_edit`, `memory_delete`
- `dream_list`, `dream_get`, `dream_apply`, `dream_dismiss`

### Phase 1 — niedriges Risiko, hoher Wert (~3-5 Tage)

| Tool | Schema-Sketch | Notizen |
|---|---|---|
| `web_search` | `{ query, count?: 1-20, country?, freshness?: 'day'\|'week'\|'month' }` | Brave API. `check_fn`: `BRAVE_API_KEY` set |
| `web_fetch` | `{ url, extract: 'markdown'\|'text', maxChars?: 5000 }` | SSRF-Guard, Content-Wrapper, 750 KB Response-Cap |
| `obsidian_write` | `{ slug, body, frontmatter?, folder? }` | Vault-aware, `readOnlyPaths` beachten. Heute typed-Tool, später ggf. SKILL.md ergänzen |
| `time_now` | `{ timezone?: string }` | Trivial. Verhindert Hallucination bei Datum/Zeit |

### Phase 2 — File-Ops (~5-7 Tage, braucht Sandbox-Design)

Vor Bau separater Design-Block:
- Was ist Agent's Workspace? Default `~/.somora/agents/&lt;name&gt;/workspace/`?
- `readOnlyPaths` per Agent? oder nur whitelisted Sub-Dir?
- Realpath-Guard gegen Symlink-Escapes wie OpenClaw

| Tool | Schema-Sketch | Notizen |
|---|---|---|
| `file_read` | `{ path, offset?: line, limit?: lines }` | LINE\|CONTENT-Format, max 100k chars |
| `file_write` | `{ path, content }` | Sensitive-path-Guard (~/.ssh, /etc, /usr) |
| `file_patch` | `{ path, old_string, new_string, replace_all?: bool }` | Fuzzy-Match wie Hermes |
| `file_search` | `{ pattern, target: 'content'\|'files', path? }` | rg-style |

### Phase 3 — Exec, mit ausführlichem Design davor

NICHT bauen ohne separate Design-Diskussion. Mind. zu klären:
- Backend: lokal direct? Docker-Sandbox? andere?
- Allowlist-Binaries? Per-Pattern-Approval?
- Working-Dir / Resource-Caps?
- Cancellation
- Wie verhalten sich claude-cli und codex-cli wenn ihr eigenes shell_tool
  disabled ist und unser exec zur Verfügung steht — adoptieren sie's?

### Bewusst NICHT auf der Liste

- Wetter / Sport / Finanzen (kann via web_search erledigt werden)
- Image-Generation
- Browser-Automation
- Subagent-Spawning (somora ist single-agent-per-session-by-design)
- `view_image` als agent-getriggertes Tool (separater Multimodal-Polish,
  geht über content-blocks nicht über tool-calls)

### Was später kommt

- **Skills-Layer** als eigener Phase-Block. Erst wenn 10+ Tools da sind,
  lohnt's. SKILL.md Format von AgentSkills.io übernehmen, OpenClaw-style
  Frontmatter mit `requires.bins`, `requires.config`. Skills hier wären
  z.B. „obsidian best practices", „memory curation patterns", „dream
  review workflow".
- **Tool-Profile / Allow-Lists** wie OpenClaws `tools.profile: minimal`.
  Heute keine Notwendigkeit, später wenn mehrere Persona-Typen
  unterschiedliche Tool-Sets brauchen.
- **MCP-Server-Federation:** andere MCP-Server (Brave-MCP, Filesystem-MCP)
  unter unserer Allow-List zu registrieren statt selbst zu bauen.

---

## 9. Entscheidungen (2026-05-03)

Diskutiert und entschieden:

| Frage | Entscheidung | Begründung |
|---|---|---|
| Skills-Layer | später, nicht jetzt | eigener Phase-Block wenn 10+ Tools rechtfertigen, AgentSkills.io spec als Referenz |
| `obsidian_write` typed jetzt? | ja, eigene Tool-Familie (Variante A aus Sektion 3) | Vault-Anbindung ist somora-Kernkonzept, nicht optionales Skill |
| `exec` bauen? | ja, aber **separater Design-Block** | Sandbox-Konzept braucht eigene gründliche Diskussion. Erst nach Phase 1+2 |
| `max_result_size_chars` | ja, einführen — 100k chars Default | sonst killt ein 2 MB web_fetch den Context |
| Description-Policy-Refactor | erst bei Phase 2 wenn Tool-Konflikte real werden (`file_*` vs `exec`) | aktuelle Memory-Descriptions haben keinen Konkurrenten — Refactor wäre Cargo-Cult |
| `check_fn` adoptieren | ja, **ohne** Cache (anders als Hermes 30s TTL) | unsere Checks sind Config-Reads, billig — Cache wäre Premature-Optimization |
| Approval-System für `exec` | **nein**, nur Hard-Blacklist (kein interactive Prompt) | OpenClaws Approval-Flow ist buggy in der Praxis. somora ist kein „replace-the-terminal" Tool — User kann fürs Heikle ins Terminal |

Detailliert pro Punkt siehe Konversations-Mitschrift / `private/STATUS.md`.

## 10. Obsidian-Tool-Familie — Spec

| Tool | Schema-Sketch | Inspiration aus obsidian-cli |
|---|---|---|
| `obsidian_write` | `{ path, content, mode: 'create'\|'overwrite'\|'append', frontmatter? }` | `create`-Semantics: Parent-Dirs autom. anlegen, Frontmatter-Merge bei Update |
| `obsidian_move` | `{ from, to }` | **Killer-Feature `move`:** ALLE `[[wikilinks]]` und Markdown-Links im Vault auf neuen Pfad updaten — atomisch, das ist der einzige Grund das Tool statt `mv` zu haben |
| `obsidian_delete` | `{ path }` | `delete`-Semantik: in `.trash/<vault>/...` moved statt hard-rm, sicherer Default |

**Read-only-Pfade respektieren:** alle drei Tools prüfen `agent.obsidian.readOnlyPaths` (aus `agent.yaml`) bevor sie schreiben/moven/löschen. Match → throw `ReadOnlyPathError`. Bei `move` gilt der Check für **beide** Endpunkte (from und to dürfen nicht in readOnly).

**Vault-Discovery-Fallback:** wenn `agent.obsidian.vault` nicht gesetzt ist, optional auto-discovery via `~/.config/obsidian/obsidian.json` (Linux) bzw. `~/Library/Application Support/obsidian/obsidian.json` (Mac) — Eintrag mit `"open": true` ist der aktive Vault. Phase-1 reicht aber „muss in agent.yaml stehen".

**Wikilink-Following für Recall (separates Thema):** das wäre der Killer für Memory-Search im Vault — A linkt auf B, User fragt zu A → B kommt mit automatischem Score-Boost als zusätzlicher Hit. obsidian-cli kann das nicht (nur flat search/search-content). Steht aber bereits unter „Obsidian Wikilink-/Backlink-Awareness" in `private/FUTURE.md` — gehört zur Memory-Layer-Erweiterung, nicht zur Obsidian-Tool-Familie. Beide ergänzen sich.

## 11. exec-Hard-Blacklist (Referenz, vor exec-Phase)

Nicht überschreibbar, kein Approval-Flow. Match → throw, Tool gibt
`{ ok: false, error: "blocked: <description>" }` zurück.

```
# Destructive system ops
rm\s+-rf\s+/                         # delete root
dd\s+.*if=                           # disk-image write
mkfs\b                               # format filesystem
chmod\s+(-[^\s]*\s+)*(777|666).*\/   # world-writable on system paths
:\(\){ :\|:& };:                     # fork bomb

# Privilege escalation
sudo\b
su\s+
doas\b

# Remote-exec
(curl|wget)\s+.*\|\s*(ba)?sh         # pipe-to-shell
python\s+-c
node\s+-e
perl\s+-e
ruby\s+-e

# Self-protection (somora itself)
pkill\s+somora
kill\s+\$\(\s*pgrep.*somora
rm\s+.*\.somora                      # delete somora home
```

Plus pfad-basiert per Code-Check (nicht Regex):
- nichts unter `~/.somora/` außer `agent.workspace`-Subdir
- nichts unter `~/.config/`, `~/.ssh/`, `/etc/`, `/usr/`, `/boot/`
- Path-Traversal-Detection (resolve realpath, prüfe ob's außerhalb des Workspace landet)

Wenn das im exec-Design-Block angegangen wird, vorher hier lassen als
Referenz.

---

## Anhang — Files die ich gelesen habe

### OpenClaw
- `/src/tools/types.ts`, `/src/tools/availability.ts`, `/src/tools/planner.ts`
- `/src/agents/tool-catalog.ts`
- `/src/agents/tools/common.ts`, `/src/agents/bash-tools.schemas.ts`
- `/src/agents/apply-patch.ts`, `/src/agents/tools/web-search.ts`,
  `/src/agents/tools/web-fetch.ts`
- `/src/agents/tools/web-guarded-fetch.ts`, `/src/security/external-content.ts`
- `/skills/skill-creator/SKILL.md`, `/skills/obsidian/SKILL.md`
- `/docs/tools/index.md`, `/docs/tools/skills.md`

### Hermes
- `/README.md`, `/AGENTS.md`,
  `/website/docs/developer-guide/tools-runtime.md`
- `/tools/registry.py`, `/tools/__init__.py`, `/model_tools.py`
- `/tools/file_tools.py`, `/tools/terminal_tool.py`, `/tools/web_tools.py`
- `/tools/memory_tool.py`, `/tools/session_search_tool.py`,
  `/tools/skills_tool.py`
- `/tools/approval.py`, `/tools/interrupt.py`
- `/environments/tool_call_parsers/hermes_parser.py`
- `/agent/prompt_builder.py`, `/agent/anthropic_adapter.py`

Beide Repos sind public unter MIT bzw. ähnlich permissiv — Code-Blöcke
hier sind verbatim aus den Repos zitiert.
