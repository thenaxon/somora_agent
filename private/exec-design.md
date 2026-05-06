# exec + tmux — Design-Skizze (Stand 2026-05-06)

Working draft nach Pre-Build-Research und Klärungsrunde mit Rene.
Phase 5a baut `exec` + `process`, Phase 5b baut `tmux`. Alle drei
Tools mit `target: 'local'|<resource-name>`-Pattern wie unsere
`file_*`-Familie.

## Grundprinzip

Drei Tools, alle mit demselben Targeting-Pattern. Modell entscheidet
pro Call ob's auf der somora-Server-Maschine („local") oder gegen
eine konfigurierte SSH-Resource laufen soll.

- **`exec`** — einmaliger Shell-Command, sync oder background.
- **`process`** — interagiert mit laufenden background-jobs (list,
  log, write-stdin, kill).
- **`tmux`** — orchestriert lang-lebende tmux-Sessions auf local
  oder remote.

Kein Approval-Flow, keine granularen Per-Agent-Permissions.
Hard-Blacklist (Liste unten) blockt die wirklich gefährlichen
Patterns. Sonst: Modell darf alles ausführen was tatsächlich
auch nützlich ist.

## Tool-Schemas

### `exec`

```ts
{
  command: string,                    // shell command to run
  target?: 'local' | <resource-name>, // default 'local'
  cwd?: string,                       // working dir on the target machine
  env?: Record<string, string>,       // extra env vars (merged with target shell env)
  background?: boolean,               // default false (sync). when true → fire-and-forget, returns job_id
  timeout_ms?: number,                // sync only; ignored when background:true
  pty?: boolean,                      // allocate pseudo-tty for the command (TUI tools, color output)
  description?: string,               // human-readable description (for logs + UI)
}
```

**Sync-Result:**
```ts
{
  ok: boolean,
  exit_code: number | null,
  stdout: string,
  stderr: string,
  truncated: boolean,
  ms: number,
}
```

**Background-Result:**
```ts
{
  ok: true,
  background: true,
  job_id: string,                     // 'job_<ms>_<rand>'
  hint: 'use process({action:"poll", job_id}) to check status',
}
```

**Tool-Description-Highlight für das Modell:**
- „**Für File-Writing auf Remote-Targets nutze IMMER `file_write`,
  nie `exec` mit heredoc/echo.** Shell-Escape von Datei-Inhalten
  bricht bei großen oder komplexen Inhalten — file_write geht
  über SFTP, ist binär-clean."
- „Output ist auf 256 KB pro Stream gecapt. Wenn truncated:true
  zurückkommt: schreib das Ziel auf disk + nutze file_read mit
  offset/limit."
- „Background:true ist für long-running Tasks — Build, Test-Suite,
  langer Server. process_*-Tools für Interaktion."

### `process`

```ts
{
  action: 'list' | 'poll' | 'log' | 'write' | 'kill',
  job_id?: string,                    // required für poll/log/write/kill
  // action-spezifisch:
  text?: string,                      // for write (stdin)
  tail_lines?: number,                // for log (default 50)
  signal?: 'SIGTERM' | 'SIGKILL',     // for kill (default SIGTERM)
}
```

**Per-action-Returns:**
- `list` → `{ jobs: [{job_id, target, command, started_at, state, ms}] }`
- `poll` → `{ job_id, state: 'running'|'done'|'failed'|'killed', exit_code?, ms }`
- `log` → `{ job_id, stdout_tail, stderr_tail, total_bytes, truncated }`
- `write` → `{ ok, bytes_written }` (stdin into the running process)
- `kill` → `{ ok, signal_sent, was_running }`

8 Actions wie OpenClaw (`send-keys`, `submit`, `paste`) sparen wir
für tmux-Kontext auf — bei generischem Background-Job reicht `write`.

### `tmux` (Phase 5b)

```ts
{
  action: 'create' | 'send' | 'capture' | 'list' | 'kill',
  target?: 'local' | <resource-name>, // tmux-Session läuft auf dieser Maschine
  // action-spezifisch:
  name?: string,                      // session name (create, send, capture, kill)
  cwd?: string,                       // create only — initial working dir
  keys?: string,                      // send only — text to type, '\n' für Enter
  wait_pattern?: string,              // capture only — block bis Pattern in Output erscheint
  wait_timeout_ms?: number,           // capture only — max wait when wait_pattern set
  lines?: number,                     // capture only — last N lines (default 200)
}
```

