// Mascot icon — copy of web/src/components/Koala.tsx to avoid the
// relative-import-into-sibling-package dance for a tiny SVG. If we
// extract a shared/ layer later this can move there.

interface Props {
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export function Koala({
  size = 18,
  color = 'currentColor',
  strokeWidth = 1.8,
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
      aria-hidden="true"
    >
      <ellipse cx="12" cy="13.5" rx="6.5" ry="6.5" />
      <ellipse cx="6" cy="6.5" rx="3" ry="3.2" />
      <ellipse cx="18" cy="6.5" rx="3" ry="3.2" />
      <circle cx="9.5" cy="12.5" r="0.9" fill={color} stroke="none" />
      <circle cx="14.5" cy="12.5" r="0.9" fill={color} stroke="none" />
      <ellipse cx="12" cy="16" rx="2" ry="1.3" />
    </svg>
  );
}
