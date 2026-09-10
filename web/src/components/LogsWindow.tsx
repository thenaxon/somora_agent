// The server's own log, in a window.
//
// Reading it used to mean an ssh session and `tail -f`, which is not
// something you have at hand the moment something looks odd in a chat
// (Rene 2026-09-10). This shows the end of today's log, follows new
// lines while it is open, and filters by level, agent and text.
//
// It never asks for the whole file: the server reads a bounded tail and
// hands back a byte offset, and following asks only for what came after
// it. The log directory holds hundreds of megabytes.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, RefreshCw } from 'lucide-react';
import { api, type LogLine } from '../lib/api';

const LEVELS: Array<{ value: number; label: string }> = [
  { value: 20, label: 'debug' },
  { value: 30, label: 'info' },
  { value: 40, label: 'warn' },
  { value: 50, label: 'error' },
];

const FOLLOW_MS = 2_000;
/** Rows kept in the window; older ones fall off the top. */
const MAX_ROWS = 2_000;

export function levelName(level: number): string {
  if (level >= 60) return 'fatal';
  if (level >= 50) return 'error';
  if (level >= 40) return 'warn';
  if (level >= 30) return 'info';
  if (level >= 20) return 'debug';
  return 'trace';
}

export function levelColor(level: number): string {
  if (level >= 50) return 'var(--danger, #f85149)';
  if (level >= 40) return 'var(--warn, #d29922)';
  if (level >= 30) return 'var(--text-1)';
  return 'var(--text-3)';
}

/** `13:42:07` — the log is read while it happens, the date is the day filter. */
export function formatLogTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The fields worth showing inline, without repeating what has a column. */
export function summarizeFields(fields: Record<string, unknown>): string {
  const skip = new Set(['pid', 'hostname', 'time', 'level', 'msg', 'agent', 'session']);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (skip.has(k) || v === undefined || v === null) continue;
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${text.length > 120 ? `${text.slice(0, 120)}…` : text}`);
    if (parts.length >= 8) break;
  }
  return parts.join(' ');
}

export function LogsWindow() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [days, setDays] = useState<string[]>([]);
  const [day, setDay] = useState<string>('');
  const [minLevel, setMinLevel] = useState(30);
  const [q, setQ] = useState('');
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const offsetRef = useRef(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  const filters = useCallback(
    () => ({ ...(day ? { day } : {}), minLevel, ...(q.trim() ? { q: q.trim() } : {}) }),
    [day, minLevel, q],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const snap = await api.logs({ ...filters(), limit: 500 });
      setLines(snap.lines);
      setDays(snap.days);
      offsetRef.current = snap.offset;
      if (!day && snap.day) setDay(snap.day);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters, day]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Follow: ask only for what was appended since the last offset.
  useEffect(() => {
    if (!follow) return;
    let alive = true;
    const timer = setInterval(() => {
      void api
        .logsSince(offsetRef.current, filters())
        .then((res) => {
          if (!alive) return;
          offsetRef.current = res.offset;
          if (res.lines.length === 0) return;
          setLines((prev) => [...prev, ...res.lines].slice(-MAX_ROWS));
        })
        .catch(() => {
          /* a blip is not worth a red banner; the next tick tries again */
        });
    }, FOLLOW_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [follow, filters]);

  // Stay pinned to the bottom, unless the reader scrolled up to look.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !atBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const control: React.CSSProperties = {
    background: 'var(--bg-2)',
    border: '1px solid var(--line)',
    borderRadius: 4,
    color: 'var(--text-1)',
    fontSize: 11,
    padding: '2px 6px',
    fontFamily: 'inherit',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: '"JetBrains Mono", monospace' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 12px',
          borderBottom: '1px solid var(--line)',
          fontSize: 11,
          color: 'var(--text-2)',
          flexWrap: 'wrap',
        }}
      >
        <select value={day} onChange={(e) => setDay(e.target.value)} style={control} title="which day">
          {days.length === 0 && <option value="">no log yet</option>}
          {days.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select value={minLevel} onChange={(e) => setMinLevel(Number(e.target.value))} style={control} title="minimum level">
          {LEVELS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label} and up
            </option>
          ))}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter text (agent, tool, error…)"
          style={{ ...control, flex: 1, minWidth: 120 }}
        />
        <button
          type="button"
          onClick={() => setFollow((f) => !f)}
          style={{ ...control, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          title={follow ? 'stop following new lines' : 'follow new lines'}
        >
          {follow ? <Pause size={11} /> : <Play size={11} />}
          {follow ? 'following' : 'paused'}
        </button>
        <button type="button" onClick={() => void reload()} style={{ ...control, cursor: 'pointer', display: 'inline-flex' }} title="reload">
          <RefreshCw size={11} />
        </button>
      </div>
      {error && <div style={{ padding: 12, color: 'var(--danger, #f85149)', fontSize: 11 }}>{error}</div>}
      <div ref={bodyRef} onScroll={onScroll} style={{ flex: 1, overflow: 'auto', padding: '6px 8px' }}>
        {loading && lines.length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: 11, padding: 16, textAlign: 'center' }}>loading…</div>
        ) : lines.length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: 11, padding: 16, textAlign: 'center' }}>
            nothing matches — try a lower level or clear the filter
          </div>
        ) : (
          lines.map((l, i) => (
            <div
              key={`${l.ts}-${i}`}
              style={{ display: 'flex', gap: 8, fontSize: 10, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              <span style={{ color: 'var(--text-3)' }}>{formatLogTime(l.ts)}</span>
              <span style={{ color: levelColor(l.level), width: 38, flexShrink: 0 }}>{levelName(l.level)}</span>
              {l.agent && <span style={{ color: 'var(--accent, #58a6ff)' }}>{l.agent}</span>}
              <span style={{ color: 'var(--text-1)' }}>{l.msg}</span>
              <span style={{ color: 'var(--text-3)' }}>{summarizeFields(l.fields)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
