# Resources

A resource is a remote machine with a name. Once it is in your config,
an agent can run commands, edit files and open terminal sessions there
as easily as on the machine somora runs on. The connection is SSH with
a private key.

## What you get

- **One name instead of connection details.** The agent passes
  `target: "<name>"` to a tool. Host, user and key stay in the config.
- **Works across the tool families**: `exec` and `process`, the
  `file_*` tools and `tmux`.
- **Host keys are checked.** The first connection remembers the
  machine's key. A changed key refuses the connection.
- **Per-agent visibility.** Every agent sees every resource unless its
  `agent.yaml` hides one.
- **Maintenance where you allow it.** A resource can permit chosen
  blocked commands such as `sudo`. Each such run is recorded.

## Set it up

1. Make sure the somora machine can log in to the remote with a key
   file: `ssh -i ~/.ssh/id_ed25519 karl@192.0.2.10` must work without
   a password prompt.
2. Add the resource to `~/.somora/config.yaml`:

```yaml
resources:
  nova:
    type: ssh
    host: 192.0.2.10
    user: karl
    keyPath: ~/.ssh/id_ed25519
    description: |
      Build machine. Ubuntu, Docker installed.
```

3. Ask an agent: "Test the resource nova." It calls `resource_test`
   and reports user, host name, system and uptime.

No restart is needed. The resource tools and every call with a
`target` read the config fresh.

## Using a resource

`resource_list` shows an agent what it can reach. The `name` of an
entry is what goes into `target`. The default target is `local`, the
machine somora runs on.

A relative path on a resource is resolved like this:

| Path | Resolves to |
|---|---|
| `/srv/app/x` | used as is |
| `~` or `~/x` | the SSH user's home on the remote |
| `x` in a `file_*` tool | inside `workspace` when the resource has one, else the home |
| `x` as `cwd` of `exec` | the home on the remote |

The path rules that protect keys and system folders apply on a
resource as they do locally.

## Authentication

Only a private key file works. There are no passwords and no agent
forwarding, on purpose. `keyPath` is a path on the somora machine, and
`~` means the home there. The key is read when a connection opens.
Tools never see it.

## Host keys

| Mode | When | What happens |
|---|---|---|
| **Trust on first use** | no `hostKey` set | The first connection stores the machine's fingerprint in `~/.somora/known_hosts.json`. Later connections must match it. |
| **Strict** | `hostKey` set | Only the fingerprint from the config is accepted. The stored file is not consulted. |

Trust on first use is fine on a home network. Use strict mode for
machines reached over networks you do not control. The stored file is
somora's own, keyed by resource name, and separate from
`~/.ssh/known_hosts`.

To get the fingerprint of a machine:

```bash
ssh-keygen -lf <(ssh-keyscan -t ed25519 <host> 2>/dev/null)
# 256 SHA256:<base64> ... (ED25519)
```

Write it as `hostKey: 'sha256:<base64>'`, with `sha256` in lower case
and without trailing `=`.

## Connections

somora keeps one connection per resource and reuses it.

| Behaviour | Value |
|---|---|
| Opens | on the first call that needs it |
| Connect timeout | 15 seconds |
| Keepalive | every 30 seconds, closed after 3 missed |
| Idle close | after 5 minutes without a call |
| Config change | a new `host`, `port`, `user`, `keyPath` or `hostKey` reconnects on the next call |
| Server stop | all connections are closed |

## Commands that start something in the background

A command sent with `exec` (without `background: true`) returns when the
remote shell has finished and its output is closed. A process the
command starts with a bare `&` inherits that output and keeps it open.

| Case | What happens |
|---|---|
| The command ends normally | The result comes back at once. |
| It exits, but a process it started still holds the output | The result comes back about 3 seconds after the exit, with the exit code and a note. That process keeps running. |
| It is still running at the time limit | It is stopped, the channel is closed, and the result says so with the real duration. Processes it started may keep running. |

