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
