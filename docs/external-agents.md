# External agents

An external agent is an agent of another agent system, such as OpenClaw
or Hermes, that you chat with from somora. It keeps its own model, its
own tools and its own memory. somora carries the conversation, shows it
like any other chat and keeps it as a somora session.

The connection uses ACP, the Agent Client Protocol, an open standard
that many agent systems speak. somora starts the other system's ACP
command, on this machine or over SSH on another one, and talks to it
over that command's input and output.

## What you get

- **A third kind of agent.** Beside chat agents and builders, external
  agents get a tile on the web desktop, an avatar on the phone and a
  place in the TUI. A small sign in the tile corner tells which system
  each one belongs to: 🦞 for OpenClaw, ☤ for Hermes, initials for
  others.
- **Their work, live.** Text, thinking and every tool call the agent
  makes on its side show up in the chat as it happens.
- **Sessions.** Each somora session is its own conversation on the
  other side. Switching sessions, resetting and archiving work as usual.
- **Questions as buttons.** When the agent asks for permission ("may I
  run this command?"), a card with one button per option appears above
  the input in the web client and on the phone. The TUI shows the
  options numbered.
- **Stop.** The stop button cancels the agent's turn on its side.
- **Messages it sends on its own.** Some agents write again after their
  turn ended, for example when a sub-task they started finishes. somora
  keeps listening, see
  [Messages it sends on its own](#messages-it-sends-on-its-own).
- **Nothing to open up.** Over SSH, the agent system needs no open port
  and no API server. somora runs its command like you would in a
  terminal.

## What stays on the other side

An external agent is not a somora agent. Its persona, model, thinking
level, tools, memory and schedules are set on its own system. In
somora:

- the model and thinking menus are hidden for it, and the server
  refuses to change them;
- compaction is its own system's business;
- it does not dream: REM does not read its conversations;
- somora agents hand it work only when it has A2A access, see
  [Let your agents hand it work](#let-your-agents-hand-it-work);
- it gets no access to somora's files or terminal.

## Set it up

Two steps: make the machine reachable, then name the system and its
agents.

### 1. The machine

If the agent system runs on another machine, add that machine as an
SSH [resource](resources.md). Test it once with the resource tools or
`ssh` from the somora server. somora logs in as that user, so the agent
system must be installed and working for that user.

If the machine should be reachable for the external system only, mark
the resource:

```yaml
resources:
  agents-vm:
    type: ssh
    host: <host>
    user: <user>
    keyPath: ~/.ssh/id_ed25519
    externalOnly: true
```

With `externalOnly: true`, somora agents do not see the resource in
`resource_list` and cannot run commands on it. Leave it out when your
agents should also look after that machine.

### 2. The system and its agents

```yaml
external:
  systems:
    openclaw:
      transport: { resource: agents-vm }
      agents:
        claw:
          command: openclaw acp --session agent:main:somora-{session}
          description: OpenClaw on the lab machine
    hermes:
      transport: { resource: agents-vm }
      agents:
        herm:
          command: hermes acp
```

Save `config.yaml`. somora reloads it, and the agents `claw` and `herm`
appear. Send one a message: the first message starts the connection,
which takes a few seconds.

| Key | Meaning |
|---|---|
| `transport` | `{ resource: <name> }` runs the command over SSH on that resource, in a login shell so the user's `PATH` applies. `{ local: true }` runs it on the somora machine. |
| `agents.<name>.command` | The command that starts the agent's ACP side. |
| `agents.<name>.cwd` | Working folder on the agent's machine, sent when a session starts. Default: the user's home. |
| `agents.<name>.icon` | The tile's icon, an emoji. Default: the system's sign. |
| `agents.<name>.description` | One line shown in the agent list. |
| `badge` | The sign in the tile corner: an emoji, a short text, or the path of a small image (png, svg or webp, at most 256 KB) on the somora machine. Default: the known sign of the system, else its initials. |
| `profile` | `openclaw`, `hermes` or `generic`. Default: chosen from the agent's own introduction. |

Agent names must be unique across all systems. A somora agent always
wins: if `~/.somora/agents/<name>/` exists, an external agent of that
name is ignored, and `GET /external` lists it as a clash.

### Placeholders in the command

| Placeholder | Becomes |
|---|---|
| `{session}` | The somora session's id. After a reset it gains `-r1`, `-r2` and so on, so the other side starts a fresh conversation. |
| `{agent}` | The external agent's name in somora. |

OpenClaw keys its conversations by the `--session` value, so the
example gives every somora session its own OpenClaw session with
`{session}`. Hermes creates a session per connection by itself and
needs no placeholder.

### Settings for all systems

```yaml
external:
  idleMinutes: 10
  questionTimeoutMinutes: 10
```

`idleMinutes` closes a connection after that many minutes without a
message. The next message opens it again and resumes the session.
`questionTimeoutMinutes` is how long a question waits for your answer.
Without an answer, somora picks the rejecting option.

## Known systems

| System | Command | Notes |
|---|---|---|
| OpenClaw | `openclaw acp --session agent:<agent-id>:<key>` | Talks to the OpenClaw gateway on the same machine; over SSH no device pairing is needed. Sends the reply as one block, and tool calls live. Reports no token usage. |
| Hermes | `hermes acp` | Needs Hermes with its ACP part installed. Streams text and thinking word by word and reports the context fill, which the chat header shows. |

Other systems that speak ACP work with the generic profile. If one does
something the chat cannot show well, that is what a profile is for.

## Questions and permissions

When the agent asks before it acts, the turn waits. The card above the
input shows the question, how long it still waits, and the options as
buttons: green for allowing, red for rejecting. Answering in one client
closes the card in all of them. In the TUI, type the option's number.

## Messages it sends on its own

An agent can write again after it has answered: OpenClaw reports a
sub-task it started with `sessions_spawn` when the sub-task finishes,
and other systems push reminders or late results the same way. somora
listens on the open connection between turns too:

- What arrives is collected until the agent has been quiet for two
  seconds. Then it appears in the chat as its own message, with the note
  "sent on its own" above it, and with any tool calls the agent made.
- It is saved in the session like any answer. It shows up in every open
  client (web, phone, TUI) and marks the session unread.
- If you send a message while something is still being collected, that
  part is written first, so the order in the session stays right.
- Whatever arrives in the first three seconds after a turn ends counts
  as the end of that turn and is not shown again. Hermes, for example,
  sends a last piece after you stop it.

somora hears the agent only while the connection is open. It closes
after a while without use, see `external.idleMinutes` in
[Settings for all systems](#settings-for-all-systems). Anything the agent
sends after that, it repeats from its own history when you write next.

## Let your agents hand it work

Chat is yours. For your agents to ask an external agent, or send it off
as a sub-agent, the other system needs A2A switched on and the agent an
`a2a` block in `config.yaml`:

```yaml
        claw:
          command: openclaw acp --session agent:main:somora-{session}
          a2a:
            url: https://<machine>.<tailnet>.ts.net
            token: <token>
```

Chat keeps using ACP. Work from your agents travels over A2A, the
standard for agents giving each other tasks. [A2A](a2a.md) explains how
to switch it on in OpenClaw and Hermes, what each can do, and the
brakes. The same page shows the other direction: OpenClaw and Hermes
sending tasks to your somora agents.

## Renaming an external agent

The name in somora is yours to choose; the agent may call itself
something else on its own system. Rename it with
`somora agent rename <old> <new>` or **About… → Rename…** in its window.
That renames its entry in `config.yaml` in place, moves its
conversations, and updates `team.yaml`.
[Renaming an agent](agents.md#renaming-an-agent) lists every place.
Nothing changes on the other system: its sessions there go on as before.

## Troubleshooting

| You see | Meaning |
|---|---|
| "could not be reached: …" with the command's error | The command did not start or ended at once. The text after it is what the agent system printed. Run the command by hand on that machine as that user. |
| A note that the earlier session was gone | The other side no longer had the conversation, for example after its own restart. The chat continues in a new one there. |
| The tile shows initials instead of 🦞 or ☤ | somora did not recognise the system from the command. It does after the first message, or set `profile` or `badge`. |
| The model menu is missing | Expected: the agent's model is set on its own system. |
| A result the agent finishes later, after its turn, is missing | somora shows what the agent sends on its own while the connection is open, see [Messages it sends on its own](#messages-it-sends-on-its-own). After the connection closed for being unused, the agent tells you with your next message. |

The server log names every turn with `external.turn`, including the
time it took, the tool calls and the stop reason.

## Security

- The agent runs with the rights of the SSH user on its machine. What
  it may do there is decided by that machine's setup, not by somora.
  Use a user with only the rights the agent needs.
- somora offers the agent no file or terminal access of its own.
  The agent cannot read somora's files through the connection.
- `externalOnly` keeps a machine that is meant for the external system
  away from somora's own agents.
- Conversations are stored on the somora machine, like every
  other session.

## See also

- [Resources](resources.md): adding the machine the agent system runs on
- [A2A](a2a.md): letting your agents hand external agents work
- [ACP](acp.md): the other direction, somora's agents in an editor
- [Web client](web.md), [Mobile app](mobile.md), [TUI display](display.md)
- [HTTP API](api.md#external-agents): `GET /external` and the question routes
- [Security](security.md)
