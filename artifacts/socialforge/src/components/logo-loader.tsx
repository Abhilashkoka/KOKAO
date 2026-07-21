// LogoLoader — branded loading animation used wherever the app is loading,
// generating AI content, or buffering. Renders the built-in ripple animation
// (expanding rings) by default. When the superadmin has configured a custom
// loader animation in App Branding (an animated SVG/GIF/APNG/WebP), that
// image is rendered instead. Color defaults to the current theme primary so
// white-label branding applies.

import { useBrand } from "@/lib/brand";

const KEYFRAMES = `
@keyframes lg-ripple {
  0%   { transform: scale(0.28); opacity: 0.9; }
  100% { transform: scale(1.15); opacity: 0; }
}`;

export function LogoLoader({
  size = 80,
  color = "hsl(var(--primary))",
  label,
  className,
}: {
  size?: number;
  color?: string;
  label?: string;
  className?: string;
}) {
  const { loaderAnimationUrl } = useBrand();

  const ring: React.CSSProperties = {
    transformOrigin: "50px 50px",
    animation: "lg-ripple 1.8s ease-out infinite",
  };
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 ${className ?? ""}`}
      data-testid="logo-loader"
    >
      {loaderAnimationUrl ? (
        <img
          src={loaderAnimationUrl}
          width={size}
          height={size}
          role="status"
          aria-label={label ?? "Loading"}
          alt=""
          style={{ objectFit: "contain" }}
          data-testid="logo-loader-custom"
        />
      ) : (
        <>
          <style>{KEYFRAMES}</style>
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
        </>
      )}
      {label ? <p className="text-sm text-muted-foreground">{label}</p> : null}
    </div>
  );
}