**Per-action-Returns:**
- `create` → `{ session_name, target, hint }`
- `send` → `{ ok, ms }` (no return content; capture afterwards)
- `capture` → `{ session_name, target, content, lines, matched_pattern? }`
- `list` → `{ target, sessions: [{name, created_at, panes}] }`
- `kill` → `{ ok, was_running }`

**Use-case Beispiel:** Agent startet eine claude-cli-Session auf
spiderman, gibt ihr Tasks, liest Output:

```
1. tmux({action:'create', target:'spiderman', name:'claude-job', cwd:'/home/me/repo'})
2. tmux({action:'send', target:'spiderman', name:'claude-job',
         keys:'claude --dangerously-skip-permissions\n'})
3. tmux({action:'capture', target:'spiderman', name:'claude-job',
         wait_pattern:'> $', wait_timeout_ms:30000})
   → liest Claude's startup-output, blockt bis Prompt erscheint
4. tmux({action:'send', ..., keys:'fix the bug in foo.ts\n'})
5. tmux({action:'capture', ..., wait_pattern:'> $', wait_timeout_ms:300000})
   → wartet bis Claude fertig, gibt full output zurück
6. ... Iteration ...
7. tmux({action:'kill', target:'spiderman', name:'claude-job'})
```

Selbe Mechanik mit codex (`codex --no-approval`), gpt, vim, top,
eigentlich allem was auf einer normalen Shell läuft.

**tmux auf remote (`target: <resource>`):** wir wrappen jeden tmux-
Befehl in einen `ssh ... tmux ...` Aufruf via unseren bestehenden
SSH-Pool. tmux muss auf der Resource installiert sein (auf den
meisten Linux/macOS-Boxen Standard, sonst `apt/brew install tmux`).
Session lebt auf der Resource — wenn die SSH-Connection abbricht,
läuft die Session weiter (das ist der Sinn von tmux). Bei
nächstem `tmux({action:'capture'})` Call connect'en wir neu, hängen
uns an, lesen den Pane.

## Hard-Blacklist (v1 — bewusst kurz)

Liste in `src/tools/exec/blacklist.ts`. Match → throw mit klarem
Hint, Tool gibt `{ok:false, error:'blocked: <description>'}` zurück.
Iterativ erweitern wenn was Neues auffällt.

```ts
const HARD_BLACKLIST: Array<{ pattern: RegExp; reason: string }> = [
  // Destructive disk operations
  { pattern: /\brm\s+-rf\s+\/(?!\S)/, reason: 'rm -rf /' },
  { pattern: /\brm\s+-rf\s+\/\S+/, reason: 'rm -rf with absolute path under /' },
  { pattern: /\bdd\s+[^|]*if=/, reason: 'dd if= (disk-image write)' },
  { pattern: /\bmkfs\b/, reason: 'mkfs (format filesystem)' },
  { pattern: /\bshred\b/, reason: 'shred (overwrite + delete)' },

  // Privilege escalation
  { pattern: /^\s*sudo\s/, reason: 'sudo (privilege escalation)' },
  { pattern: /^\s*doas\s/, reason: 'doas (privilege escalation)' },
  { pattern: /\bsu\s+-?\s*$/, reason: 'su (switch user)' },

  // Forks bombs + system stop
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/, reason: 'fork bomb' },
  { pattern: /\b(shutdown|halt|reboot|poweroff)\b/, reason: 'system halt' },

  // World-writable on system paths
  { pattern: /\bchmod\s+(-[^\s]*\s+)*(777|666)\s+(\/(etc|usr|bin|sbin|boot|root))/, reason: 'chmod 777/666 on system path' },

  // SSH key + credential exfiltration heuristics (rough first pass)
  { pattern: /\bcat\s+[^|]*\.ssh\/id_/, reason: 'cat private SSH key' },
  { pattern: /\bcurl[^|]*\|\s*(bash|sh|zsh)\b/, reason: 'curl | sh (untrusted exec)' },
  { pattern: /\bwget[^|]*\|\s*(bash|sh|zsh)\b/, reason: 'wget | sh (untrusted exec)' },
];
```

Bewusst **NICHT** drin: `rm -rf` mit relativen pfaden (zu strict —
Agent muss Build-Artifacts löschen können), `chmod` allgemein
(viele legitime Use-Cases), `git`, `npm`, `pip`, `make` etc. Wenn
Schmerz aufkommt: Liste erweitern.

