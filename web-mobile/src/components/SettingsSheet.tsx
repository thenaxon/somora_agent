// The chat's view settings behind one header button (docs/mobile.md
// "Header"): tool activity, recalled notes, keeping the screen awake and
// reading replies aloud. They used to be a button each in the header; with
// all of them shown on a phone they pushed the agent, session and model
// aside (2026-11-16). What does something or reports something — the work
// badge, the call button, a builder's lists — stays in the header.
//
// A dot on the button says that at least one setting is not as it starts
// out, so a hidden "on" is never a surprise.

export interface SettingRow {
  id: string;
  icon: string;
  label: string;
  /** One line under the label: what on means, or a caveat. */
  hint?: string;
  on: boolean;
  onToggle: () => void;
  /** Not as the setting starts out (config / device default). */
  changed: boolean;
}

export function SettingsButton({ open, changed, onToggle }: { open: boolean; changed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-testid="settings-button"
      className={`header-settings ${open ? 'open' : ''}`}
      onClick={onToggle}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={changed ? 'chat settings (some changed)' : 'chat settings'}
      title="chat settings"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="4" y1="6" x2="20" y2="6" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <line x1="4" y1="18" x2="20" y2="18" />
        <circle cx="9" cy="6" r="2" fill="var(--bg-1)" />
        <circle cx="15" cy="12" r="2" fill="var(--bg-1)" />
        <circle cx="8" cy="18" r="2" fill="var(--bg-1)" />
      </svg>
      {changed && <span className="header-settings-dot" data-testid="settings-dot" aria-hidden="true" />}
    </button>
  );
}

export function SettingsSheet({ rows, onClose }: { rows: SettingRow[]; onClose: () => void }) {
  return (
    <div className="work-sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="work-sheet settings-sheet"
        role="dialog"
        aria-label="chat settings"
        data-testid="settings-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="work-sheet-grip" aria-hidden="true" />
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            role="switch"
            aria-checked={r.on}
            className="settings-row"
            data-testid={`setting-${r.id}`}
            onClick={r.onToggle}
          >
            <span className="settings-row-icon" aria-hidden="true">{r.icon}</span>
            <span className="settings-row-text">
              <span className="settings-row-label">{r.label}</span>
              {r.hint && <span className="settings-row-hint">{r.hint}</span>}
            </span>
            <span className={`settings-switch ${r.on ? 'on' : ''}`} aria-hidden="true">
              <span className="settings-switch-knob" />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
