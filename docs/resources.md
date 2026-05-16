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
  (after the deny-filter is applied).
- `resource_test` — connects (or reuses cached conn) and runs
  `whoami; hostname; uname -srm; uptime` for a fast reachability
  check. Surfaces auth/network errors with a clear message before
  workload tools fail later.

## What's NOT here yet (FUTURE)

- Read-only resources (`readOnly: true` in config to allow `file_read`
  + `exec` but block `file_write`/`patch`/`delete`).
- Bastion / jump-host support.
- Other transport types (Docker, k8s).
