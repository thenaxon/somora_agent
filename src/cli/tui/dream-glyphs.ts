// TUI mirror of the web's DreamPhaseIcon visual language. Web uses
// lucide-react icons + CSS tokens from styles/globals.css; here we
// surface the emoji + hex color so any TUI surface (status line,
// future /dream slash-command, etc.) renders with the same sprache.
//
// Stay in sync with:
//   web/src/components/DreamPhaseIcon.tsx
//   web/src/styles/globals.css (--dream-rem/deep/lucid tokens)

export type DreamPhase = 'rem' | 'deep' | 'lucid';

export interface DreamGlyph {
  emoji: string;
  color: string; // hex — Ink's <Text color="..."> accepts hex directly
  label: string;
}

export const DREAM_GLYPHS: Record<DreamPhase, DreamGlyph> = {
  rem: { emoji: '🧠', color: '#4ade80', label: 'REM' },
  deep: { emoji: '📚', color: '#6366f1', label: 'DEEP' },
  lucid: { emoji: '🔍', color: '#a855f7', label: 'LUCID' },
};
