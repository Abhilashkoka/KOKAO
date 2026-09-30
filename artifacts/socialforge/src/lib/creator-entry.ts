/**
 * Auth return destinations must be paths on this app, never arbitrary URLs.
 * Decode only through URLSearchParams at the call site; reject encoded path
 * separators too so a second decoding pass cannot turn a path into //host.
 */
export function safeReturnPath(value: string | null, basePath = ""): string | null {
  if (!value || /[\\\u0000-\u001f\u007f]/.test(value) ||
      /%2f|%5c|%00|%0a|%0d/i.test(value)) {
    return null;
  }
  let path = value;
  // Clerk sometimes rewrites redirect_url to an absolute URL on this origin
  // when switching between its embedded sign-in and sign-up flows.
  if (/^https?:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      if (url.origin !== window.location.origin || url.username || url.password) return null;
      path = `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return null;
    }
  }
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) {
    path = path.slice(basePath.length) || "/";
  }
  if (path.startsWith("//")) return null;
  try {
    const parsed = new URL(path, "https://kokao.invalid");
    if (parsed.origin !== "https://kokao.invalid" || parsed.pathname !== path.split(/[?#]/)[0]) {
      return null;
    }
  } catch {
    return null;
  }
  return path;
}

export function authEntryTarget(search: string, basePath = ""): string {
  return safeReturnPath(new URLSearchParams(search).get("redirect_url"), basePath) ?? "/dashboard";
}

const pendingAuthTargetKey = "kokao:pending-auth-return";

/**
 * Clerk may drop the query string on its internal factor/OAuth callback URLs.
 * Keep only an in-progress, tab-scoped destination; entering a fresh auth page
 * without a redirect or completing authentication removes it.
 */
export function authFlowTarget(search: string, pathname: string, basePath = ""): string {
  const requested = new URLSearchParams(search).get("redirect_url");
  if (requested !== null) return safeReturnPath(requested, basePath) ?? "/dashboard";
  if (/\/(?:sign-in|sign-up)\/.+/.test(pathname)) {
    try {
      return safeReturnPath(sessionStorage.getItem(pendingAuthTargetKey), basePath) ?? "/dashboard";
    } catch {
      return "/dashboard";
    }
  }
  return "/dashboard";
}

export function updateAuthFlowTarget(search: string, pathname: string, signedIn: boolean, basePath = ""): void {
  try {
    if (signedIn) {
      sessionStorage.removeItem(pendingAuthTargetKey);
      return;
    }
    const requested = new URLSearchParams(search).get("redirect_url");
    if (requested !== null) {
      const safe = safeReturnPath(requested, basePath);
      if (safe) sessionStorage.setItem(pendingAuthTargetKey, safe);
      else sessionStorage.removeItem(pendingAuthTargetKey);
    } else if (!/\/(?:sign-in|sign-up)\/.+/.test(pathname)) {
      sessionStorage.removeItem(pendingAuthTargetKey);
    }
  } catch {
    // Auth still works without tab storage; Clerk also carries its own return URL.
  }
}

export function authSwitchUrl(page: "sign-in" | "sign-up", target: string, basePath = ""): string {
  const safe = safeReturnPath(target, basePath) ?? "/dashboard";
  return `/${page}?redirect_url=${encodeURIComponent(safe)}`;
}