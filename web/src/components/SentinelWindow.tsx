// Sentinel tab — admin/inspector for the proactive trigger runtime.
// Two views:
//   1. List: name / schedule / owner / next-fire / fire-count / status
//      (a check trigger: checks and wakes counted apart, next check,
//      last result)
//   2. Detail: full config + history + action buttons (test / pause /
//      resume / delete). A check trigger also shows its check, the last
//      check, the decision model's questions and rule, and its script —
//      read only; its test is a dry run shown in place.
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
import {
  api,
  type SentinelTrigger,
  type SentinelFireEntry,
  type SentinelDryRun,
  type SentinelWakeRule,
} from '../lib/api';

const POLL_INTERVAL_MS = 5_000;

export function SentinelWindow() {
  const [triggers, setTriggers] = useState<SentinelTrigger[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<SentinelFireEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<{ id: string; running: boolean; result?: SentinelDryRun; error?: string } | null>(null);

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
    setDryRun(null);
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
          const isCheck = triggers?.find((t) => t.id === id)?.source.type === 'check';
          if (isCheck) {
            // A check trigger's test is a dry run: show its answer here.
            setDryRun({ id, running: true });
            try {
              const r = await api.sentinelTest(id);
              setDryRun({ id, running: false, ...(r.dryRun ? { result: r.dryRun } : {}) });
            } catch (err) {
              setDryRun({ id, running: false, error: (err as Error).message });
            }
            return;
          }
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
    [refresh, refreshHistory, selected, triggers],
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
            // A new trigger starts at the top, not at the last one's scroll position.
            key={selectedTrigger.id}
            trigger={selectedTrigger}
            history={history}
            dryRun={dryRun?.id === selectedTrigger.id ? dryRun : null}
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
          {trigger.check
            ? `${trigger.check.checks} checks · ${trigger.check.wakes} wake${trigger.check.wakes === 1 ? '' : 's'}`
            : `${trigger.fireCount}× fired`}
        </span>
      </div>
      <div style={{ color: 'var(--text-2)', fontSize: 10 }}>{describeSource(trigger)}</div>
      {trigger.source.type === 'check' && (
        <div style={{ color: 'var(--text-2)', fontSize: 10 }}>{trigger.source.description}</div>
      )}
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
      {trigger.check?.nextCheckAt && (
        <div style={{ color: 'var(--text-3)', fontSize: 10 }}>
          next check: {formatTime(trigger.check.nextCheckAt)} ({formatRelativeFuture(trigger.check.nextCheckAt, 'due now')})
        </div>
      )}
      {/* A stopped trigger's reason below already names the last error. */}
      {trigger.check?.last && !(trigger.statusReason && !trigger.check.last.ok) && (
        <div style={{ color: trigger.check.last.ok ? 'var(--text-3)' : 'var(--danger)', fontSize: 10 }}>
          last check {formatTime(trigger.check.last.at)}: {lastCheckText(trigger.check.last)}
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
  if (t.source.type === 'check') {
    const c = t.source;
    const judged = t.evaluator.type === 'decision' ? (t.evaluator.perItem ? ' · judged item by item' : ' · judged') : '';
    return c.mode === 'once'
      ? `Check once · every ${c.interval}${c.deadline ? ` · until ${formatAbsolute(c.deadline)}` : ''}${judged}`
      : `Check watch · every ${c.interval}${judged}`;
  }
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

/** One line for a check result: the summary, ready or the error. */
function lastCheckText(r: NonNullable<NonNullable<SentinelTrigger['check']>['last']>): string {
  if (!r.ok) return r.error ?? 'error';
  const parts: string[] = [];
  if (r.final) parts.push('final: failed');
  else if (r.ready !== undefined) parts.push(r.ready ? 'ready' : 'not ready');
  if (r.decision) parts.push(`${r.decision.question} ${r.decision.value}`);
  if (r.summary) parts.push(r.summary);
  return parts.join(' · ') || 'ok';
}

function describeWakeRule(w: SentinelWakeRule): string {
  if ('minProbability' in w) return `wake when "${w.question}" is yes with probability ≥ ${w.minProbability}`;
  if ('choice' in w) {
    return w.minConfidence !== undefined
      ? `wake when "${w.question}" = ${w.choice} with probability ≥ ${w.minConfidence}`
      : `wake when "${w.question}" picks ${w.choice}`;
  }
  return `wake when "${w.question}" scores ≥ ${w.minScore}`;
}

function DetailPanel({
  trigger,
  history,
  dryRun,
  onAction,
  onClose,
}: {
  trigger: SentinelTrigger;
  history: SentinelFireEntry[] | null;
  dryRun: { running: boolean; result?: SentinelDryRun; error?: string } | null;
  onAction: (action: 'pause' | 'resume' | 'delete' | 'test') => void;
  onClose: () => void;
}) {
  const isCheck = trigger.source.type === 'check';
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
        {dryRun && <DryRunResult run={dryRun} />}
        {isCheck ? (
          <CheckSections trigger={trigger} />
        ) : (
          <Section title="Schedule">{describeSource(trigger)}</Section>
        )}
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
          {trigger.check && (
            <>
              checks: {trigger.check.checks} · wakes: {trigger.check.wakes}
              {trigger.check.errorsInARow > 0 && (
                <span style={{ color: 'var(--danger)' }}> · errors in a row: {trigger.check.errorsInARow}</span>
              )}
              <br />
            </>
          )}
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
        <Section title="History (last 50 entries)">
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
          label={isCheck ? (dryRun?.running ? 'running…' : 'dry run') : 'test now'}
          color="var(--accent)"
          onClick={() => {
            if (!dryRun?.running) onAction('test');
          }}
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

const boxStyle: React.CSSProperties = {
  marginTop: 4,
  padding: 8,
  background: 'var(--bg-3)',
  border: '1px solid var(--line-2)',
  borderRadius: 4,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: 'var(--text-2)',
  fontSize: 10,
  maxHeight: 160,
  overflowY: 'auto',
};

function CheckSections({ trigger }: { trigger: SentinelTrigger }) {
  if (trigger.source.type !== 'check') return null;
  const c = trigger.source;
  const view = trigger.check;
  const judged = trigger.evaluator.type === 'decision' ? trigger.evaluator : null;
  return (
    <>
      <Section title="Kind">{judged ? (judged.perItem ? 'Check script + decision model, item by item' : 'Check script + decision model') : 'Check script'}</Section>
      <Section title="Check">
        {c.description}
        <br />
        mode: {c.mode === 'once'
          ? 'once (wakes on the first positive check, then done)'
          : judged
            ? judged.perItem
              ? 'watch (each new item is judged once; wakes when one passes the wake rule)'
              : 'watch (wakes when new data passes the wake rule)'
            : 'watch (wakes each time ready turns true)'}
        <br />
        every: {c.interval}
        {view?.effectiveInterval && (
          <span style={{ color: 'var(--warn)' }}>
            {' '}· runs every {view.effectiveInterval} (config minimum)
          </span>
        )}
        {c.deadline && (
          <>
            <br />
            deadline: {formatAbsolute(c.deadline)}
          </>
        )}
        {c.timeoutMs !== undefined && (
          <>
            <br />
            time limit: {Math.round(c.timeoutMs / 1000)}s
          </>
        )}
        {c.notifyOnFirst && (
          <>
            <br />
            the first check may wake
          </>
        )}
        {view?.nextCheckAt && (
          <>
            <br />
            next check: {formatTime(view.nextCheckAt)} ({formatRelativeFuture(view.nextCheckAt, 'due now')})
          </>
        )}
      </Section>
      {view?.last && (
        <Section title="Last check">
          <span style={{ color: view.last.ok ? 'var(--text-1)' : 'var(--danger)' }}>
            {formatTime(view.last.at)} · {view.last.ms} ms · {lastCheckText(view.last)}
          </span>
          {view.last.warning && <div style={{ color: 'var(--warn)', marginTop: 4 }}>{view.last.warning}</div>}
          {view.last.dataPreview && <div style={boxStyle}>{view.last.dataPreview}</div>}
        </Section>
      )}
      {judged && (
        <Section title="Decision model">
          {describeWakeRule(judged.wake)}
          {view?.lastDecision && (
            <>
              <br />
              last answer: {String(view.lastDecision.value)}
              {view.lastDecision.detail ? ` (${view.lastDecision.detail})` : ''} · {formatTime(view.lastDecision.at)}
            </>
          )}
          <div style={boxStyle}>{JSON.stringify(judged.questions, null, 2)}</div>
        </Section>
      )}
      <ScriptSection id={trigger.id} lang={c.script.lang} />
    </>
  );
}

/** The script a check runs, read only. Loaded when opened. */
function ScriptSection({ id, lang }: { id: string; lang: string }) {
  const [open, setOpen] = useState(false);
  const [script, setScript] = useState<{ text?: string; matches: boolean; error?: string; sha256: string } | null>(null);
  useEffect(() => {
    setScript(null);
    setOpen(false);
  }, [id]);
  useEffect(() => {
    if (!open || script) return;
    api
      .sentinelScript(id)
      .then(setScript)
      .catch((err: Error) => setScript({ matches: false, error: err.message, sha256: '' }));
  }, [open, script, id]);
  return (
    <Section title="Script">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ all: 'unset', cursor: 'pointer', color: 'var(--accent)', fontSize: 10 }}
      >
        {open ? '▾ hide' : '▸ show'} ({lang}, read only)
      </button>
      {open &&
        (script === null ? (
          <div style={{ color: 'var(--text-3)', fontSize: 10, marginTop: 4 }}>loading…</div>
        ) : (
          <>
            {script.error && <div style={{ color: 'var(--danger)', fontSize: 10, marginTop: 4 }}>{script.error}</div>}
            {script.text !== undefined && !script.matches && (
              <div style={{ color: 'var(--danger)', fontSize: 10, marginTop: 4 }}>
                changed outside somora — the trigger stops at its next check
              </div>
            )}
            {script.text !== undefined && (
              <pre style={{ ...boxStyle, maxHeight: 260, fontFamily: 'inherit', margin: '4px 0 0' }}>{script.text}</pre>
            )}
            {script.sha256 && (
              <div style={{ color: 'var(--text-3)', fontSize: 9, marginTop: 2 }}>sha256 {script.sha256.slice(0, 16)}…</div>
            )}
          </>
        ))}
    </Section>
  );
}

function DryRunResult({ run }: { run: { running: boolean; result?: SentinelDryRun; error?: string } }) {
  const r = run.result;
  return (
    <Section title="Dry run">
      {run.running ? (
        <span style={{ color: 'var(--text-3)' }}>running the script…</span>
      ) : run.error ? (
        <span style={{ color: 'var(--danger)' }}>{run.error}</span>
      ) : r ? (
        <div
          style={{
            padding: 8,
            borderRadius: 4,
            border: `1px solid ${r.ok ? 'var(--accent)' : 'var(--danger)'}`,
            background: 'var(--bg-3)',
            fontSize: 10,
          }}
        >
          <div style={{ color: r.ok ? 'var(--accent)' : 'var(--danger)' }}>
            {r.ok ? 'ran' : 'failed'} · {r.ms} ms
          </div>
          {r.error && <div style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>{r.error}</div>}
          {r.answer && <div style={boxStyle}>{JSON.stringify(r.answer, null, 2)}</div>}
          {r.decision && (
            <div style={{ color: 'var(--text-2)', marginTop: 4 }}>
              {r.decision.ok
                ? `${r.decision.question} = ${r.decision.value} → ${r.decision.wake ? 'would wake' : 'would not wake'}`
                : `decision model: ${r.decision.error}`}
            </div>
          )}
          {r.items && r.items.length > 0 && (
            <div style={{ color: 'var(--text-2)', marginTop: 4 }}>
              {r.items.map((i) => (
                <div key={i.key}>
                  {i.key}: {i.error ? <span style={{ color: 'var(--danger)' }}>{i.error}</span> : `${String(i.value)} → ${i.wake ? 'would wake' : 'would not wake'}`}
                </div>
              ))}
            </div>
          )}
          {r.warning && <div style={{ color: 'var(--warn)', marginTop: 4 }}>{r.warning}</div>}
          {r.verdict && <div style={{ color: 'var(--text-2)', marginTop: 4 }}>{r.verdict}</div>}
          {r.stderr && <div style={{ ...boxStyle, color: 'var(--text-3)' }}>{r.stderr}</div>}
          <div style={{ color: 'var(--text-3)', marginTop: 4 }}>Nothing was saved, nobody was woken.</div>
        </div>
      ) : null}
    </Section>
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
        : entry.outcome === 'updated' || entry.outcome === 'judged'
          ? 'var(--text-2)'
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
      {entry.note && <div style={{ color: 'var(--text-3)' }}>{entry.note}</div>}
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

/** Time of day, with the date only when it is not today. */
function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : formatAbsolute(iso);
  } catch {
    return iso;
  }
}

function formatRelativeFuture(iso: string, past = 'past due'): string {
  try {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms < 0) return past;
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
