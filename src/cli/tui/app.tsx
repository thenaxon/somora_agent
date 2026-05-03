import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';

import { Api } from './api.ts';
import { openStream, type StreamHandle } from './stream.ts';
import { matchCommands, runCommand } from './commands.ts';
import { Header } from './header.tsx';
import { Footer } from './footer.tsx';
import { Separator } from './separator.tsx';
import { SlashAutocomplete } from './autocomplete.tsx';
import { AgentBody, TurnView } from './turn-views.tsx';
import { nextId, summarize } from './format.ts';
import type { AgentInfo, StreamEvent, Turn, TurnStats } from './types.ts';

interface Props {
  base: string;
  initialAgent: string;
  initialSession: string;
  initialShowMemory: boolean;
  initialShowTools: boolean;
}

const HISTORY_MAX = 100;

export function App({
  base,
  initialAgent,
  initialSession,
  initialShowMemory,
  initialShowTools,
}: Props) {
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
  const [agentIcons, setAgentIcons] = useState<Record<string, string>>({});
  const [showMemory, setShowMemory] = useState(initialShowMemory);
  const [showTools, setShowTools] = useState(initialShowTools);
  // Refs so the SSE handler always sees the current toggle without
  // re-subscribing the stream on every flip.
  const showMemoryRef = useRef(showMemory);
  const showToolsRef = useRef(showTools);
  useEffect(() => {
    showMemoryRef.current = showMemory;
  }, [showMemory]);
  useEffect(() => {
    showToolsRef.current = showTools;
  }, [showTools]);

  // Submit-history (newest at the end). Up/Down step through it.
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [historyDraft, setHistoryDraft] = useState<string>('');

  // Slash-autocomplete: matched against the input prefix, only when the
  // input is a single token starting with `/`. Index is the highlighted
  // suggestion (Tab cycles).
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);

  const agentIcon = agentIcons[agent] ?? '';

  const slashMatches = useMemo(() => {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return [];
    if (trimmed.includes(' ')) return []; // user is typing args, hide popup
    return matchCommands(trimmed);
  }, [input]);

  const safeAutocompleteIndex =
    slashMatches.length > 0 ? autocompleteIndex % slashMatches.length : 0;

  // Reset highlight to first match whenever the match-set changes (typing
  // narrows the list).
  useEffect(() => {
    setAutocompleteIndex(0);
  }, [slashMatches.length, slashMatches[0]?.name]);

  // Fetch agents on mount and whenever we switch — populates icon-by-name
  // map. Cheap call, the listing is tiny.
  useEffect(() => {
    let cancelled = false;
    apiRef.current
      .fetchAgents()
      .then((list: AgentInfo[]) => {
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const a of list) if (a.icon) next[a.name] = a.icon;
        setAgentIcons(next);
      })
      .catch(() => {
        /* leave icons empty if endpoint is unreachable */
      });
    return () => {
      cancelled = true;
    };
  }, [agent]);

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
        // Display-only suppression. The injection itself already happened
        // server-side; we just don't render the [memory · …] line.
        if (!showMemoryRef.current) return;
        appendTurn({
          kind: 'memory',
          id: nextId(),
          count: ev.count,
          topScore: ev.topScore,
          refs: ev.refs,
        });
        return;
      case 'tool': {
        // Display-only suppression. Same caveat as memory: the tool ran,
        // we just hide the call/result line.
        if (!showToolsRef.current) return;
        const phase: 'call' | 'result' | 'error' =
          ev.phase === 'call' || ev.phase === 'result' || ev.phase === 'error'
            ? ev.phase
            : 'result';
        appendTurn({
          kind: 'tool',
          id: nextId(),
          tool: ev.tool,
          phase,
          summary: ev.summary,
          error: phase === 'error' ? summarize(ev.error, 200) : undefined,
        });
        return;
      }
    }
  }

  function pushHistory(text: string): void {
    setHistory((prev) => {
      // Don't add a literal duplicate of the most recent entry.
      if (prev[prev.length - 1] === text) return prev;
      const next = [...prev, text];
      return next.length > HISTORY_MAX ? next.slice(next.length - HISTORY_MAX) : next;
    });
    setHistoryIndex(null);
    setHistoryDraft('');
  }

  // Wraps setInput so any modification while history-navigating clears the
  // history-cursor — typing breaks you out of the history walk.
  function handleInputChange(next: string): void {
    if (historyIndex !== null && next !== history[historyIndex]) {
      setHistoryIndex(null);
    }
    setInput(next);
  }

  // useInput captures every keypress. ink-text-input also reads stdin and
  // handles its own keys (typing, left/right, backspace, enter); we only
  // react to keys it doesn't touch (Tab, Up, Down, Esc, Ctrl+C/L).
  useInput((char, key) => {
    // Tab: cycle through autocomplete + replace input with selected command
    if (key.tab && slashMatches.length > 0) {
      const dir = key.shift ? -1 : 1;
      const next =
        (safeAutocompleteIndex + dir + slashMatches.length) % slashMatches.length;
      setAutocompleteIndex(next);
      const picked = slashMatches[next];
      if (picked) setInput(picked.name + ' ');
      return;
    }
    // Esc: clear the input. This naturally hides the autocomplete popup
    // too (no `/` prefix → matchCommands returns []).
    if (key.escape) {
      if (input.length > 0) {
        setInput('');
        setHistoryIndex(null);
      }
      return;
    }
    // History navigation
    if (key.upArrow && history.length > 0) {
      if (historyIndex === null) {
        setHistoryDraft(input);
        const idx = history.length - 1;
        setHistoryIndex(idx);
        setInput(history[idx] ?? '');
      } else if (historyIndex > 0) {
        const idx = historyIndex - 1;
        setHistoryIndex(idx);
        setInput(history[idx] ?? '');
      }
      return;
    }
    if (key.downArrow && historyIndex !== null) {
      if (historyIndex < history.length - 1) {
        const idx = historyIndex + 1;
        setHistoryIndex(idx);
        setInput(history[idx] ?? '');
      } else {
        setHistoryIndex(null);
        setInput(historyDraft);
      }
      return;
    }
    // Ctrl+C: first press soft-cancels (clear input / close popup), second
    // press exits when there's nothing to clear.
    if (key.ctrl && char === 'c') {
      if (input.length > 0) {
        setInput('');
        setHistoryIndex(null);
        return;
      }
      exit();
      return;
    }
  });

  async function handleSubmit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput('');
    pushHistory(trimmed);
    if (trimmed.startsWith('/')) {
      try {
        const actions = await runCommand(trimmed, {
          api: apiRef.current,
          agent,
          session,
          showMemory,
          showTools,
        });
        for (const a of actions) {
          if (a.kind === 'notice') {
            appendTurn({ kind: 'system', id: nextId(), text: a.text, tone: a.tone });
          } else if (a.kind === 'exit') {
            exit();
          } else if (a.kind === 'switchTo') {
            setStats(null);
            setStreamingText('');
            setStreaming(false);
            setAgent(a.agent);
            setSession(a.session);
          } else if (a.kind === 'clearStats') {
            setStats(null);
          } else if (a.kind === 'setShow') {
            if (a.target === 'memory') setShowMemory(a.value);
            else setShowTools(a.value);
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

  const agentTag = agentIcon ? `${agentIcon} ${agent}` : agent;

  return (
    <Box flexDirection="column">
      {/* Scrollback: every finalized turn flushes to terminal scrollback once
          via Static, then is owned by the terminal — older messages scroll
          up and out as new ones arrive. The dynamic frame below stays put. */}
      <Static items={turns}>
        {(turn) => <TurnView key={turn.id} turn={turn} agentName={agent} agentIcon={agentIcon} />}
      </Static>

      {streamingText.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>
            {agentTag}
          </Text>
          <AgentBody text={streamingText} />
        </Box>
      ) : null}

      {/* Bottom panel: separator → status → autocomplete (if any) → input →
          hints. Stays anchored to the bottom of the visible terminal frame
          because nothing below it ever changes height except the
          autocomplete popup. */}
      <Box marginTop={1}>
        <Separator />
      </Box>
      <Header
        agent={agent}
        agentIcon={agentIcon}
        session={session}
        stats={stats}
        streaming={streaming}
        connected={connected}
        showMemory={showMemory}
        showTools={showTools}
      />
      <SlashAutocomplete matches={slashMatches} selectedIndex={safeAutocompleteIndex} />
      <Box>
        <Text color="cyan">{'> '}</Text>
        <TextInput
          value={input}
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          placeholder={busy ? '(waiting for response…)' : ''}
          showCursor={!busy}
        />
      </Box>
      <Footer />
    </Box>
  );
}
