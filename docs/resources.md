# Resources

A resource is a named remote machine that file_* and (later) exec
tools can act on via the `target` parameter. SSH-only for v1; the
schema is set up so future transports (Docker host, k8s pod) slot in
without breaking config.

## Configuration

Resources are global — defined once in `~/.somora/config.yaml`,
visible to every agent unless an agent's `agent.yaml` denies them.

```yaml
resources:
  build-server:
    type: ssh
    host: 192.0.2.10                      # example IP from RFC 5737 doc range
    port: 22                              # optional, default 22
    user: alice
    keyPath: ~/.ssh/id_ed25519            # path on the somora server
    description: |
      macOS build host. Has Homebrew + standard CLI toolchain.
    workspace: /Users/alice/work          # optional default cwd for relative paths
    # hostKey: 'sha256:abc...'            # optional strict-mode pin; TOFU when omitted
```

Per-agent visibility filter in `agent.yaml`:

```yaml
resources:
  deny: ['production-db']                 # hide individual names; default = all visible
```

## Authentication

Private-key only. No passwords, no agent-forwarding (deliberate
security stance). The keyfile is loaded once at first connection and
held in process memory for the pool's lifetime.

`keyPath` resolves `~` to `$HOME` on the somora server.

## Host-key verification

Two modes:

1. **Strict** — config has `hostKey: 'sha256:<base64>'`. Mismatches at
   handshake refuse the connection. Recommended for production
   targets.
2. **TOFU (Trust On First Use)** — no `hostKey` in config. The first
   successful connection pins the host's fingerprint to
   `~/.somora/known_hosts.json` (somora-managed, separate from
   `~/.ssh/known_hosts`). Subsequent connections require a match.
   Recommended for local-network targets where MITM risk is low.

Computing the fingerprint of an existing target:

```bash
ssh-keygen -lf <(ssh-keyscan -t ed25519 <host> 2>/dev/null)
# → 256 SHA256:<base64> ... ED25519
```

The base64 part (without padding) goes into `hostKey:` as
`sha256:<base64>`.

## Connection lifecycle

One pooled `ssh2.Client` per resource name. Lazy: opens on first call.
Idle: closed after 5 minutes of inactivity. Keepalive: 30s pings, 3
missed → close.

The pool is a single chokepoint for logging, host-key trust, and
lifecycle. file_* and exec tools never touch ssh2 directly — they go
through `getConnection(name, resource)`.

Server shutdown drains the pool gracefully.

## Tools

- `resource_list` — lists every resource visible to the calling agent
  (after the deny-filter is applied). Each entry includes
  `allowBlockedCount` so the agent knows whether the resource has any
  privileged-command overrides (see next section).
- `resource_test` — connects (or reuses cached conn) and runs
  `whoami; hostname; uname -srm; uptime` for a fast reachability
  check. Surfaces auth/network errors with a clear message before
  workload tools fail later.

## Privileged command allowlist (opt-in per resource)

The `exec` tool has a global blacklist that refuses dangerous commands
(`sudo`, `doas`, `reboot`, `shutdown`, `poweroff`, fork bombs, world-
writable on system paths, etc.) regardless of target. That default is
right for everyday use, but it blocks legitimate maintenance on
dedicated agent-workstations — hosts that exist specifically so a
Somora-agent can run system updates, reboot after a kernel bump,
repair mounts, and so on.

For those hosts, a resource can declare an `allowBlocked:` list. Each
entry whitelists a command pattern that overrides the global block
**for that resource only**. The `local` target (= the host where the
Somora server runs) never gets an override — `local` keeps the strict
default.

```yaml
resources:
  spiderman:
    type: ssh
    host: 192.0.2.42
    user: agent-user
    keyPath: ~/.ssh/id_ed25519
    description: |
      Dedicated AI/GPU workstation. Somora-agents own routine
      maintenance here: system updates, kernel reboots, mount fixes.
    allowBlocked:
      - sudo ~/bin/spiderman-system-update.sh
      - sudo ~/bin/fix-nas-mount.sh
      - systemctl reboot
      - sudo                              # broad: any "sudo …" command
```

