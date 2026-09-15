import {
  getCredits,
  getGetCreditsQueryKey,
  useGetCredits,
} from "@workspace/api-client-react";
import { focusManager, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

/**
 * Unified credit reads are shared by Settings, Studio, and Gamification. A
 * single query key means React Query shares the active request and polling
 * timer even when more than one of those surfaces is mounted.
 */
export const CREDIT_BALANCE_REFRESH_INTERVAL_MS = 30_000;

type RefreshState = {
  subscribers: number;
  timer: ReturnType<typeof setInterval> | null;
};

// Query observers each create their own refetchInterval timer. Settings,
// Studio, and Gamification can be mounted together, so keep one timer per
// QueryClient and let every observer consume the shared query result.
const refreshStates = new WeakMap<QueryClient, RefreshState>();

function subscribeToCreditRefresh(client: QueryClient): () => void {
  let state = refreshStates.get(client);
  if (!state) {
    state = { subscribers: 0, timer: null };
    refreshStates.set(client, state);
  }
  state.subscribers += 1;
  if (state.subscribers === 1) {
    state.timer = setInterval(() => {
      if (!focusManager.isFocused()) return;
      void client.refetchQueries({
        queryKey: getGetCreditsQueryKey(),
        type: "active",
      });
    }, CREDIT_BALANCE_REFRESH_INTERVAL_MS);
  }

  return () => {
    const current = refreshStates.get(client);
    if (!current) return;
    current.subscribers -= 1;
    if (current.subscribers > 0) return;
    if (current.timer) clearInterval(current.timer);
    refreshStates.delete(client);
  };
}

export function useCreditBalance() {
  const queryClient = useQueryClient();
  const result = useGetCredits({
    request: { cache: "no-store" },
    query: {
      queryKey: getGetCreditsQueryKey(),
      staleTime: 0,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
      refetchOnReconnect: "always",
    },
  });
  useEffect(() => subscribeToCreditRefresh(queryClient), [queryClient]);
  return result;
}

/**
 * Read the canonical wallet after a payment has been verified.
 *
 * Invalidating a query can leave a pre-payment request in flight. Cancel it
 * before the no-store read so a late response cannot put the old balance back
 * into the shared cache. fetchQuery writes the fresh result to that same cache
 * for every mounted balance consumer.
 */
export async function refreshCreditBalance(client: QueryClient) {
  const queryKey = getGetCreditsQueryKey();
  await client.cancelQueries({ queryKey });
  return client.fetchQuery({
    queryKey,
    queryFn: ({ signal }) => getCredits({ signal, cache: "no-store" }),
    staleTime: 0,
  });
}