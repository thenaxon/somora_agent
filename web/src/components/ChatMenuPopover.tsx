// Three-dots ••• action menu for the chat window.
//
// Renders into a React Portal at document.body so the popover escapes
// the chat window's `overflow: hidden` + `backdrop-filter` containing
// block. Positioned via fixed coordinates derived from the anchor
// button's getBoundingClientRect — same screen position every time
// the same ••• button is clicked.
//
// Visual language mirrors SlashCommandPopup (JetBrains Mono, bg-2,
// var(--line) borders) so it doesn't read as a foreign component.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, AlertTriangle, CheckSquare, Square } from 'lucide-react';
import { api, type ModelOption, type SessionModelInfo, type SessionThinkingInfo } from '../lib/api';
import type { SlashCommand } from './SlashCommandPopup';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Snapshot of the ••• button's bounding rect — drives popover position. */
  anchorRect: DOMRect | null;
  model: SessionModelInfo | null;
  thinking: SessionThinkingInfo | null;
  /** Display preference for the 🧠 thinking block (per session, stored
   *  client-side by ChatWindow). Same switch as `/verbose thinking`. */
  showThinking: boolean;
  onToggleShowThinking: () => void;
  onSlash: (cmd: SlashCommand) => Promise<void> | void;
}

type ResetState = 'idle' | 'confirming' | 'pending';

