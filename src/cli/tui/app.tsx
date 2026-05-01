import { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp } from 'ink';
import TextInput from 'ink-text-input';

import { Api } from './api.ts';
import { openStream, type StreamHandle } from './stream.ts';
import { runCommand } from './commands.ts';
import { Header } from './header.tsx';
import { Footer } from './footer.tsx';
import { TurnView } from './turn-views.tsx';
import { nextId, summarize } from './format.ts';
import type { StreamEvent, Turn, TurnStats } from './types.ts';

interface Props {
  base: string;
  initialAgent: string;
  initialSession: string;
}

export function App({ base, initialAgent, initialSession }: Props) {
  const { exit } = useApp();
  const apiRef = useRef(new Api(base));

  const [agent, setAgent] = useState(initialAgent);
  const [session, setSession] = useState(initialSession);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streamingText, setStreamingText] = useState<string>('');
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState<TurnStats | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  // SSE lifecycle: open on (agent, session) change, close on unmount.
  useEffect(() => {
    let cancelled = false;
    const handle: StreamHandle = openStream(
      apiRef.current.streamUrl(agent, session),
      (text, tone) => {
        if (cancelled) return;
        appendTurn({ kind: 'system', id: nextId(), text, tone });
      },
    );

    (async () => {
      for await (const ev of handle.events) {
        if (cancelled) break;
        applyEvent(ev);
      }
    })().catch(() => {
      /* iterator close — nothing to do */
    });

    return () => {
      cancelled = true;
      handle.close();
      setConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, session]);

  function appendTurn(t: Turn): void {
    setTurns((prev) => [...prev, t]);
  }

  function applyEvent(ev: StreamEvent): void {
    switch (ev.kind) {
      case 'connected':
        setConnected(true);
        return;
      case 'agent-start':
        setStreaming(true);
        setStreamingText('');
        return;
      case 'chat-delta':
        setStreamingText(ev.text);
        return;
      case 'chat-final':
        setStreamingText(ev.text);
        return;
      case 'agent-end': {
        // Move streamingText into a finalized agent turn.
        setStreamingText((current) => {
          if (current.length > 0) {
            appendTurn({ kind: 'agent', id: nextId(), text: current });
          }
          return '';
        });
        setStreaming(false);
        setBusy(false);
        if (ev.usage || ev.contextWindow || ev.provider || ev.model) {
          setStats({
            tokensIn: ev.usage?.tokens_in ?? 0,
            tokensInCached: ev.usage?.tokens_in_cached ?? null,
            tokensOut: ev.usage?.tokens_out ?? 0,
            contextWindow: ev.contextWindow ?? null,
            provider: ev.provider ?? null,
            model: ev.model ?? null,
          });
        }
        return;
      }
      case 'memory':
        appendTurn({
          kind: 'memory',
          id: nextId(),
          count: ev.count,
          topScore: ev.topScore,
          refs: ev.refs,
        });
        return;
      case 'tool': {
        const phase: 'call' | 'result' | 'error' =
          ev.phase === 'call' || ev.phase === 'result' || ev.phase === 'error'
            ? ev.phase
            : 'result';
        appendTurn({
          kind: 'tool',
          id: nextId(),
          tool: ev.tool,
          phase,
          input: phase === 'call' ? summarize(ev.input, 200) : undefined,
          output: phase === 'result' ? summarize(ev.output, 200) : undefined,
          error: phase === 'error' ? summarize(ev.error, 200) : undefined,
        });
        return;
      }
    }
  }

  async function handleSubmit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput('');
    if (trimmed.startsWith('/')) {
      try {
        const actions = await runCommand(trimmed, {
          api: apiRef.current,
          agent,
          session,
        });
        for (const a of actions) {
          if (a.kind === 'notice') {
            appendTurn({ kind: 'system', id: nextId(), text: a.text, tone: a.tone });
          } else if (a.kind === 'exit') {
            exit();
          } else if (a.kind === 'switchTo') {
            // Clearing stats + streamingText happens implicitly via state
            // changes triggered by the agent/session deps in useEffect.
            setStats(null);
            setStreamingText('');
            setStreaming(false);
            setAgent(a.agent);
            setSession(a.session);
          } else if (a.kind === 'clearStats') {
            setStats(null);
          }
        }
      } catch (err) {
        appendTurn({
          kind: 'system',
          id: nextId(),
          text: `command failed: ${(err as Error).message}`,
          tone: 'error',
        });
      }
      return;
    }
    appendTurn({ kind: 'user', id: nextId(), text: trimmed });
    setBusy(true);
    try {
      await apiRef.current.send(agent, session, trimmed);
    } catch (err) {
      appendTurn({
        kind: 'system',
        id: nextId(),
        text: `send failed: ${(err as Error).message}`,
        tone: 'error',
      });
      setBusy(false);
    }
  }

  return (
    <Box flexDirection="column">
      <Header
        agent={agent}
        session={session}
        stats={stats}
        streaming={streaming}
        connected={connected}
      />

      {/* Static logs every finalized turn exactly once. The terminal's own
          scrollback handles history; Ink only re-renders the dynamic part
          below. */}
      <Static items={turns}>{(turn) => <TurnView key={turn.id} turn={turn} agentName={agent} />}</Static>

      {streamingText.length > 0 ? (
        <Box marginTop={1} flexDirection="row">
          <Text color="cyan" bold>
            {agent.padEnd(6)}
          </Text>
          <Box flexDirection="column" flexGrow={1}>
            <Text>{streamingText}</Text>
          </Box>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color="cyan">{'> '}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={busy ? '(waiting for response…)' : ''}
          showCursor={!busy}
        />
      </Box>

      <Footer />
    </Box>
  );
}
