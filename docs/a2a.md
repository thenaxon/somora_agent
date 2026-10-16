# A2A

Your somora agents can hand work to agents of other systems, such as
OpenClaw or Hermes. An agent asks an [external agent](external-agents.md)
a question or sends it off as a sub-agent, and gets the result back,
exactly as with a colleague in somora.

The work travels over A2A, the Agent2Agent protocol: an open standard,
stewarded by the Linux Foundation, for agents of different systems giving
each other tasks. Your own chat with an external agent keeps using ACP.

## Inside somora and outside

Agents asking agents is one idea with two ways of travel. Your agents
use the same tools for both and need not know the difference.

| | Between somora agents | From a somora agent to an external agent |
|---|---|---|
| Tools | `agent_ask`, `spawn_subagent`, `builder_dispatch` | `agent_ask`, `spawn_subagent` |
| Way of travel | inside the somora server, no network | A2A over the network |
| Lands in | the target's session (`main`, a named one, or a sub-agent session) | the external agent's session `a2a-<asker>` or a sub-agent session |
| What the asker gets | the answer, `pending` and a wake when it takes longer | the same |
| Pictures | yes | not yet |
| Taking it back | the target is told to stop and finishes its turn | the task is stopped, the other side is asked to stop |
| Guard against waiting in a circle | yes | yes on somora's side, see [Security](#security) |