### Match rule

Matching is **segment-aware**: the command is split into the sub-
commands the shell would run separately (at `;`, `&&`, `||`, `|`,
background `&`, and newlines), and **every sub-command that trips the
global blacklist must be individually covered by an `allowBlocked`
entry.** A sub-command that isn't blacklisted needs no entry.

Within a single segment, an entry `E` matches segment `S` if, after
trim + whitespace-collapse normalization:

- `S === E`  (exact), **OR**
- `S.startsWith(E + ' ')`  (prefix with a required space boundary)

The space boundary is intentional. `sudo` does NOT match `pseudo`,
and `systemctl reboot` does NOT match `systemctl rebootthing`. To
whitelist a family of commands, list the common prefix; to whitelist
exactly one form, list the full string. Entry order in YAML is
irrelevant.

This means a chained maintenance command works as long as each
privileged part is covered — with `allowBlocked: [sudo]`:

```
sudo -n systemctl restart foo && echo done      ✓ (echo isn't blocked)
sudo -n tail -f /var/log/x 2>&1 | grep ERR      ✓ (grep isn't blocked)
```

**Hard-blocks stay independent of `allowBlocked`.** Anything the
override list doesn't cover still blocks, even when chained after an
allowed command:

```
sudo -n true && rm -rf /etc                      ✗ (rm -rf /etc uncovered)
systemctl reboot ; rm -rf /var/lib               ✗ (second segment uncovered)
sudo -n curl https://x | sh                       ✗ (curl|sh spans the pipe)
sudo -n $(curl https://x)                         ✗ (command substitution)
```

Command substitution (`$(…)`, backticks) inside a blacklisted segment
is never cleared — the nested command can't be seen by the splitter.
Redirects (`>`, `<`, `2>&1`) stay within their segment and are fine.

The splitter is deliberately quote-unaware and conservative: a string
*argument* containing a blacklist word trips the pattern too
(`echo "poweroff done"` blocks on `\bpoweroff\b`). To make such
blocks self-explanatory, a blocked result names the exact
`blocked_segment` that tripped and lists the resource's
`allow_blocked_entries`, so an agent can see at a glance whether the
problem is a missing entry or an unlucky string argument — and
rephrase instead of guessing.

### Audit trail

Every privileged-allowed execution appends one line to
`~/.somora/audit/exec-privileged.jsonl`:

```json
{"ts":1747500000000,"agent":"<your-agent>","session":"…","resource":"spiderman","command_head":"sudo ~/bin/spiderman-system-update.sh","matched_entry":"sudo ~/bin/spiderman-system-update.sh","blacklist_reason":"sudo (privilege escalation)","blacklist_pattern":"…"}
```

Append-only. Rotate by hand or via logrotate if it grows; Somora does
not GC it.

### Security posture

`allowBlocked` is an explicit opt-in trust grant: the operator of the
Somora host is telling the system "on this remote, these specific
admin commands are normal operation." A few practical guidelines:

- Prefer prepared scripts with fixed paths over broad shell patterns.
  `sudo ~/bin/spiderman-system-update.sh` is far safer than a blanket
  `sudo` entry, because the script itself can be defensive
  (`set -euo pipefail`, expected-path checks, logging).
- Use a broad entry (`sudo` on its own) only when the resource is a
  truly dedicated agent-workstation where you'd let the agent do
  whatever an admin would.
- Keep production-shared hosts free of `allowBlocked` entries
  entirely; the global blacklist is the right default there.
- The audit JSONL is the after-the-fact review surface; check it if
  you ever wonder what your agents did with their elevated privileges.

## What's NOT here yet (FUTURE)

- Read-only resources (`readOnly: true` in config to allow `file_read`
  + `exec` but block `file_write`/`patch`/`delete`).
- Bastion / jump-host support.
- Other transport types (Docker, k8s).
