// Root component of the somora mobile PWA. Owns the active-agent
// state AND the chat-stream hook so it's instantiated exactly once
// per active agent (no duplicate SSE subscriptions in children).

import { useEffect, useState } from 'react';
import { AvatarRow } from './AvatarRow';
import { ChatArea } from './ChatArea';
import { MessageInput } from './MessageInput';
import { useAgents } from '../hooks/useAgents';
import { useLastAgent } from '../hooks/useLastAgent';
import { useChatStream } from '../hooks/useChatStream';
import { Koala } from './Koala';

export function MobileApp() {
  const { agents, loading, error } = useAgents();
  const [lastAgent, setLastAgent] = useLastAgent();
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const chat = useChatStream(activeAgent);

  useEffect(() => {
    if (activeAgent || agents.length === 0) return;
    const fromLast = lastAgent && agents.find((a) => a.name === lastAgent)
      ? lastAgent
      : null;
    setActiveAgent(fromLast ?? agents[0]!.name);
  }, [agents, lastAgent, activeAgent]);

  const switchAgent = (name: string) => {
    setActiveAgent(name);
    setLastAgent(name);
  };

  return (
    <div className="mobile-shell">
      <header className="mobile-header">
        <span className="mobile-header-mark">
          <Koala size={26} />
        </span>
        <span className="mobile-header-title">
          {activeAgent ?? 'somora'}
        </span>
        <span className="mobile-header-meta">main</span>
      </header>

      {error && <div className="banner error">{error}</div>}
      {loading && agents.length === 0 && (
        <div className="banner info">Lade agents…</div>
      )}

      <AvatarRow
        agents={agents}
        activeAgent={activeAgent}
        onSelect={switchAgent}
      />

      {activeAgent ? (
        <>
          <ChatArea
            agent={activeAgent}
            messages={chat.messages}
            connectionError={chat.connectionError}
            streaming={chat.streaming}
          />
          <MessageInput
            agent={activeAgent}
            onSend={chat.send}
          />
        </>
      ) : (
        <div className="chat-empty">
          {agents.length === 0 && !loading
            ? 'Keine agents auf diesem somora konfiguriert.'
            : 'Wähle einen agent oben.'}
        </div>
      )}
    </div>
  );
}