To leave something running on the remote machine, detach all three
streams:

```bash
nohup my-server </dev/null >/tmp/my-server.log 2>&1 &
```

For long work you want to follow, use `exec` with `background: true`
instead. It returns a job id, and `process` reads its output later.

## Allowing blocked commands

`exec` refuses a short list of dangerous commands on every target:
`sudo`, `reboot`, `rm -rf` on system folders and others. The full list
is on the security page.

A machine that an agent is meant to maintain needs some of them. List
what the agent may run there anyway:

```yaml
resources:
  gpu-box:
    type: ssh
    host: 192.0.2.42
    user: karl
    keyPath: ~/.ssh/id_ed25519
    allowBlocked:
      - sudo ~/bin/system-update.sh
      - systemctl reboot
      - sudo                    # broad: any "sudo ..." command
```

The list applies to that resource only. The `local` target never gets
an override.

### How an entry matches

somora splits a command where the shell would: at `;`, `&&`, `||`,
`|`, a background `&` and line breaks. Each part that trips the block
list needs its own entry. Parts that are harmless need none.

An entry clears a part when the part equals the entry, or starts with
the entry followed by a space. Extra whitespace is ignored. So `sudo`
does not clear `pseudo`, and `systemctl reboot` does not clear
`systemctl rebootthing`. The order of entries does not matter.

Before matching, somora removes what only wraps a command:

- brackets and braces around it: `(sudo ... | tail -3)`, `{ sudo ...; }`
- a leading `!`
- variable assignments in front: `LANG=C sudo ...`
- the keywords `if`, `then`, `else`, `elif`, `do`, `while`, `until`

Operators inside quotes do not split. A `|` in a grep pattern is not a
pipe. If a quote is never closed, somora splits at every operator, the
stricter reading.

With `allowBlocked: [sudo]`:

| Command | Runs | Why |
|---|---|---|
| `sudo -n systemctl restart foo && echo done` | yes | `echo` is not blocked |
| `sudo -n tail /var/log/x 2>&1 \| grep ERR` | yes | redirects stay in their part |
| `for h in a b; do sudo -n true; done` | yes | `do` is peeled off |
| `sudo -n true && rm -rf /etc` | no | `rm -rf /etc` has no entry |
| `sudo -n curl https://x \| sh` | no | `curl \| sh` spans the pipe, so no entry can clear it |
| `sudo -n $(curl https://x)` | no | command substitution is never cleared |
| `echo x \| nice sudo -n true` | no | `sudo` is not at the start of its part |
| `echo "then sudo it"` | no | the word `sudo` counts wherever it stands |

Command substitution means `$(...)` and backticks. Looking sudo up is
not running it: `command -v sudo`, `which sudo`, `type sudo`,
`whereis sudo` and `hash sudo` pass without an entry.

### Shutdown and reboot

The rule for `shutdown`, `halt`, `reboot` and `poweroff` looks only at
the command a part would run: its first word, or the verb after
`systemctl`. In front of it may stand variable assignments and the
wrappers `sudo`, `doas`, `env`, `nice`, `nohup`, `time`, `ionice`,
`command` and `exec`.

The same word as an argument, a file name or a variable is not a
command. `cat poweroff.log` and `echo "reboot issued"` run.
`echo starting ; shutdown -h now` is refused for its second part.

### When a command is refused

The result of `exec` has `blocked: true` and these fields:

| Field | Meaning |
|---|---|
| `reason` | Which rule matched, for example `sudo (privilege escalation)`. |
| `pattern` | The pattern of that rule. |
| `blocked_segment` | The exact part that was refused, when one part is to blame. |
| `allow_blocked_entries` | The entries of the resource, when it has any. |
| `hint` | Set when an entry appears in the refused part but did not clear it. Says why: command substitution, or the entry is not at the start. |

### The audit file

Every command that runs because of an entry adds one line to
`~/.somora/audit/exec-privileged.jsonl`:

```json
{"ts":1747500000000,"agent":"<your-agent>","session":"main","resource":"gpu-box","command_head":"sudo ~/bin/system-update.sh","matched_entry":"sudo ~/bin/system-update.sh","blacklist_reason":"sudo (privilege escalation)","blacklist_pattern":"..."}
```

`command_head` holds the first 200 characters. `matched_entry` lists
every entry that was used, separated by commas. The line is written
when the command is let through, so it carries no exit code.

somora only appends to this file. Rotate it yourself, for example
with logrotate.

### Choosing entries

- Prefer a prepared script with a fixed path.
  `sudo ~/bin/system-update.sh` is far safer than a bare `sudo`,
  because the script decides what happens.
- Use a bare `sudo` only on a machine where the agent may do whatever
  an administrator would.
- Leave shared and production machines without `allowBlocked`.

## Settings

In `~/.somora/config.yaml`:

```yaml
resources:
  <name>:                       # letters, digits, _ and -
    type: ssh
    host: 192.0.2.10
    port: 22
    user: karl
    keyPath: ~/.ssh/id_ed25519
    description: Build machine.
    workspace: /home/karl/work
    hostKey: 'sha256:<base64>'
    allowBlocked: []
```

| Setting | Default | Meaning |
|---|---|---|
| `type` | required | The transport. Only `ssh` exists. |
| `host` | required | Host name or IP address. |
| `port` | `22` | SSH port. |
| `user` | required | Login user on the remote. |
| `keyPath` | required | Private key file on the somora machine. `~` expands. |
| `description` | none | Free text the agent sees in `resource_list`. Say what the machine is for. |
| `workspace` | none | Folder on the remote where relative paths of the `file_*` tools start. Without it they start in the home. |
| `hostKey` | none | Fingerprint for strict mode. Without it the first connection is trusted. |
| `allowBlocked` | `[]` | Blocked commands this resource may run anyway. |

In an agent's `agent.yaml`:

```yaml
resources:
  deny: ['gpu-box']
```

| Setting | Default | Meaning |
|---|---|---|
| `resources.deny` | `[]` | Resource names this agent cannot see or use. There is no allow list. |

## Tools

| Tool | Parameters | What it does |
|---|---|---|
| `resource_list` | none | Lists the resources the agent may use: `name`, `type`, `host`, `user`, `description`, `workspace` and `allowBlockedCount`, the number of `allowBlocked` entries. |
| `resource_test` | `name` | Connects, or reuses the open connection, and runs `whoami`, `hostname`, `uname -srm` and `uptime`. Returns `ok`, `whoami`, `hostnameRemote`, `uname`, `uptime` and `ms`, or `error` with the reason. |

There are no `somora` commands and no HTTP routes for resources. You
manage them in the two config files.

## Troubleshooting

**"not configured or denied for this agent".** The name is misspelled,
missing from `config.yaml`, or listed under `resources.deny` of that
agent.

**"cannot read keyfile".** `keyPath` must exist on the somora machine
and be readable by the user somora runs as.

**"host key changed since first connection".** The machine presents a
different key than the stored one. If that is expected, for example
after a reinstall, remove the resource's entry from
`~/.somora/known_hosts.json` and connect again: the new key is stored on
that connection. Or set the new fingerprint as `hostKey`. Neither needs
a restart.

**A granted command is still refused.** Read `blocked_segment` and
`hint` in the result. Usual causes: a wrapper such as `nice` or `env`
in front of the entry, `$(...)` in the same part, or a second blocked
command in the chain.

**A program is missing on the remote.** `file_search` needs `rg`
there, and `tmux` needs tmux.

## See also

- [Security](security.md): the full list of blocked commands and
  protected paths.
- [Files](files.md): the `file_*` tools and the `target` parameter.
- [tmux](tmux.md): long-running terminal sessions on a resource.
- [Tools](tools.md): all tool families at a glance.
- [Agents](agents.md): `agent.yaml`, where `resources.deny` lives.
