# ACP

`somora acp` lets an editor or another agent system talk to one of your
somora agents. It speaks ACP, the Agent Client Protocol, which editors
such as Zed and JetBrains IDEs use for agents, on its input and output.
Behind it, it talks to the running somora server, like the TUI does.

The editor becomes one more window on the agent. The agent keeps its
tools, memory, rules and dream switch, and the conversation is a normal
somora session that you can continue in the web client, on the phone or
in the TUI.

For the other direction, chatting with agents of other systems from
somora, see [External agents](external-agents.md).

## What you get

- **Your agent in the editor.** Text and thinking stream in, and every
  tool call shows with its result.
- **Sessions.** A new conversation in the editor is a new somora
  session named `acp-<date>-<time>`. The editor can list the agent's
  sessions and open earlier ones, with their history replayed.
- **A builder's plan.** When a builder agent updates its task list, the
  editor shows it as the plan.
- **Questions as the editor's dialog.** When a builder asks you
  something, the editor shows its permission dialog with the options.
- **Stop.** Cancelling in the editor stops the turn in somora.
- **Images.** Images you add in the editor reach the agent as
  attachments.
- **The context fill**, when the agent's model reports it.

## Try it

On the machine where somora runs, with the server started:

```bash
somora acp --agent <your-agent>
```

It waits for ACP messages on its input, so on its own it does nothing
visible. Its diagnostics go to the error output; the normal output is
the protocol.

| Option | Meaning |
|---|---|
| `--agent <name>` | The somora agent to talk to. Default: the first agent by name. |
| `--session <name>` | Every new conversation in the editor opens this session (for example `main`) instead of a new one. |

## Zed

In Zed's settings file:

```json
{
  "agent_servers": {
    "somora": {
      "type": "custom",
      "command": "somora",
      "args": ["acp", "--agent", "<your-agent>"],
      "env": {}
    }
  }
}
```

Open the agent panel and start a thread with **somora**. To see the
messages going back and forth, run `dev: open acp logs` from the
command palette.

Other editors with ACP support take the same command and arguments in
their own settings for custom agents.

## From another machine

ACP runs over a process's input and output. If the editor runs on your
laptop and somora on a server, let the editor start `somora acp` over
SSH:

```json
{
  "agent_servers": {
    "somora": {
      "type": "custom",
      "command": "ssh",
      "args": ["<user>@<somora-host>", "somora", "acp", "--agent", "<your-agent>"],
      "env": {}
    }
  }
}
```

Use a key without a passphrase prompt, or an SSH agent, because the
editor cannot answer prompts.

## From OpenClaw (acpx)

OpenClaw drives coding harnesses such as Claude Code or Codex over ACP
with its `acpx` plugin. The same plugin can drive one of your somora
agents: OpenClaw starts `somora acp`, your agent works with its own
tools and memory, and the result goes back to the OpenClaw agent that
asked. Tested with OpenClaw 2026.10.3 and `@openclaw/acpx` 2026.10.3.

For handing an OpenClaw agent's work to somora, [A2A](a2a.md#taking-work-in)
is the simpler route: no install on the OpenClaw machine and no access
key there. Use acpx when OpenClaw should steer a somora agent like a
harness, or bind a conversation to it.

**1. somora on the OpenClaw machine.** `somora acp` runs where the
OpenClaw gateway runs and talks to your somora server over the network.
Install somora there; with npm 11 its install scripts need a
permission:

```bash
npm install -g --allow-scripts=somora,node-pty,ssh2,onnxruntime-node,protobufjs,cpu-features,esbuild somora
```

Give it the server's address and the [access key](security.md): put the
key into `~/.somora/server.key` (mode 600) of the user that runs the
OpenClaw gateway, and the address into the command below. The key opens
somora completely; give it only to a machine you trust as much as your
own.

**2. The acpx plugin.** Install the version that matches your OpenClaw
(the newest one may require a newer OpenClaw), then reload it:

```bash
openclaw plugins install @openclaw/acpx@<your OpenClaw version>
openclaw plugins reload acpx
```

**3. somora as an ACP agent in OpenClaw.** One patch, applied without a
restart:

