import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { useGetAppBrand, getGetAppBrandQueryKey } from "@workspace/api-client-react";

const domain = process.env.EXPO_PUBLIC_DOMAIN;

const DEFAULT_APP_NAME = "KOKAO";

const BRAND_CACHE_KEY = "kokao-app-brand-cache";

type CachedBrand = {
  appName: string | null;
  logoUrl: string | null;
  iconUrl: string | null;
};

// Module-level mirror of the persisted brand so every mount after the first
// hydration renders the current logo synchronously (no flash of the bundled
// default). `undefined` = AsyncStorage not read yet; `null` = nothing cached.
let memoryCache: CachedBrand | null | undefined;

async function readPersistedBrand(): Promise<CachedBrand | null> {
  try {
    const raw = await AsyncStorage.getItem(BRAND_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      appName: typeof parsed.appName === "string" ? parsed.appName : null,
      logoUrl: typeof parsed.logoUrl === "string" ? parsed.logoUrl : null,
      iconUrl: typeof parsed.iconUrl === "string" ? parsed.iconUrl : null,
    };
  } catch {
    return null;
  }
}

function toAbsoluteUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  if (!domain) return null;
  return `https://${domain}${path}`;
}

/** Test-only: reset the module-level cache between test cases. */
export function __resetBrandCacheForTests() {
  memoryCache = undefined;
}

export function useAppBrand() {
  const { data, isLoading, isError } = useGetAppBrand({
    query: { queryKey: getGetAppBrandQueryKey(), staleTime: 5 * 60 * 1000 },
  });

  const [cached, setCached] = useState<CachedBrand | null | undefined>(memoryCache);

  // Hydrate the durable on-device copy once per app session.
  useEffect(() => {
    if (memoryCache !== undefined) return;
    let cancelled = false;
    readPersistedBrand().then((value) => {
      if (memoryCache === undefined) memoryCache = value;
      if (!cancelled) setCached(memoryCache);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Whenever the server reports branding (including a newer logo URL, or that
  // branding was cleared), refresh the persisted copy so the NEXT launch
  // renders the current logo from the first frame.
  useEffect(() => {
    if (!data) return;
    const next: CachedBrand = {
      appName: data.appName ?? null,
      logoUrl: data.logoUrl ?? null,
      iconUrl: data.iconUrl ?? null,
    };
    memoryCache = next;
    setCached(next);
    AsyncStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(next)).catch(() => {
      // Persistence is best-effort; the in-memory copy still covers this session.
    });
  }, [data]);

  // Server answer wins; otherwise fall back to the persisted last-known brand.
  const brand = data ?? cached ?? undefined;
  // Resolved = we know what to show: a server answer, a persisted brand, or a
  // failed fetch with nothing cached (fall back to the bundled default rather
  // than staying blank forever). Unresolved only on a genuinely first-ever
  // launch while the fetch and cache read are both still in flight — callers
  // should render nothing rather than flash the bundled default mark.
  const resolved =
    data !== undefined || (cached !== undefined && cached !== null) || isError;

  return {
    isLoading,
    resolved,
    appName: resolved ? (brand?.appName || DEFAULT_APP_NAME) : "",
    logoUrl: toAbsoluteUrl(brand?.logoUrl),
    iconUrl: toAbsoluteUrl(brand?.iconUrl),
  };
}