**Match-Rule:** Regex tested gegen den vollen `command` string
nach minimaler Normalisierung (collapse whitespace). Kein
Tree-Sitter-Parsing für v1 — Regex reicht für die offensichtlichen
Fälle, der Rest ist „der User hat alle Permissions die er sich
schon mal selbst gesetzt hat".

## Background-Job Disk-Layout

Pro Job ein Verzeichnis unter
`~/.somora/agents/<agent>/exec-jobs/<job_id>/`:

```
exec-jobs/
└── job_1778001234_a3f2/
    ├── meta.json        # job state + metadata
    ├── stdout.log       # full stdout, append-only
    ├── stderr.log       # full stderr, append-only
    └── exit              # written when process ends, contains exit code
```

`meta.json` Schema:
```jsonc
{
  "job_id": "job_1778001234_a3f2",
  "agent": "hans",
  "target": "local",
  "command": "npm run build",
  "cwd": "/home/me/repo",
  "started_at": 1778001234567,
  "state": "running",   // running | done | failed | killed
  "pid": 12345,         // local only; null for remote
  "ssh_thread": "...",  // remote only; ssh-pool conn id
  "ended_at": null,
  "exit_code": null,
}
```

Server-start scannt `exec-jobs/*/meta.json`, markiert alle
`state: 'running'` → `state: 'failed', error: 'orphaned by server restart'`
(analog `recoverOrphanRunningDreams`). User sieht via `process_list`
warum's tot ist.

Output-Cap pro Stream: 256 KB für `process_log` Tail-Reads. Disk
selber ist unbegrenzt — wenn ein Build-Job 2 GB Output produziert,
der landed in stdout.log und User kann via `file_read` mit
offset/limit chunked durchgehen. Cap ist nur fürs `log`-Action das
Tail liest.

## SSH-Integration

Existing pieces wir reusen ohne Änderung:

- `src/ssh/pool.ts:getConnection()` — connection pooling per resource
- `src/ssh/exec.ts:remoteExec()` — single command + cwd + timeout +
  256 KB output cap (das schon)
- `src/tools/resources/visibility.ts:resolveVisibleResourceFresh()` —
  resolves target name → SshResource (mit hot-reload via Bug-4-Fix)

**exec-Tool sync auf remote:**
```ts
const resource = await resolveVisibleResourceFresh(ctx.agent, input.target);
const conn = await getConnection(input.target, resource);
const result = await remoteExec(conn, input.command, {
  cwd: input.cwd,
  timeoutMs: input.timeout_ms ?? 60_000,
});
```

**exec-Tool background auf remote:** Heißeisen — ssh2's `exec`
gibt einen Stream, den wir am Leben halten müssen während ihn
keiner liest. Vermutlich: stream stays open, output streamt in
`stdout.log` File, pid via `$$` echo + capture, kill via separate
ssh exec mit pid. **Detail-Design beim Bau, nicht jetzt.**

**tmux-Tool auf remote:** wrap jeden tmux-Befehl in einen
remoteExec call:
```
remoteExec(conn, `tmux new-session -d -s ${name} -c ${cwd}`)
remoteExec(conn, `tmux send-keys -t ${name} ${shell-quote(keys)}`)
remoteExec(conn, `tmux capture-pane -t ${name} -p -S -${lines}`)
```
Jeder tmux-Aufruf ist ein eigener short-lived ssh exec. Session
lebt auf der Resource zwischen Calls. Connection-Pool reused.

## Output-Cap + Truncation-Pattern

Konsistent zu unserem bestehenden 256-KB-Cap im SSH-Pool:

- `exec` sync: stdout + stderr je 256 KB, dann truncated:true
- `exec` background: kein Cap auf disk-files (stdout.log darf so
  groß wie er will), aber `process_log` action liefert max 256 KB
  Tail
- `tmux capture`: max 200 lines default (configurable), wenn der
  Pane mehr hat → letzte N. Nicht durch byte-cap weil Lines die
  natürliche Einheit für Terminal-Output sind.

Wenn truncated → Tool-Result hat `truncated: true` UND Hint im
output: „Output truncated at 256KB. Write to file + use file_read
with offset/limit for full content." So lernt das Modell die
richtige Eskalation.

## Implementations-Reihenfolge

**Phase 5a — exec + process** (~3-5 Tage):

