/**
 * Shared inline SVG icons (stroke-style, Lucide-derived paths). Icons
 * inherit `currentColor` so they adapt to the active daisyUI theme, and
 * carry `aria-hidden="true"` because every usage site provides its own
 * accessible label (constitution V). Icons are plain functions returning
 * JSX - no classes, no icon library dependency (constitution II).
 */

/** Common props for every icon. */
interface IconProps {
  /** Tailwind size/colour classes; defaults to a 16px icon. */
  className?: string;
}

/**
 * Drive icon used as the brand mark on the auth pages.
 *
 * @param props - optional size/colour classes
 * @returns the icon element
 */
export function DriveIcon({ className = "size-4" }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 12H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      <line x1="6" x2="6.01" y1="16" y2="16" />
      <line x1="10" x2="10.01" y1="16" y2="16" />
    </svg>
  );
}
