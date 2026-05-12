// Single source of truth for the dream-phase visual language.
// REM = Brain (green), DEEP = Layers (indigo), LUCID = ScanEye (violet).
// Colors come from CSS tokens in styles/globals.css so any tuning
// happens in one place. TUI mirror lives in src/cli/tui/dream-glyphs.ts.

import { Brain, Layers, ScanEye } from 'lucide-react';

export type DreamPhase = 'rem' | 'deep' | 'lucid';

interface Props {
  phase: DreamPhase;
  size?: number;
  title?: string;
}

const COLOR_VAR: Record<DreamPhase, string> = {
  rem: 'var(--dream-rem)',
  deep: 'var(--dream-deep)',
  lucid: 'var(--dream-lucid)',
};

export function DreamPhaseIcon({ phase, size = 12, title }: Props) {
  const color = COLOR_VAR[phase];
  const Icon = phase === 'rem' ? Brain : phase === 'deep' ? Layers : ScanEye;
  return (
    <span
      title={title}
      style={{ display: 'inline-flex', alignItems: 'center', color }}
    >
      <Icon size={size} />
    </span>
  );
}
