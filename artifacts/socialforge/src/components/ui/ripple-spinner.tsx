// RippleSpinner — inline, icon-sized version of the brand ripple animation
// (see LogoLoader for the full-size block variant). Use this anywhere a small
// loading indicator is needed (buttons, inline statuses) instead of a generic
// spinning icon. Inherits the current text color so it adapts to any button
// variant, and sizes via the same h-*/w-* classes as a lucide icon.
// Keyframes live in index.css (@keyframes brand-ripple) so many instances can
// render without injecting per-instance <style> tags.

const ring: React.CSSProperties = {
  transformOrigin: "50px 50px",
  animation: "brand-ripple 1.8s ease-out infinite",
};

export function RippleSpinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      role="status"
      aria-label="Loading"
      className={className}
      data-testid="ripple-spinner"
    >
      <circle cx="50" cy="50" r="36" fill="none" stroke="currentColor" strokeWidth="20" style={ring} />
      <circle
        cx="50"
        cy="50"
        r="36"
        fill="none"
        stroke="currentColor"
        strokeWidth="20"
        style={{ ...ring, animationDelay: "0.9s" }}
      />
      <circle cx="50" cy="50" r="10" fill="currentColor" />
    </svg>
  );
}
