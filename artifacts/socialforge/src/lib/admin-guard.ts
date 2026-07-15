import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { getGetMeQueryKey } from "@workspace/api-client-react";

// External store tracking whether an /admin request has returned 403 for the
// current session. Set by the global query/mutation cache error handlers so a
// live superadmin revocation immediately hides cached admin data everywhere,
// without waiting for a manual refresh.

let revoked = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function useAdminAccessRevoked(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => revoked,
  );
}

export function resetAdminAccessRevoked(): void {
  if (!revoked) return;
  revoked = false;
  emit();
}

function isAdminUrl(url: string | undefined): boolean {
  return typeof url === "string" && /\/admin(\/|\?|$)/.test(url);
}

// Generated query keys look like `/api/admin/tenants`.
function isAdminQueryKey(key: readonly unknown[]): boolean {
  return typeof key[0] === "string" && /^\/api\/admin(\/|$)/.test(key[0]);
}

/**
 * Inspect an error from any query or mutation. When it is a 403 from an
 * /admin endpoint: mark admin access as revoked, purge all cached admin
 * query data (tenant list, plan catalog, policies, credentials, audit logs),
 * and refetch /me so the nav and role-gated UI update.
 */
export function handleAdminForbidden(queryClient: QueryClient, error: unknown): void {
  if (
    typeof error !== "object" ||
    error === null ||
    (error as { status?: number }).status !== 403 ||
    !isAdminUrl((error as { url?: string }).url)
  ) {
    return;
  }

  const first = !revoked;
  revoked = true;

  // Drop stale admin data outright so it can never render again.
  queryClient.removeQueries({
    predicate: (query) => isAdminQueryKey(query.queryKey),
  });

  if (first) {
    emit();
    queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
  }
}

/** Called when an /admin query succeeds — access is (again) valid. */
export function handleAdminQuerySuccess(queryKey: readonly unknown[]): void {
  if (isAdminQueryKey(queryKey)) resetAdminAccessRevoked();
}
