import { getCredits, getGetCreditsQueryKey } from "@workspace/api-client-react";
import type { QueryClient } from "@tanstack/react-query";

/** Discard any pre-payment read before publishing the post-payment balance. */
export async function refreshCreditBalance(client: QueryClient) {
  const queryKey = getGetCreditsQueryKey();
  await client.cancelQueries({ queryKey });
  return client.fetchQuery({
    queryKey,
    queryFn: ({ signal }) => getCredits({ signal, cache: "no-store" }),
    staleTime: 0,
  });
}