export function ChatMenuPopover({
  open,
  onClose,
  anchorRect,
  model,
  thinking,
  showThinking,
  onToggleShowThinking,
  onSlash,
}: Props) {
  const [resetState, setResetState] = useState<ResetState>('idle');
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [modelFilter, setModelFilter] = useState('');
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      setResetState('idle');
      setShowModelPicker(false);
      setModelFilter('');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(e.target as Node)) return;
      // Ignore the click that opened us — the parent toggles via the
      // anchor button so an outside-click handler must skip the anchor
      // bounds, otherwise we'd open-and-close in the same tick.
      if (anchorRect) {
        const { clientX: x, clientY: y } = e;
        if (
          x >= anchorRect.left && x <= anchorRect.right &&
          y >= anchorRect.top && y <= anchorRect.bottom
        ) {
          return;
        }
      }
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDocClick);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRect]);

  useEffect(() => {
    if (!showModelPicker || models !== null) return;
    api.models().then(setModels).catch(() => setModels([]));
  }, [showModelPicker, models]);

  const filteredModels = useMemo(() => {
    if (!models) return null;
    if (!modelFilter.trim()) return models;
    const q = modelFilter.toLowerCase();
    return models.filter(
      (m) =>
        (m.alias ?? '').toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.engine.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q),
    );
  }, [models, modelFilter]);

  if (!open || !anchorRect) return null;

  // Right-align to anchor's right edge, drop 6px below it. With portal
  // mount on document.body, `position: fixed` is now relative to the
  // viewport — no surprise containing-block hijacking.
  const top = Math.round(anchorRect.bottom + 6);
  const right = Math.round(window.innerWidth - anchorRect.right);

  async function handleModelPick(ref: string) {
    setShowModelPicker(false);
    await onSlash({ kind: 'model', ref });
    onClose();
  }

  async function handleThinking(level: 'off' | 'low' | 'medium' | 'high' | 'default') {
    await onSlash({ kind: 'thinking', level });
    onClose();
  }

  async function handleResetConfirm() {
    setResetState('pending');
    try {
      await onSlash({ kind: 'reset' });
    } finally {
      setResetState('idle');
      onClose();
    }
  }

  const currentModelLabel = model ? model.alias ?? `${model.provider}/${model.modelId}` : '—';
  const currentThinking = thinking?.effective ?? 'off';
  const thinkingSource =
    thinking?.source === 'session-override'
      ? 'session override'
      : thinking?.source === 'persona-default'
        ? 'persona default'
        : 'engine default';

  const node = (
    <div
      ref={popoverRef}
      role="menu"
      className="chat-menu-popover"
      style={{
        position: 'fixed',
        top,
        right,
        zIndex: 1000,
        width: 280,
        background: 'var(--bg-2)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 12,
        color: 'var(--text-1)',
      }}
    >
      {/* MODEL */}
      <Section title="MODEL">
        <CurrentLine label="current" value={currentModelLabel} />
        {model && (
          <Hint>
            {model.engine} · {Math.round(model.contextWindow / 1000)}k context
            {model.source === 'session-override' ? ' · session override' : ''}
          </Hint>
        )}
        <ToggleRow
          label="Switch model…"
          open={showModelPicker}
          onClick={() => setShowModelPicker((v) => !v)}
        />
        {showModelPicker && (
          <div style={{ marginTop: 4 }}>
            <input
              type="text"
              placeholder="filter…"
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              autoFocus
              style={inputStyle}
            />
            <div style={{ maxHeight: 200, overflowY: 'auto', marginTop: 4 }}>
              {filteredModels === null && <div style={muted}>loading…</div>}
              {filteredModels !== null && filteredModels.length === 0 && (
                <div style={muted}>no models match</div>
              )}
              {filteredModels?.map((m) => {
                const isCurrent = model
                  ? m.id === model.modelId && m.provider === model.provider
                  : false;
                return (
                  <div
                    key={`${m.provider}/${m.id}`}
                    onClick={() => handleModelPick(m.ref)}
                    style={{
                      ...modelRow,
                      background: isCurrent ? 'var(--bg-3)' : 'transparent',
                    }}
                    onMouseEnter={(e) => {
                      if (!isCurrent) e.currentTarget.style.background = 'var(--bg-3)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isCurrent) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <span style={{ color: isCurrent ? 'var(--accent)' : 'var(--text-3)' }}>
                      {isCurrent ? '●' : '○'}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: 'var(--text-1)',
                      }}
                    >
                      {m.alias ?? m.id}
                    </span>
                    <span style={{ color: 'var(--text-3)', fontSize: 10 }}>{m.engine}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Section>

      <Divider />

      {/* THINKING */}
      <Section title="THINKING">
        <CurrentLine label="current" value={currentThinking} />
        <Hint>{thinkingSource}</Hint>
        <div style={{ display: 'flex', gap: 3, marginTop: 6 }}>
          {(['off', 'low', 'medium', 'high'] as const).map((lvl) => {
            const isActive = currentThinking === lvl;
            return (
              <button
                key={lvl}
                type="button"
                onClick={() => handleThinking(lvl)}
                style={{
                  ...thinkingSegment,
                  background: isActive ? 'var(--accent)' : 'var(--bg-1)',
                  color: isActive ? '#0a1010' : 'var(--text-2)',
                  borderColor: isActive ? 'var(--accent)' : 'var(--line-2)',
                  fontWeight: isActive ? 700 : 400,
                }}
              >
                {lvl}
              </button>
            );
          })}
        </div>
        <div
          onClick={() => handleThinking('default')}
          style={{
            ...toggleRowStyle,
            marginTop: 4,
            color: 'var(--text-3)',
            fontSize: 11,
          }}
          title="Remove session override, fall back to persona / engine default"
        >
          Reset to default
        </div>
        <CheckRow
          className="thinking-visibility-row"
          label="Show thinking in replies"
          checked={showThinking}
          onClick={onToggleShowThinking}
          title="Display only, this session — the text is still captured and exported. Same as /verbose thinking on|off"
        />
      </Section>

      <Divider />

      {/* DANGER ZONE */}
      <Section title="DANGER ZONE" tone="danger">
        {resetState === 'idle' && (
          <>
            <button type="button" onClick={() => setResetState('confirming')} style={resetTriggerButton}>
              <AlertTriangle size={12} />
              <span>Reset session</span>
            </button>
            <Hint>
              Archives the current chat (kept as <code style={code}>-archive</code>) and starts fresh.
              REM extracts memory from the archived content if enabled for this agent.
            </Hint>
          </>
        )}
        {resetState !== 'idle' && (
          <div
            style={{
              padding: 8,
              border: '1px solid var(--danger)',
              borderRadius: 4,
              background: 'rgba(248, 113, 113, 0.08)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <AlertTriangle size={12} style={{ color: 'var(--danger)' }} />
              <strong style={{ color: 'var(--danger)' }}>confirm reset</strong>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-1)', marginBottom: 8, lineHeight: 1.4 }}>
              The current chat will be archived. Continue?
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                type="button"
                onClick={() => setResetState('idle')}
                disabled={resetState === 'pending'}
                style={cancelButton}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleResetConfirm}
                disabled={resetState === 'pending'}
                style={dangerConfirmButton}
              >
                {resetState === 'pending' ? 'Resetting…' : 'Confirm reset'}
              </button>
            </div>
          </div>
        )}
      </Section>
    </div>
  );

  return createPortal(node, document.body);
}

// ── presentational helpers ────────────────────────────────────────────

function Section({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: 'danger';
  children: React.ReactNode;
}) {
  return (
    <div style={{ padding: '8px 10px' }}>
      <div
        style={{
          fontSize: 9,
          letterSpacing: 1.4,
          color: tone === 'danger' ? 'var(--danger)' : 'var(--text-3)',
          marginBottom: 4,
          fontWeight: 700,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: '1px solid var(--line-2)' }} />;
}

function CurrentLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{label}</span>
      <span
        style={{
          fontSize: 12,
          color: 'var(--text-0)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.4 }}>
      {children}
    </div>
  );
}

function ToggleRow({ label, open, onClick }: { label: string; open: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={toggleRowStyle}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-3)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span>{label}</span>
      <ChevronDown
        size={12}
        style={{
          transform: open ? 'rotate(180deg)' : 'none',
          transition: 'transform 0.12s',
        }}
      />
    </div>
  );
}

function CheckRow({
  label,
  checked,
  onClick,
  title,
  className,
}: {
  label: string;
  checked: boolean;
  onClick: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <div
      className={className}
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
      title={title}
      style={{ ...toggleRowStyle, justifyContent: 'flex-start', gap: 6, fontSize: 11 }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-3)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {checked ? (
        <CheckSquare size={12} style={{ color: 'var(--accent)' }} />
      ) : (
        <Square size={12} style={{ color: 'var(--text-3)' }} />
      )}
      <span>{label}</span>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────

const toggleRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '5px 6px',
  marginTop: 6,
  cursor: 'pointer',
  borderRadius: 3,
  color: 'var(--text-1)',
  background: 'transparent',
  transition: 'background 0.12s',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px 6px',
  background: 'var(--bg-1)',
  border: '1px solid var(--line-2)',
  borderRadius: 3,
  color: 'var(--text-0)',
  fontSize: 11,
  fontFamily: '"JetBrains Mono", monospace',
  outline: 'none',
};

const muted: React.CSSProperties = {
  padding: 6,
  color: 'var(--text-3)',
  fontSize: 11,
};

const modelRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 6px',
  cursor: 'pointer',
  borderRadius: 3,
  fontSize: 11,
};

const thinkingSegment: React.CSSProperties = {
  all: 'unset',
  flex: 1,
  textAlign: 'center',
  padding: '4px 0',
  border: '1px solid var(--line-2)',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: '"JetBrains Mono", monospace',
};

const resetTriggerButton: React.CSSProperties = {
  all: 'unset',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  background: 'rgba(248, 113, 113, 0.08)',
  border: '1px solid var(--danger)',
  borderRadius: 4,
  color: 'var(--danger)',
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 600,
  fontFamily: '"JetBrains Mono", monospace',
  transition: 'background 0.12s',
};

const cancelButton: React.CSSProperties = {
  all: 'unset',
  flex: 1,
  textAlign: 'center',
  padding: '5px 0',
  background: 'var(--bg-1)',
  border: '1px solid var(--line-2)',
  borderRadius: 3,
  cursor: 'pointer',
  color: 'var(--text-1)',
  fontSize: 11,
  fontFamily: '"JetBrains Mono", monospace',
};

const dangerConfirmButton: React.CSSProperties = {
  all: 'unset',
  flex: 1,
  textAlign: 'center',
  padding: '5px 0',
  background: 'var(--danger)',
  borderRadius: 3,
  cursor: 'pointer',
  color: '#fff',
  fontSize: 11,
  fontWeight: 700,
  fontFamily: '"JetBrains Mono", monospace',
};

const code: React.CSSProperties = {
  background: 'var(--bg-1)',
  padding: '0 3px',
  borderRadius: 2,
  fontSize: 10,
};