- `src/tools/exec/blacklist.ts` — Hard-Blacklist mit Regex-Liste
- `src/tools/exec/job-store.ts` — Disk-tracked job lifecycle
  (newJobId, registerJob, completeJob, failJob, killJob, listJobs)
- `src/tools/exec/local.ts` — local sync + background via
  child_process spawn
- `src/tools/exec/remote.ts` — remote sync + background via SSH
- `src/tools/exec/tools.ts` — exec + process tool definitions
  (analog file/tools.ts struktur)
- Server-start: `recoverOrphanedJobs(agentList)` analog
  `recoverOrphanRunningDreams`
- Smoke: 5-10 Test-Calls (sync local, sync remote, background mit
  poll, kill, blacklist-trigger)

**Phase 5b — tmux** (~2 Tage nach 5a):

- `src/tools/tmux/local.ts` — tmux via local exec
- `src/tools/tmux/remote.ts` — tmux via remoteExec
- `src/tools/tmux/tools.ts` — tmux tool definition mit action-Enum
- Smoke: claude-cli in tmux orchestrieren end-to-end (use case
  aus dem Design-Doc oben)

## Was bewusst NICHT in v1

- **`notify_on_complete` + `watch_patterns`** (Hermes-Stil
  Push-Mechanik) — braucht Server→Modell push channel den wir
  nicht haben; FUTURE wenn long-running-jobs ein echter Schmerz
  werden
- **`elevated: true` Mode** für sudo-Operationen — Hard-Blacklist
  blockt sudo, fertig. Wenn User wirklich elevated braucht: ins
  Terminal selber gehen
- **PTY für Background-Jobs** — pty:true klappt nur sync. Background
  + pty wäre Tail-from-disk-mit-ANSI-Codes-Stripping = aufwendig.
  Background ist für Build/Test/Server nicht für TUI.
- **Granulare Per-Agent-Permissions** (Whitelist von Commands etc.)
  — wenn Schmerz aufkommt, später bauen
- **Sandbox-Container** (Docker/firejail/bubblewrap) — somora ist
  lokale Runtime, User vertraut den eigenen Agents
- **Approval-Flow** — explizit ausgeschlossen DECISION 2026-05-03
- **Ad-hoc SSH ohne Resource-Eintrag** — alles SSH muss vorher in
  config.yaml eingetragen sein. „auf wildfremde hosts gehen" wird
  ggf. eine eigene spätere Phase
- **Tree-Sitter-AST-Sicherheits-Parsing** wie claude-code-source —
  Regex reicht für die wirklich gefährlichen Patterns, AST wäre
  premature

## Code-Pointer für späteren Wiedereinstieg

- `src/ssh/pool.ts` + `src/ssh/exec.ts` — bestehende SSH-Integration
- `src/tools/file/local.ts` + `remote.ts` — Vorbild für lokal/remote-
  Aufteilung
- `src/tools/file/policy.ts` — Vorbild für blacklist-Pattern
- `src/dream/storage.ts` `recoverOrphanRunningDreams` — Vorbild
  für Server-start orphan recovery
- `src/tools/agents/spawn.ts` — Vorbild für ms+rand-suffix slug
  generation (für job_id)
- `docs/research/tool-architecture.md` §11 — Hard-Blacklist
  Referenz die wir hier mit konkreten Regex-Patterns gefüllt haben

## Diskussions-Loose-Ends

Drei kleine Sachen wo ich beim Bau nochmal kurz fragen werde wenn's
ansteht — kein Blocker, aber sinnvoll auf dem Schirm:

1. **`pty:true` sync auf remote:** ssh2 unterstützt pty-allocation,
   muss aber ein bisschen anders aufgesetzt werden als regular
   exec. Bauen wir mit, oder lassen wir's sync-only auf
   `target:'local'` und remote-pty kommt FUTURE?
2. **`process_write` für stdin** auf remote: ssh2's stream hat
   einen writable side, das geht — aber Detail-Design schwierig
   weil der Stream offen bleiben muss zwischen `process` calls.
   Vermutung: nur lokal in v1, remote kommt FUTURE.
3. **Concurrency-Cap auf gleichzeitige Background-Jobs:** wie viele
   parallele exec-Background-Jobs darf ein Agent? Default-Vorschlag:
   8 per agent, 32 global (analog spawn_subagent caps). Bauen wir
   mit.
