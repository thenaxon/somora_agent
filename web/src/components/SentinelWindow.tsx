// Sentinel tab — admin/inspector for the proactive trigger runtime.
// Two views:
//   1. List: name / schedule / owner / next-fire / fire-count / status
//   2. Detail: full config + history + action buttons (test / pause /
//      resume / delete)
//
// This is NOT a notification channel — agents do their work in their
// own chat sessions, that's where you read the results. Sentinel-tab
// is "what autonomous workflows are running, are they healthy, do I
// want to pause one?"

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  Zap,
} from 'lucide-react';
import { api, type SentinelTrigger, type SentinelFireEntry } from '../lib/api';

const POLL_INTERVAL_MS = 5_000;

export function SentinelWindow() {
  const [triggers, setTriggers] = useState<SentinelTrigger[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<SentinelFireEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.sentinelList();
      setTriggers(r.triggers);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const refreshHistory = useCallback(async (id: string) => {
    try {
      const entries = await api.sentinelHistory(id);
      setHistory(entries);
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (selected) void refreshHistory(selected);
    else setHistory(null);
  }, [selected, refreshHistory]);

  const selectedTrigger = useMemo(
    () => (selected ? triggers?.find((t) => t.id === selected) ?? null : null),
    [selected, triggers],
  );

  const handleAction = useCallback(
    async (action: 'pause' | 'resume' | 'delete' | 'test', id: string) => {
      try {
        if (action === 'pause') await api.sentinelPause(id);
        else if (action === 'resume') await api.sentinelResume(id);
        else if (action === 'delete') {
          if (!confirm(`Delete trigger '${id}'? This removes its history.`)) return;
          await api.sentinelDelete(id);
          if (selected === id) setSelected(null);
        } else if (action === 'test') {
          await api.sentinelTest(id);
          // Re-fetch history shortly after the test fire dispatches.
          setTimeout(() => {
            void refreshHistory(id);
            void refresh();
          }, 1500);
        }
        void refresh();
      } catch (err) {
        alert(`${action} failed: ${(err as Error).message}`);
      }
    },
    [refresh, refreshHistory, selected],
  );

  return (
    <div
      style={{
        display: 'flex',
        height: '100%',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 11,
      }}
    >
      {/* List panel */}
      <div
        style={{
          width: selectedTrigger ? '45%' : '100%',
          borderRight: selectedTrigger ? '1px solid var(--line)' : 'none',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            borderBottom: '1px solid var(--line)',
            color: 'var(--text-2)',
          }}
        >
          <span>
            {triggers === null
              ? 'loading…'
              : triggers.length === 0
                ? 'no triggers'
                : `${triggers.length} trigger${triggers.length === 1 ? '' : 's'}`}
          </span>
          <button
            type="button"
            onClick={() => void refresh()}
            title="refresh"
            style={{
              all: 'unset',
              cursor: 'pointer',
              color: 'var(--text-3)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <RefreshCw size={11} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
          {error && (
            <div style={{ color: 'var(--danger)', fontSize: 11, padding: 8 }}>{error}</div>
          )}
          {triggers === null && !error ? (
            <div style={{ color: 'var(--text-3)', textAlign: 'center', padding: 24 }}>
              loading…
            </div>
          ) : triggers && triggers.length === 0 ? (
            <div style={{ color: 'var(--text-3)', textAlign: 'center', padding: 24 }}>
              <div>no triggers installed</div>
              <div style={{ marginTop: 8 }}>
                ask an agent to set one up:
                <br />
                <em style={{ color: 'var(--text-2)' }}>
                  "erinner mich morgen 10 Uhr…"
                </em>
              </div>
            </div>
          ) : (
            (triggers ?? []).map((t) => (
              <TriggerRow
                key={t.id}
                trigger={t}
                selected={t.id === selected}
                onSelect={() => setSelected(t.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* Detail panel */}
      {selectedTrigger && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <DetailPanel
            trigger={selectedTrigger}
            history={history}
            onAction={(act) => void handleAction(act, selectedTrigger.id)}
            onClose={() => setSelected(null)}
          />
        </div>
      )}
    </div>
  );
}

function TriggerRow({
  trigger,
  selected,
  onSelect,
}: {
  trigger: SentinelTrigger;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        cursor: 'pointer',
        padding: '8px 10px',
        borderRadius: 4,
        marginBottom: 4,
        background: selected ? 'var(--bg-2)' : 'var(--bg-3)',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--line-2)'}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <StatusIcon status={trigger.status} />
        <span style={{ color: 'var(--text-1)', fontWeight: 600 }}>{trigger.name}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-3)', fontSize: 10 }}>
          {trigger.fireCount}× fired
        </span>
      </div>
      <div style={{ color: 'var(--text-2)', fontSize: 10 }}>{describeSource(trigger)}</div>
      <div style={{ color: 'var(--text-3)', fontSize: 10 }}>
        owner: <strong style={{ color: 'var(--text-2)' }}>{trigger.ownerAgent}</strong>
        {trigger.ownerAgent !== trigger.dispatch.agent && (
          <>
            {' '}
            → dispatches to <strong style={{ color: 'var(--text-2)' }}>{trigger.dispatch.agent}</strong>
          </>
        )}
        {' · '}session: {trigger.dispatch.session}
      </div>
      {trigger.nextFireAt && (
        <div style={{ color: 'var(--text-3)', fontSize: 10 }}>
          next: {formatAbsolute(trigger.nextFireAt)} ({formatRelativeFuture(trigger.nextFireAt)})
        </div>
      )}
      {trigger.statusReason && (
        <div style={{ color: 'var(--danger)', fontSize: 10 }}>
          {trigger.statusReason}
        </div>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: SentinelTrigger['status'] }) {
  switch (status) {
    case 'active':
      return <Clock size={12} style={{ color: 'var(--accent)' }} />;
    case 'paused':
      return <Pause size={12} style={{ color: 'var(--text-3)' }} />;
    case 'error':
      return <AlertTriangle size={12} style={{ color: 'var(--danger)' }} />;
    case 'completed':
      return <CheckCircle2 size={12} style={{ color: 'var(--text-3)' }} />;
  }
}

function describeSource(t: SentinelTrigger): string {
  if (t.source.type !== 'time') return t.source.type;
  const s = t.source.spec;
  switch (s.type) {
    case 'at':
      return `Once at ${formatAbsolute(s.iso)}`;
    case 'every':
      return `Every ${s.interval}`;
    case 'daily':
      return `Daily at ${s.time}`;
    case 'weekly':
      return `Weekly on ${s.day} at ${s.time}`;
    case 'cron':
      return `Cron "${s.expression}"`;
  }
}

function DetailPanel({
  trigger,
  history,
  onAction,
  onClose,
}: {
  trigger: SentinelTrigger;
  history: SentinelFireEntry[] | null;
  onAction: (action: 'pause' | 'resume' | 'delete' | 'test') => void;
  onClose: () => void;
}) {
  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <StatusIcon status={trigger.status} />
        <span style={{ color: 'var(--text-1)', fontWeight: 600, fontSize: 12 }}>
          {trigger.name}
        </span>
        <span style={{ color: 'var(--text-3)', fontSize: 10 }}>· {trigger.id}</span>
        <button
          type="button"
          onClick={onClose}
          title="close detail"
          style={{
            all: 'unset',
            cursor: 'pointer',
            color: 'var(--text-3)',
            marginLeft: 'auto',
            fontSize: 14,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ padding: 12, flex: 1, overflowY: 'auto' }}>
        <Section title="Schedule">{describeSource(trigger)}</Section>
        {trigger.intent && (
          <Section title="Intent">{trigger.intent}</Section>
        )}
        <Section title="Dispatch">
          agent: <code>{trigger.dispatch.agent}</code>
          <br />
          session: <code>{trigger.dispatch.session}</code>
          <br />
          prompt:
          <div
            style={{
              marginTop: 4,
              padding: 8,
              background: 'var(--bg-3)',
              border: '1px solid var(--line-2)',
              borderRadius: 4,
              whiteSpace: 'pre-wrap',
              color: 'var(--text-2)',
              fontSize: 10,
              maxHeight: 100,
              overflowY: 'auto',
            }}
          >
            {trigger.dispatch.prompt}
          </div>
        </Section>
        {trigger.policy && (trigger.policy.cooldownMs || trigger.policy.maxFiresPerDay) && (
          <Section title="Policy">
            {trigger.policy.cooldownMs !== undefined && (
              <>
                cooldown: {Math.round(trigger.policy.cooldownMs / 1000)}s
                <br />
              </>
            )}
            {trigger.policy.maxFiresPerDay !== undefined && (
              <>max fires/day: {trigger.policy.maxFiresPerDay}</>
            )}
          </Section>
        )}
        <Section title="Stats">
          fires: {trigger.fireCount}
          {trigger.lastSuccessAt && (
            <>
              <br />last success: {formatAbsolute(trigger.lastSuccessAt)}
            </>
          )}
          {trigger.lastErrorAt && (
            <>
              <br />last error: {formatAbsolute(trigger.lastErrorAt)}
            </>
          )}
          {trigger.errorStreak > 0 && (
            <>
              <br />
              <span style={{ color: 'var(--danger)' }}>
                error streak: {trigger.errorStreak}
              </span>
            </>
          )}
        </Section>
        <Section title="History (last 50 fires)">
          {history === null ? (
            <span style={{ color: 'var(--text-3)' }}>loading…</span>
          ) : history.length === 0 ? (
            <span style={{ color: 'var(--text-3)' }}>no fires yet</span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {history.map((h, i) => (
                <HistoryRow key={i} entry={h} />
              ))}
            </div>
          )}
        </Section>
      </div>
      <div
        style={{
          padding: '8px 12px',
          borderTop: '1px solid var(--line)',
          display: 'flex',
          gap: 8,
        }}
      >
        <ActionButton
          icon={<Zap size={12} />}
          label="test now"
          color="var(--accent)"
          onClick={() => onAction('test')}
        />
        {trigger.status === 'paused' || trigger.status === 'error' ? (
          <ActionButton
            icon={<Play size={12} />}
            label="resume"
            color="var(--accent)"
            onClick={() => onAction('resume')}
          />
        ) : trigger.status === 'active' ? (
          <ActionButton
            icon={<Pause size={12} />}
            label="pause"
            color="var(--text-2)"
            onClick={() => onAction('pause')}
          />
        ) : null}
        <ActionButton
          icon={<Trash2 size={12} />}
          label="delete"
          color="var(--danger)"
          onClick={() => onAction('delete')}
        />
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          color: 'var(--text-3)',
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      <div style={{ color: 'var(--text-1)', fontSize: 11 }}>{children}</div>
    </div>
  );
}

function HistoryRow({ entry }: { entry: SentinelFireEntry }) {
  const color =
    entry.outcome === 'success'
      ? 'var(--accent)'
      : entry.outcome === 'error'
        ? 'var(--danger)'
        : 'var(--text-3)';
  return (
    <div
      style={{
        padding: '4px 6px',
        background: 'var(--bg-3)',
        border: '1px solid var(--line-2)',
        borderRadius: 3,
        fontSize: 10,
      }}
    >
      <span style={{ color }}>{entry.outcome}</span>
      {entry.catchUp && <span style={{ color: 'var(--text-3)' }}> · catch-up</span>}
      {entry.testMode && <span style={{ color: 'var(--text-3)' }}> · test</span>}
      {' · '}
      <span style={{ color: 'var(--text-2)' }}>{formatAbsolute(entry.firedAt)}</span>
      {entry.skipReason && (
        <div style={{ color: 'var(--text-3)' }}>{entry.skipReason}</div>
      )}
      {entry.error && (
        <div style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>{entry.error}</div>
      )}
    </div>
  );
}

function ActionButton({
  icon,
  label,
  color,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 10px',
        border: `1px solid ${color}`,
        borderRadius: 3,
        color,
        fontSize: 10,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function formatAbsolute(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('de-DE', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatRelativeFuture(iso: string): string {
  try {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms < 0) return 'past due';
    if (ms < 60_000) return `in ${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)}m`;
    if (ms < 86_400_000) return `in ${Math.round(ms / 3_600_000)}h`;
    return `in ${Math.round(ms / 86_400_000)}d`;
  } catch {
    return '';
  }
}

// Marker so the Activity icon is imported once. (Used by potential
// future inline activity-indicator; harmless if unused right now.)
void Activity;
