# A2A

Your somora agents and agents of other systems, such as OpenClaw or
Hermes, can give each other work. A somora agent asks an
[external agent](external-agents.md) a question or sends it off as a
sub-agent and gets the result back. The other way round, an agent of
another system sends one of your somora agents a task and gets its
answer.

The work travels over A2A, the Agent2Agent protocol: an open standard,
stewarded by the Linux Foundation, for agents of different systems giving
each other tasks. Your own chat with an external agent keeps using ACP.

## Tested with

| System | Version | Both directions tested |
|---|---|---|
| OpenClaw | 2026.10.3 | yes; OpenClaw does not collect the answer to work it sends, see [From OpenClaw](#from-openclaw) |
| Hermes | 0.22.2 (2026-09-24) | yes |
| somora | 2026.1016 | |

Both systems change quickly. Where a newer version differs, the settings
on this page may have moved; their own documentation has the current
names.

## Inside somora and outside

Agents asking agents is one idea with two ways of travel. Your agents
use the same tools for both and need not know the difference.

| | Between somora agents | From a somora agent to an external agent |
|---|---|---|
| Tools | `agent_ask`, `spawn_subagent`, `builder_dispatch` | `agent_ask`, `spawn_subagent` |
| Way of travel | inside the somora server, no network | A2A over the network |
| Lands in | the target's session (`main`, a named one, or a sub-agent session) | the external agent's session `a2a-<asker>` or a sub-agent session |
| What the asker gets | the answer, `pending` and a wake when it takes longer | the same |
| Pictures and files | yes | yes: in the message, or as a download link |
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

- **With A2A access**, under "Who to involve": the name, the title and
  the system, such as `claw (Lab assistant; external · OpenClaw)`, then
  its `involve_for` and `not_for` phrases. Below the list, one shared
  note: external agents work in other systems with their own memory and
  tools and no access to yours, so hand them a self-contained task with
  `agent_ask` or `spawn_subagent` and all the context it needs. Text
  only, slower than a colleague, and a stop may not reach them.
- **Without A2A access**, a line `Chat only, do not involve`: they are
  for chatting with you and take no work from agents.

The note is said once for all external agents, because every agent
carries its team block in every turn. The org chart marks external
agents as `(external · OpenClaw)` or the like. `somora team check`
lists them without a block size: they get no team block themselves,
because somora's prompt does not reach them. They learn who asks from
the first line of each task.

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
| Images and files it receives | not read: OpenClaw drops file parts, so somora sends links | named only ("file x, n bytes"), so somora sends links |
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

Both directions carry images and files: PNG, JPEG, GIF, WebP, PDF and
text, the kinds somora keeps as attachments, within the limits under
`attachments` in `config.yaml`.

**Your agents hand a file over.** `images` in `agent_ask` and
`spawn_subagent` work for external agents too. somora reads the other
side's Agent Card (`defaultInputModes`):

- **The card takes the type:** the file goes inside the message, up to
  8 MB.
- **Otherwise:** the task starts with a download link for each file,
  valid for one hour, for example
  `[Files for this task — download links, valid for one hour: - plan.pdf (application/pdf, 240 KB): https://…/a2a/files/…]`.
  The other agent fetches it with its own tools.

OpenClaw 2026.10.3 and Hermes 0.22.2 both take only text in a message, so
they get links. A link needs somora's address from outside:
`a2a.publicUrl` in `config.yaml` (see
[Set up somora as a target](#set-up-somora-as-a-target)). Without it a
task with files is refused with that hint. The session shows how each
file went (`sent to lobo over A2A with 1 as download link`).

**Another system sends a file.** File parts in a task, as bytes or as a
URL, become attachments of the turn, as if you had attached them in the
chat: the agent sees an image, or reads a PDF. A URL is fetched with the
same guard as `web_fetch`: no internal addresses unless
`web.fetchAllowPrivate` lists them. A task of only files is fine.

At most 5 files per message, each within the `attachments` limits. A
bigger request is refused before somora reads it.

**Your agent answers with an image.** An image it makes for a task from
outside goes back with the answer, as a file part with a download link.

**Download links.** `/a2a/files/<token>` serves one file for one hour.
The signed token is the key: it opens that file and nothing else, and
`somora key rotate` ends every link at once.

## Taking work in

The other direction: somora as an A2A agent. Agents you switch on get an
A2A address on somora's own server, and the systems you list as peers
send them tasks. Your agent works on a task like on any message, with
its tools and memory, and the answer goes back to the sender.

- **Only who you list.** Each peer has its own token in `config.yaml`.
  Without peers, nothing is reachable.
- **Only the agents you switch on.** `a2a: true` in the agent's
  `agent.yaml`, or the A2A switch in its Agent window. A builder is never
  reachable this way; editors and other systems reach it with
  [`somora acp`](acp.md).
- **A conversation per sender.** Each peer and conversation is a session
  of its own, `a2a-<peer>-<id>`. You can open and read it; it carries no
  unread dot.
- **Live, and stoppable.** The answer streams back word by word, tool
  calls show as short notes, and a stop from the sender really stops your
  agent's turn.
- **Questions go back.** When your agent asks with `ask_user`, the
  question goes to the sender, which answers in the same conversation.
- **Files both ways.** Images and PDFs a sender attaches reach your
  agent as attachments, and images it makes go back with the answer
  ([Images and files](#images-and-files)).

## Set up somora as a target

### In somora

1. Make a token for each system that may send work:
   `openssl rand -hex 32`.
2. List the systems in `config.yaml`:

```yaml
a2a:
  publicUrl: https://<host>.<tailnet>.ts.net:18737
  peers:
    hermes:
      token: <token for Hermes>
    openclaw:
      token: <token for OpenClaw>
      agents: [nova]                 # optional: only these agents
```

3. Switch on the agents that may be reached: the A2A switch in the
   Agent window, or `a2a: true` in their `agent.yaml`.
4. Check the agent's card from the other machine:

```bash
curl https://<host>.<tailnet>.ts.net:18737/a2a/agents/<agent>/.well-known/agent-card.json
```

| Key | Default | Meaning |
|---|---|---|
| `a2a.publicUrl` | taken from the request | The address the other systems use, as written into the cards. Set it when somora is behind a proxy or the request host is not the one others reach. |
| `a2a.defaultAgent` | none | The agent `/.well-known/agent-card.json` describes, for clients that only look there. |
| `a2a.peers.<name>.token` | required | The token this system sends. At least 16 characters. |
| `a2a.peers.<name>.agents` | every switched-on agent | The agents this system may reach. |
| `a2a.rateLimitPerMinute` | `30` | Requests per minute per peer. Status requests (`GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`) count separately, with four times as many. |
| `a2a.maxTasksPerDay` | `200` | Tasks per peer per day, from local midnight. |
| `a2a.replyTimeoutSeconds` | `300` | How long a waiting request waits for the answer before it returns the task as still working. |
| `a2a.maxMessageChars` | `64000` | Longest task text. |
| `a2a.archiveAfterDays` | `7` | A conversation with a peer is archived after this many days without activity. `0` keeps them. |
| `a2a.tools.deny` | `agent_ask`, `agent_ask_result`, `agent_ask_cancel`, `spawn_subagent`, `spawn_subagents`, `builder_dispatch`, `session_model`, `sentinel` | Tools a task from outside may not use, as in `subagents.tools.deny`. |

The address of an agent is `<publicUrl>/a2a/agents/<agent>`. somora
needs no extra port: the A2A endpoint is part of its server, reachable
wherever the web client is. With a Tailscale certificate
([Setup](setup.md#https-via-tailscale)) it speaks HTTPS.

### From Hermes

Hermes calls other A2A agents with its `a2a_call` tool. Tell it where
somora is, in `~/.hermes/config.yaml`:

```bash
hermes config set a2a_agents.somora.url https://<host>.<tailnet>.ts.net:18737/a2a/agents/<agent>
hermes config set a2a_agents.somora.auth.type bearer
hermes config set a2a_agents.somora.auth.token <token for Hermes>
hermes config set a2a_agents.somora.timeout 300
```

Hermes notes that `a2a_agents` is a section it does not check; the
values are saved anyway. Then switch the `a2a` tools on where Hermes
should use them:

| Where Hermes runs | Command |
|---|---|
| Its own terminal (CLI, TUI) | `hermes tools enable a2a --platform cli` |
| A chat from somora (ACP) | `hermes config set platform_toolsets.acp "[hermes-acp, a2a]"` |
| A messaging platform | `hermes tools enable a2a --platform telegram` (or the platform's name) |

In Hermes 0.22.2, `hermes tools enable` does not know the `acp`
platform, hence the `config set` line. Then ask Hermes: "Use a2a_call
with agent somora and ask: …". Hermes waits for the answer, takes
questions back, and continues a conversation with the same
`context_id`.

### From OpenClaw

OpenClaw sends A2A messages through its A2A channel, to a peer that has
a URL. Add somora's address and token to the peer in `openclaw.json`
(the `somora` peer may already exist for the other direction):

```json5
// somora-out.patch.json5
{ channels: { a2a: { peers: { somora: {
    url: "https://<host>.<tailnet>.ts.net:18737/a2a/agents/<agent>",
    outboundToken: "<token for OpenClaw>",
} } } } }
```

```bash
openclaw config patch --file somora-out.patch.json5
```

The OpenClaw agent then sends with its message tool to the target
`a2a:somora`. The task arrives and your agent answers it. OpenClaw
2026.10.3, however, only hands a message over: it returns at once and
never collects the answer. The answer is in somora's session for that
conversation, not with the OpenClaw agent. For work where OpenClaw
needs the result, let a somora agent ask OpenClaw instead
([Set it up](#set-it-up)).

### Any other A2A client

Every client that speaks A2A 1.0 or 0.3 over JSON-RPC works. A test
with curl:

```bash
curl -X POST https://<host>.<tailnet>.ts.net:18737/a2a/agents/<agent> \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{
       "messageId":"m1","role":"ROLE_USER","contextId":"test",
       "parts":[{"text":"Reply with PONG."}]}}}'
```

## What a task from outside does

1. somora checks the token and the peer's limits and finds the
   conversation's session, `a2a-<peer>-<id>`, or makes it.
2. Your agent gets the text with a line in front that names the sender
   and says it is an outside agent, not you. The session keeps the text
   as sent.
3. The turn runs like any other, with the tools of the agent minus
   `a2a.tools.deny`. By default it cannot ask colleagues, start
   sub-agents, hand a builder an order, switch another session's model
   or set Sentinel triggers, so a task from outside never sets off more
   agent work or leaves schedules behind, and two systems cannot bounce
   work between them.
4. The answer goes back: word by word to a client that streams, or in
   one piece when the turn ends. A client that does not wait gets the
   task as still working and asks for it later.

| The sender does | somora |
|---|---|
| `SendMessage` | waits up to `replyTimeoutSeconds` for the answer, or returns at once with `returnImmediately` |
| `SendStreamingMessage` | streams the state, the answer as it grows, and a note per tool call (`using web_search`) |
| `GetTask`, `ListTasks` | the task's state and answer; a peer only sees its own tasks |
| `SubscribeToTask` | streams the task's changes; at most 10 streams per peer at a time |
| `CancelTask` | stops your agent's turn, also while it is still getting ready; a waiting task is taken out of the line |
| answers a question | the next message in the same conversation is the answer: an option's number or label, or own words. A message that names the task (`taskId`) answers that task's question. |
| sends the same message again (same `messageId`) | the task it started; nothing runs twice |

Messages in the same conversation wait for each other, like messages you
type while the agent works. Tasks in different conversations run side by
side. After a restart of somora the answer is still in the session.
Each peer gets one entry a day in the web client's inbox, saying how
many tasks it sent.

somora keeps tasks for 24 hours, at most 500. Finished ones make way for
new ones; while 500 are still open, a new task is refused (HTTP 429).

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
| A sender gets HTTP 401 `unauthorized` | Its token is not one of `a2a.peers`. |
| A sender gets `no A2A agent '<name>' here` | The agent is not switched on, is a builder, or the peer's `agents` list leaves it out. |
| A sender gets HTTP 429 | `a2a.rateLimitPerMinute` or `a2a.maxTasksPerDay` for that peer, 10 open streams, or 500 open tasks. The message says which. |
| A sender gets HTTP 413 | The request is bigger than 5 files at the `attachments` limits allow. |
| The card is not found at all | No peers in `config.yaml`: then nothing is reachable. |
| Hermes says it has no `a2a_call` | The `a2a` tools are not on for the place it runs, see [From Hermes](#from-hermes). |

The server log names every task to an external agent with `a2a.task`,
and every task from outside with `a2a.inbound_accepted` and
`a2a.inbound` (peer, agent, session, state, time). Refused tokens are
logged as `a2a.inbound_refused`.

## Security

- **Tokens.** Each system has its own token for somora. It sits in
  `config.yaml` beside your other keys and never appears in logs.
- **What comes in.** Only peers with a token in `a2a.peers` can send
  tasks, only to agents switched on for them. Wrong tokens count against
  their address: after 10 in a minute, wrong tries from there wait a
  minute. A right token always passes. The cards are public, as the standard wants: anyone who
  reaches the server sees which agents are switched on and their
  descriptions.
- **The login key stays apart.** A peer's token opens the A2A endpoint
  and nothing else in somora. The A2A paths are the only ones the login
  key does not guard, and they check the peer tokens themselves.
- **What a task may do.** A task from outside runs with the agent's
  tools minus `a2a.tools.deny`. The agent is told the sender is an
  outside agent, not you. Narrow the list further when an agent should
  not, for example, run commands for other systems.
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
