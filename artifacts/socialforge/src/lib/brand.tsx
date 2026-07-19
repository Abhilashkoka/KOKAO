import { createContext, useContext, useEffect } from "react";
import { useGetAppBrand } from "@workspace/api-client-react";
import type { AppBrand } from "@workspace/api-client-react";
import kokaoLockup from "@assets/kokao-lockup_1783325983377.svg";

const DEFAULT_APP_NAME = "KOKAO";

type BrandContextValue = {
  appName: string;
  logoUrl: string;
  iconUrl: string | null;
};

const BRAND_CACHE_KEY = "kokao-app-brand-cache";

/**
 * Last-known branding persisted locally so a page reload shows the custom
 * logo/name immediately instead of flashing the bundled default while the
 * /app-brand fetch is in flight.
 */
function readCachedBrand(): Partial<AppBrand> | null {
  try {
    const raw = localStorage.getItem(BRAND_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Partial<AppBrand>) : null;
  } catch {
    return null;
  }
}

function writeCachedBrand(brand: AppBrand) {
  try {
    localStorage.setItem(
      BRAND_CACHE_KEY,
      JSON.stringify({
        appName: brand.appName ?? null,
        logoUrl: brand.logoUrl ?? null,
        iconUrl: brand.iconUrl ?? null,
        primaryColor: brand.primaryColor ?? null,
        backgroundColor: brand.backgroundColor ?? null,
      }),
    );
  } catch {
    // Storage unavailable (private mode/quota) — flash-avoidance is best-effort.
  }
}

const BrandContext = createContext<BrandContextValue>({
  appName: DEFAULT_APP_NAME,
  logoUrl: kokaoLockup,
  iconUrl: null,
});

export function useBrand(): BrandContextValue {
  return useContext(BrandContext);
}

/**
 * Convert a `#rrggbb` / `#rgb` hex string to the `"H S% L%"` triplet the theme
 * tokens expect (used as `hsl(var(--token))`). Returns null on invalid input.
 */
function hexToHslTriplet(hex: string | null): string | null {
  if (!hex) return null;
  let value = hex.trim().replace(/^#/, "");
  if (value.length === 3) {
    value = value
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;

  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }

  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/**
 * WCAG relative luminance of a `#rrggbb` hex color, or null on invalid input.
 */
function hexLuminance(hex: string | null): number | null {
  if (!hex) return null;
  let value = hex.trim().replace(/^#/, "");
  if (value.length === 3) {
    value = value
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  const channel = (i: number) => {
    const c = parseInt(value.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function applyThemeColor(name: string, hex: string | null) {
  const root = document.documentElement;
  const triplet = hexToHslTriplet(hex);
  if (triplet) {
    root.style.setProperty(name, triplet);
  } else {
    root.style.removeProperty(name);
  }
}

const DEFAULT_FAVICON = "/favicon.svg";

function setFavicon(href: string | null) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  // Fall back to the bundled default so clearing a custom icon reverts live.
  link.href = href || DEFAULT_FAVICON;
}

/**
 * Fetches the platform branding and applies it globally: document title,
 * favicon, and theme colors. Also exposes the resolved logo/app name to the
 * tree via context, so nav/landing render the uploaded logo (falling back to
 * the bundled KOKAO lockup when nothing has been configured).
 */
export function BrandProvider({ children }: { children: React.ReactNode }) {
  const { data, isError } = useGetAppBrand();
  const fetched = data as AppBrand | undefined;
  // Until the fetch resolves, fall back to the last-known branding cached in
  // localStorage so reloads don't flash the bundled default logo.
  const cached = fetched ? null : readCachedBrand();
  const brand = fetched ?? cached ?? undefined;
  // Unresolved = no server answer yet AND nothing cached (first visit in a
  // fresh browser). In that state render a blank logo/name instead of
  // flashing the bundled default, which may not match the configured brand.
  // A failed fetch counts as resolved so an outage never leaves the UI
  // permanently blank — it falls back to the bundled default instead.
  const resolved = fetched !== undefined || isError || cached !== null;

  useEffect(() => {
    if (fetched) writeCachedBrand(fetched);
  }, [fetched]);

  const appName = resolved ? brand?.appName || DEFAULT_APP_NAME : "";
  const logoUrl = resolved ? brand?.logoUrl || kokaoLockup : "";
  const iconUrl = brand?.iconUrl ?? null;

  useEffect(() => {
    if (appName) document.title = appName;
  }, [appName]);

  useEffect(() => {
    setFavicon(iconUrl);
  }, [iconUrl]);

  useEffect(() => {
    applyThemeColor("--primary", brand?.primaryColor ?? null);
    applyThemeColor("--ring", brand?.primaryColor ?? null);
    applyThemeColor("--background", brand?.backgroundColor ?? null);

    // Keep text on solid primary-filled surfaces (e.g. glass buttons)
    // readable for any brand color: pick near-black or white foreground
    // based on the primary color's luminance (contrast-ratio midpoint).
    const root = document.documentElement;
    const luminance = hexLuminance(brand?.primaryColor ?? null);
    if (luminance === null) {
      root.style.removeProperty("--primary-foreground");
    } else {
      root.style.setProperty(
        "--primary-foreground",
        luminance > 0.179 ? "240 6% 10%" : "0 0% 100%",
      );
    }
  }, [brand?.primaryColor, brand?.backgroundColor]);

  return (
    <BrandContext.Provider value={{ appName, logoUrl, iconUrl }}>
      {children}
    </BrandContext.Provider>
  );
}