How agents ask each other inside somora, with every parameter, result
state and the wake, is in [Agents](agents.md#talking-to-another-agent)
and [Sub-agents](agents.md#sub-agents). This page is about the way out:
work for agents of other systems.

## What you get

- **The same tools.** `agent_ask` and `spawn_subagent` work with an
  external agent the way they work with a somora agent. Waiting, "tell me
  later", `agent_ask_result` and waking up on a late answer all behave
  the same.
- **A conversation that remembers.** Each somora agent has its own
  conversation with each external agent. When `nova` asks `claw` again
  tomorrow, `claw` still knows what `nova` asked today. A sub-agent spawn
  starts a fresh conversation every time.
- **Something to read along.** The conversation is a session of the
  external agent in somora. Open it to see what was asked and answered.
- **The team knows them.** Place external agents in your
  [team](team.md) like anyone else. Your agents then see who takes work,
  what for, and how to hand it over.
- **Brakes.** At most two tasks at a time per external agent, 200 a day
  in total, and a time limit per task. All of them are settings.
- **Over the network.** somora talks to the other system's A2A
  endpoint directly, on your LAN or in a Tailscale tailnet. No SSH is
  involved.

## How a task travels

1. A somora agent calls `agent_ask` (or `spawn_subagent`) with an
   external agent's name.
2. somora reads the other system's Agent Card, a small JSON file that
   says where its A2A endpoint is and what it can do.
3. somora sends the task. The first line names who asks, for example
   `[a task from nova (COO), an agent of Max's somora team, sent over
   A2A]`, so the other side knows whom it works for.
4. It follows the task to its end. When the other side streams, the
   answer appears word by word in the session. When it does not, somora
   checks the task's state every few seconds.
5. The answer goes back to the asking agent, as with any `agent_ask`.

| Call | Lands in | Conversation over there |
|---|---|---|
| `agent_ask({ agent: "claw", message })` | `claw`'s session `a2a-<asking agent>`, created on first use | the same one every time |
| `agent_ask({ agent: "claw", session: "research", message })` | `claw`'s session `research` (must exist, or add `create_session: true`) | one per session |
| `spawn_subagent({ persona: "claw", task })` | a new sub-agent session `sub-<asking agent>-…` | a fresh one |

A reset of such a session starts a fresh conversation on the other side
too. These sessions never carry an unread dot. The answer reaches you
through the asking agent, as with sub-agents.

## Set it up

Three steps: switch A2A on in the other system, make it reachable for
the somora machine, and tell somora where it is.

The other system gets one token for somora. somora sends it with every
request, and the other system accepts tasks only with it. Make one with
`openssl rand -hex 32`.

### OpenClaw

OpenClaw 2026.10.3 or newer has the A2A channel built in. It is served
by the OpenClaw gateway, on the gateway's own port, at `/a2a/v1`.

Write the settings to a file, for example `a2a.patch.json5`:

```json5
{
  channels: {
    a2a: {
      enabled: true,
      advertisedUrl: "https://<machine>.<tailnet>.ts.net",
      exposeAgents: ["main"],
      peers: { somora: { token: "<token>" } },
    },
  },
}
```

Then, on the OpenClaw machine:

```bash
openclaw config patch --file a2a.patch.json5 --dry-run
openclaw config patch --file a2a.patch.json5
```

The gateway takes the change without a restart. `exposeAgents` lists the
OpenClaw agents somora may reach. `advertisedUrl` is the address somora
uses, see [Reach it over the network](#reach-it-over-the-network).

### Hermes

Hermes has A2A as a gateway platform (plugin `plugins/platforms/a2a`,
part of Hermes since 0.22). The Hermes gateway must run.

```bash
hermes config set gateway.platforms.a2a.enabled true
hermes config set gateway.platforms.a2a.extra.port 9900
```

Then add to `~/.hermes/.env`:

```bash
A2A_PEER_TOKENS=somora:<token>
A2A_TRUSTED_PEERS=somora
A2A_PUBLIC_URL=https://<machine>.<tailnet>.ts.net:8443
```

`A2A_PEER_TOKENS` gives somora its token, and `A2A_TRUSTED_PEERS` lets
only somora run tasks. Restart the gateway with
`systemctl --user restart hermes-gateway`.

### Reach it over the network

Both systems listen on their own machine only (`127.0.0.1`) unless told
otherwise. The simplest way to reach them from the somora machine is a
Tailscale tailnet: HTTPS with a real certificate, no open port.

| System | Make it reachable | A2A base URL for somora |
|---|---|---|
| OpenClaw | Its gateway does it: `gateway.tailscale.mode: "serve"` in `openclaw.json` (the gateway user needs `sudo tailscale set --operator=$USER` once) | `https://<machine>.<tailnet>.ts.net` |
| Hermes | `tailscale serve --bg --https=8443 http://127.0.0.1:9900` | `https://<machine>.<tailnet>.ts.net:8443` |

Tailscale serves HTTPS on ports 443, 8443 and 10000. Use 8443 when 443
is already taken, for example by the Hermes dashboard.

Without Tailscale, bind the endpoint to the LAN and put an HTTPS proxy
in front of it. OpenClaw: `gateway.bind`. Hermes: `A2A_HOST=<address>`,
which Hermes only allows with a token set.

Check from the somora machine:

```bash
curl https://<machine>.<tailnet>.ts.net/.well-known/agent-card.json
```

The answer is the Agent Card. It names the endpoint under
`supportedInterfaces`.

### Tell somora

In `config.yaml`, give the external agent an `a2a` block:

```yaml
external:
  systems:
    openclaw:
      transport: { resource: agents-vm }
      agents:
        claw:
          command: openclaw acp --session agent:main:somora-{session}
          a2a:
            url: https://<machine>.<tailnet>.ts.net
            token: <token>
    hermes:
      transport: { resource: agents-vm }
      agents:
        herm:
          command: hermes acp
          a2a:
            url: https://<machine>.<tailnet>.ts.net:8443
            token: <token>
```

| Key | Meaning |
|---|---|
| `a2a.url` | Base URL of the agent's A2A side. somora reads the Agent Card from `<url>/.well-known/agent-card.json`. |
| `a2a.token` | The token the other side expects from somora. |

Save. somora reloads the file. An external agent without an `a2a` block
stays a chat partner for you: agents get a clear refusal when they try
to hand it work.

### Try it

Ask one of your agents in its chat:

> Ask claw over agent_ask what the date is on its machine.

The agent's answer comes back within seconds. Open `claw`'s session
`a2a-<your agent>` to see the task as `claw` got it.

## In the team

Add external agents to `team.yaml` like any agent, with `reports_to`,
`title`, `involve_for` and `not_for`. The Team window in the web client
shows them with their system's sign and lets you place them.

What your agents read about them in their team block:

| External agent | Your agents read |
|---|---|
| with A2A access | Under "Who to involve": an external agent, its system, its own memory and tools, no access to yours. Hand it a self-contained task with `agent_ask` or `spawn_subagent` and all the context it needs. Text only, slower than a colleague, and a stop may not reach it. Then its `involve_for` phrases. |
| without A2A access | Chat only: for chatting with you, takes no work from agents, do not involve it. |

The org chart marks both as `(external · OpenClaw)` or the like.
External agents get no team block themselves, because somora's prompt
does not reach them. They learn who asks from the first line of each
task.

## Brakes and timing

| Setting | Default | Meaning |
|---|---|---|
| `external.a2a.maxConcurrentPerAgent` | `2` | Tasks one external agent works on at the same time. More wait in line, and the session says so. |
| `external.a2a.maxCallsPerDay` | `200` | Tasks to all external agents per day, counted from local midnight. The count survives a restart. |
| `external.a2a.maxTaskMinutes` | `60` | How long somora follows a task. After that it stops following and reports the task as failed. |
| `external.a2a.pollMaxSeconds` | `10` | For agents that do not stream: somora checks after 2 seconds, then less often, up to this gap. |
| `external.a2a.cardRefreshMinutes` | `10` | How long a read Agent Card is kept. |
| `external.a2a.introduce` | `true` | The first line of a task names the asking agent and the team. |

The asking agent waits as long as its `agent_ask` allows (`timeout_ms`,
5 minutes by default). When the task takes longer, the agent gets
`pending` and is woken when the answer arrives, as with every
`agent_ask`.

somora cannot see what a task costs on the other side, because neither
system reports tokens over A2A. The brakes therefore count tasks and
time. The other system has its own limits too: Hermes allows 60 requests
a minute and 5 rounds of back and forth per conversation by default,
OpenClaw 30 requests a minute.

## What each system can do

What somora can offer depends on the other side. somora reads it from
the Agent Card and uses the best way each system offers.

| | OpenClaw | Hermes |
|---|---|---|
| Answer comes | when the task is done (somora checks every few seconds) | word by word (stream) |
| Tool calls visible | no | no |
| Stop | refused: the task finishes over there | marked as stopped, the turn there runs on |
| Asking back as an A2A state | no, it says so in its answer | yes |
| Images and files | no | no |
| Memory of the conversation | its own session per sender and conversation | its live session, same memory as its other chats |
| Tasks after its own restart | gone | gone, the conversation stays |

Neither system shows its tool calls over A2A. The session shows the
task, its state (accepted, working, done) and the answer.

## Stopping a task

`agent_ask_cancel`, `subagent_cancel` or the stop button in the external
agent's session stop the task in somora at once. Unlike between somora
agents, taking back an `agent_ask` stops the running task too, because
the other side has no way to read a stop message. somora also sends A2A's `CancelTask`.
The session then says either `claw confirmed the stop` or `claw may
still finish it on its side`. With OpenClaw it is always the second.

## Questions back

An external agent may answer with a question instead of a result (A2A's
`input-required`). The asking agent then gets that question and a note
to reply with `agent_ask` to the same agent in the same session. The
conversation goes on from there. Hermes asks back this way. OpenClaw has no such state: when it needs something,
it says so in its answer.

## Images and files

Not yet: `agent_ask` and `spawn_subagent` refuse images for an external
agent, with a note to describe them in the message. Neither OpenClaw nor
Hermes reads files sent over A2A today.

## Troubleshooting

| You see | Meaning |
|---|---|
| `… without A2A access, so it cannot take work from agents` | The agent has no `a2a` block in `config.yaml`. |
| `agent card at … not reachable` | somora cannot reach the URL. Run the `curl` from [Reach it over the network](#reach-it-over-the-network) on the somora machine. |
| `the other side refused somora's token (HTTP 401)` | The token in `config.yaml` does not match the one the other system has for `somora`. |
| `claw refused the task: …` | The other system turned the task down, for example a message starting with `/`, or a peer it does not trust. |
| `daily limit for external agents reached` | `external.a2a.maxCallsPerDay` is used up. It resets at local midnight. |
| `… did not finish within 60 min` | `external.a2a.maxTaskMinutes` ran out. The task may still finish over there. |
| `waiting for a free slot` in the session | `maxConcurrentPerAgent` tasks are running. This one starts when one finishes. |
| An OpenClaw task stays `working` | OpenClaw waits for an approval in its own interface (for example to run a command). Approve it there. |

The server log names every task with `a2a.task`: agent, session, state,
time and the day's count.

## Security

- **Tokens.** Each system has its own token for somora. It sits in
  `config.yaml` beside your other keys and never appears in logs.
- **Nothing in.** This page is about somora handing work out. The other
  system cannot send tasks to somora's agents over this connection.
- **The other side's rights.** The external agent works with its own
  tools and rights on its own machine. What it may do there is set on
  that system.
- **What leaves.** Everything in a task leaves your machine. Your agents
  are told in their team block that the external agent has no access to
  your files, so they put what it needs into the task.
- **Loops.** A sub-agent cannot use `agent_ask`
  ([sub-agent tool limits](tools.md#other-agents)). Inside somora, the
  wait guard stops two agents from waiting on each other.

## See also

- [External agents](external-agents.md): chatting with them over ACP, and the systems somora knows
- [Team](team.md): placing external agents in the org chart
- [Tools](tools.md#other-agents): `agent_ask`, `spawn_subagent` and their results
- [Agents](agents.md): sub-agents and sessions
- [Security](security.md)
