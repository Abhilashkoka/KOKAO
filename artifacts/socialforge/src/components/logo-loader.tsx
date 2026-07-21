// LogoLoader — branded loading animation used wherever the app is loading,
// generating AI content, or buffering. Two variants:
//   ripple: expanding rings (default, ambient loading)
//   trace:  draw-on ring (active work, e.g. AI generation)
// Color defaults to the current theme primary so white-label branding applies.

const KEYFRAMES = `
@keyframes lg-ripple {
  0%   { transform: scale(0.28); opacity: 0.9; }
  100% { transform: scale(1.15); opacity: 0; }
}
@keyframes lg-trace {
  0%   { stroke-dashoffset: 226; }
  45%  { stroke-dashoffset: 0; }
  60%  { stroke-dashoffset: 0; }
  100% { stroke-dashoffset: -226; }
}`;

export function LogoLoader({
  variant = "ripple",
  size = 80,
  color = "hsl(var(--primary))",
  label,
  className,
}: {
  variant?: "ripple" | "trace";
  size?: number;
  color?: string;
  label?: string;
  className?: string;
}) {
  const ring: React.CSSProperties = {
    transformOrigin: "50px 50px",
    animation: "lg-ripple 1.8s ease-out infinite",
  };
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 ${className ?? ""}`}
      data-testid="logo-loader"
    >
      <style>{KEYFRAMES}</style>
      {variant === "trace" ? (
        <svg
          width={size}
          height={size}
          viewBox="0 0 100 100"
          role="status"
          aria-label={label ?? "Loading"}
          style={{ transform: "rotate(-90deg)" }}
        >
          <circle
            cx="50"
            cy="50"
            r="36"
            fill="none"
            stroke={color}
            strokeWidth="20"
            strokeLinecap="round"
            strokeDasharray="226"
            style={{ animation: "lg-trace 2.2s ease-in-out infinite" }}
          />
          <circle cx="50" cy="50" r="10" fill={color} />
        </svg>
      ) : (
        <svg
          width={size}
          height={size}
          viewBox="0 0 100 100"
          role="status"
          aria-label={label ?? "Loading"}
        >
          <circle cx="50" cy="50" r="36" fill="none" stroke={color} strokeWidth="20" style={ring} />
          <circle
            cx="50"
            cy="50"
            r="36"
            fill="none"
            stroke={color}
            strokeWidth="20"
            style={{ ...ring, animationDelay: "0.9s" }}
          />
          <circle cx="50" cy="50" r="10" fill={color} />
        </svg>
      )}
      {label ? <p className="text-sm text-muted-foreground">{label}</p> : null}
    </div>
  );
}
