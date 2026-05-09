// Custom outline-style koala icon — somora's mascot. Lucide doesn't
// ship one, so we hand-rolled a 24-px viewBox stroke-only glyph
// (head + two ears + two filled eyes + outline nose). Matches the
// somora 🐨-mascot branding from the TUI header.

interface Props {
  size?: number;
  /** Stroke + fill color. Defaults to currentColor so it inherits
   *  from the parent (e.g. a logo-mark gradient). */
  color?: string;
  /** Stroke width, scales with size if you bump the icon. Default
   *  1.6 reads well at 16-20 px. */
  strokeWidth?: number;
  className?: string;
}

export function Koala({
  size = 18,
  color = 'currentColor',
  strokeWidth = 1.6,
  className,
}: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* Head */}
      <ellipse cx="12" cy="13.5" rx="6.5" ry="6.5" />
      {/* Ears (overlap top of head) */}
      <ellipse cx="6" cy="6.5" rx="3" ry="3.2" />
      <ellipse cx="18" cy="6.5" rx="3" ry="3.2" />
      {/* Eyes (small filled dots — outline-icon convention) */}
      <circle cx="9.5" cy="12.5" r="0.7" fill={color} stroke="none" />
      <circle cx="14.5" cy="12.5" r="0.7" fill={color} stroke="none" />
      {/* Nose (outline only) */}
      <ellipse cx="12" cy="16" rx="2" ry="1.3" />
    </svg>
  );
}
