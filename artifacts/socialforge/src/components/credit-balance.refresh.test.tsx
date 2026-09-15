import { expect, it, vi, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getGetCreditsQueryKey } from "@workspace/api-client-react";
import { CreditBalancePill } from "./credit-balance";
import { refreshCreditBalance } from "@/lib/refresh-credit-balance";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("updates an already mounted sidebar from 500 to 1350 after the confirmed purchase", async () => {
  let total = 500;
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    total, purchased: total, granted: 0, funded: false, mode: "shadow",
  }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><CreditBalancePill /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByTestId("badge-credit-balance").textContent).toContain("500"));
  total = 1350;
  await act(async () => { await refreshCreditBalance(client); });
  await waitFor(() => expect(screen.getByTestId("badge-credit-balance").textContent).toContain("1350"));
  expect(client.getQueryData(getGetCreditsQueryKey())).toMatchObject({ total: 1350 });
  expect(fetchMock).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ cache: "no-store" }));
  client.clear();
});