```json5
// somora-acpx.patch.json5
{
  acp: { enabled: true, backend: "acpx", defaultAgent: "somora", allowedAgents: ["somora"] },
  plugins: { entries: { acpx: { enabled: true, config: { agents: { somora: {
    command: "/usr/bin/env",
    args: ["SOMORA_BASE=https://<host>.<tailnet>.ts.net:18737", "somora", "acp", "--agent", "<your-agent>"],
  } } } } } },
  agents: { entries: {
    somora: { name: "somora", runtime: { type: "acp", acp: { agent: "somora", backend: "acpx", mode: "oneshot" } } },
    main: { subagents: { allowAgents: ["main", "somora"] } },
  } },
}
```

```bash
openclaw config patch --file somora-acpx.patch.json5 --dry-run
openclaw config patch --file somora-acpx.patch.json5
```

| Part | Why |
|---|---|
| `acp.*` | Switches ACP on with acpx as backend. `allowedAgents` lists the harnesses OpenClaw may start; keep your others in it. |
| `plugins.entries.acpx.config.agents.somora` | The command acpx starts. Use the full path to `somora` when the gateway's `PATH` does not have it. |
| `agents.entries.somora` | OpenClaw starts an ACP session only for an agent of its own with that runtime. Without it the spawn fails with `Unknown agent id "somora"`. |
| `agents.entries.main.subagents.allowAgents` | Lets the OpenClaw agent `main` start it. By default an agent may only start itself, so `main` stays in the list. |

**4. Check and use it.** In an OpenClaw chat:

| You type, or the agent calls | What happens |
|---|---|
| `/acp doctor` | Starts `somora acp` once and reports `healthy: yes`. |
| the agent calls `sessions_spawn` with `runtime: "acp"`, `agentId: "somora"`, `mode: "run"` | Your somora agent does the task; the result reaches the OpenClaw agent as a completion message after its turn. |
| `/acp spawn somora --mode persistent --bind here` | The conversation goes to your somora agent until it is closed: several turns, one somora session. |

Each started session is a somora session named `acp-<date>-<time>-…`,
visible in your clients like any other. A session OpenClaw opens and
never writes to (its health check) leaves nothing behind.

**What we saw in the tests:**

- **The stop works across the chain.** Stopping the OpenClaw turn
  cancels your somora agent's turn at once, also mid-command.
- **Bindings and somora's own chat with OpenClaw do not mix.** In a
  conversation bound with `--bind here` that reaches OpenClaw through
  its ACP bridge (your chat with an [external agent](external-agents.md)
  from somora), OpenClaw passed `/acp close` and `/acp cancel` on to the
  somora agent instead of handling them. Only deleting that OpenClaw
  conversation released it. Use bindings in OpenClaw's own channels, and
  `sessions_spawn` from a chat that runs through somora.
- **Late results.** A result OpenClaw delivers after the turn (a
  `sessions_spawn` sub-task that finishes) appears in somora's chat with
  the OpenClaw agent as its own message, marked "sent on its own", see
  [External agents](external-agents.md#messages-it-sends-on-its-own).

Hermes has no counterpart to acpx: it uses ACP only to run Copilot as a
model. For Hermes, use [A2A](a2a.md).

## Server address and key

`somora acp` finds the server like the TUI does: on this machine, port
18737, over HTTPS when `server.tls` is set in `config.yaml`. The
environment variables `SOMORA_BASE`, `SOMORA_HOST`, `SOMORA_PORT` and
`SOMORA_TLS` override that. It uses the [access key](security.md) of
the user it runs as.

## Limits

- One `somora acp` process speaks for one agent.
- External agents cannot be reached through it. Their own systems have
  their own ACP command.
- The editor's file and terminal access is not used: the agent works
  with its own somora tools.
- A turn that is already running in the session (from another client)
  finishes first; the editor's message waits behind it, as in any other
  client.

## See also

- [External agents](external-agents.md): agents of other systems in somora
- [TUI display](display.md): the terminal client
- [Builder agents](builder.md): plans and questions
- [Security](security.md): the access key
