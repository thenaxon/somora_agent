// Rename an agent from its window (docs/agents.md#renaming-an-agent): type
// the new name, see what would change, then rename. The server does the
// work; afterwards the desktop closes the agent's windows and reloads, so
// nothing keeps pointing at the old name.

import { useState } from 'react';
import { AlertTriangle, Check, PencilLine } from 'lucide-react';
import { api, type RenameReport } from '../lib/api';

export const AGENT_RENAMED_EVENT = 'somora:agent-renamed';

export function RenameAgent({ agentName }: { agentName: string }) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [plan, setPlan] = useState<RenameReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.renameAgent(agentName, to.trim(), dryRun);
      if (dryRun) setPlan(r);
      else window.dispatchEvent(new CustomEvent(AGENT_RENAMED_EVENT, { detail: { from: agentName, to: r.to } }));
    } catch (err) {
      setError((err as Error).message);
      setPlan(null);
    } finally {
      setBusy(false);
    }
  };

  const btn: React.CSSProperties = { background: 'var(--bg-2)', border: '1px solid var(--bg-3)', borderRadius: 6, padding: '4px 10px', color: 'var(--text-1)', cursor: 'pointer', fontSize: 12 };
  if (!open) {
    return (
      <button type="button" data-testid="agent-rename-open" style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setOpen(true)}>
        <PencilLine size={12} /> Rename…
      </button>
    );
  }
  return (
    <div data-testid="agent-rename" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 10px', border: '1px solid var(--bg-3)', borderRadius: 8, background: 'var(--bg-1)', maxWidth: 560 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-1)' }}>Rename <b>{agentName}</b> to</span>
        <input
          data-testid="agent-rename-input"
          value={to}
          autoFocus
          onChange={(e) => {
            setTo(e.target.value.toLowerCase());
            setPlan(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && to.trim()) void run(plan === null);
            if (e.key === 'Escape') setOpen(false);
          }}
          placeholder="new-name"
          style={{ background: 'var(--bg-0)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 8px', color: 'var(--text-0)', fontSize: 12, width: 160 }}
        />
        {plan === null ? (
          <button type="button" data-testid="agent-rename-check" style={btn} disabled={busy || !to.trim()} onClick={() => void run(true)}>
            Check
          </button>
        ) : (
          <button type="button" data-testid="agent-rename-go" style={{ ...btn, background: 'var(--accent)', color: 'var(--on-accent)', borderColor: 'var(--accent)' }} disabled={busy} onClick={() => void run(false)}>
            <Check size={12} className="icon-inline" /> Rename
          </button>
        )}
        <button type="button" style={btn} onClick={() => { setOpen(false); setPlan(null); setError(null); }}>
          Cancel
        </button>
      </div>
      {error && (
        <div style={{ fontSize: 12, color: 'var(--danger)' }}>
          <AlertTriangle size={12} className="icon-inline" /> {error}
        </div>
      )}
      {plan && (
        <div data-testid="agent-rename-plan" style={{ fontSize: 12, color: 'var(--text-1)', lineHeight: 1.5 }}>
          <div>This changes:</div>
          <ul style={{ margin: '2px 0 0 18px', padding: 0 }}>{plan.changes.map((c) => <li key={c}>{c}</li>)}</ul>
          {plan.warnings.length > 0 && (
            <>
              <div style={{ marginTop: 6, color: 'var(--warn)' }}>Left as written — look at these yourself:</div>
              <ul style={{ margin: '2px 0 0 18px', padding: 0, color: 'var(--text-2)' }}>{plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </>
          )}
          <div style={{ marginTop: 6, color: 'var(--text-2)' }}>The agent's windows close and the desktop reloads afterwards.</div>
        </div>
      )}
    </div>
  );
}
