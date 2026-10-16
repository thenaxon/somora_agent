// The Agent window for an external agent (docs/external-agents.md): what
// it is and how somora reaches it — system, version, where its command
// runs, open connections, what it offers. Persona files, abilities and
// dreaming belong to its own system, so there is nothing to edit here.

import { RenameAgent } from './RenameAgent';
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, type ExternalAgentMark, type ExternalStatus } from '../lib/api';

const mono: React.CSSProperties = { fontFamily: '"JetBrains Mono", monospace' };
const label: React.CSSProperties = { ...mono, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-2)', paddingRight: 14, verticalAlign: 'top', whiteSpace: 'nowrap' };
const cell: React.CSSProperties = { fontSize: 12.5, color: 'var(--text-0)', paddingBottom: 6, wordBreak: 'break-word' };

function fmtIdle(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

export function ExternalAgentPanel({ agentName, mark }: { agentName: string; mark: ExternalAgentMark }) {
  const [status, setStatus] = useState<ExternalStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    api
      .external()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  };
  useEffect(load, [agentName]);
  const system = status?.systems.find((s) => s.agents.some((a) => a.name === agentName));
  const me = system?.agents.find((a) => a.name === agentName);
  const caps = (me?.capabilities ?? {}) as { promptCapabilities?: { image?: boolean }; sessionCapabilities?: Record<string, unknown>; loadSession?: boolean };
  const where = system ? ('local' in system.transport ? 'this machine' : `resource ${system.transport.resource} (over ssh)`) : '…';
  const offers = [
    caps.promptCapabilities?.image ? 'images' : null,
    caps.sessionCapabilities?.list ? 'session list' : null,
    caps.sessionCapabilities?.resume || caps.loadSession ? 'resume' : null,
  ].filter(Boolean);
  return (
    <div data-testid="external-agent-panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 26 }} aria-hidden="true">
          {mark.badgeImage ? <img src={mark.badgeImage} alt="" style={{ width: 26, height: 26 }} /> : mark.badge}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-0)' }}>{agentName}</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
            external agent · {mark.label}
            {mark.version ? ` ${mark.version}` : ''}
          </div>
        </div>
        <button type="button" onClick={load} title="Reload" style={{ background: 'var(--bg-2)', border: '1px solid var(--bg-3)', borderRadius: 6, padding: '5px 8px', color: 'var(--text-1)', cursor: 'pointer' }}>
          <RefreshCw size={13} />
        </button>
      </div>
      <RenameAgent agentName={agentName} />
      <div style={{ fontSize: 12.5, color: 'var(--text-1)', lineHeight: 1.5, maxWidth: 560 }}>
        This agent lives in another agent system. It brings its own model, tools and memory; somora carries the
        conversation (ACP, the Agent Client Protocol) and keeps it as a somora session. Its persona, abilities and
        dreaming are set on its own system.
      </div>
      {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
      <table style={{ borderCollapse: 'collapse' }}>
        <tbody>
          <tr><td style={label}>system</td><td style={cell}>{mark.system}</td></tr>
          <tr><td style={label}>runs on</td><td style={cell}>{where}</td></tr>
          <tr><td style={label}>reports</td><td style={cell}>{me?.agentInfo ? `${me.agentInfo.title ?? me.agentInfo.name ?? ''} ${me.agentInfo.version ?? ''}`.trim() : 'not connected yet — send it a message'}</td></tr>
          <tr><td style={label}>profile</td><td style={cell}>{me?.profile ?? '—'}</td></tr>
          <tr><td style={label}>offers</td><td style={cell}>{offers.length ? offers.join(' · ') : '—'}</td></tr>
          <tr>
            <td style={label}>open</td>
            <td style={cell}>
              {me && me.connections.length > 0
                ? me.connections.map((c, i) => (
                    <div key={i} style={mono}>
                      {c.sessionId ?? '—'} · idle {fmtIdle(c.idleMs)}
                    </div>
                  ))
                : `no open connection (closes after ${status?.idleMinutes ?? 10} min without a message)`}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
