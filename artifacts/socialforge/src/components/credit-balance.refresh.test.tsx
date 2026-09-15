import { expect, it, vi, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { getGetCreditsQueryKey } from "@workspace/api-client-react";
import { CreditBalancePill } from "./credit-balance";
import { refreshCreditBalance } from "@/lib/refresh-credit-balance";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); focusManager.setFocused(undefined); });

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

it("refreshes after returning to the browser without remounting or clearing a draft", async () => {
  let total = 500;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    total, purchased: total, granted: 0, funded: false, mode: "shadow",
  }), { status: 200, headers: { "content-type": "application/json" } })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>
    <input aria-label="Draft" defaultValue="Keep my unsaved story" />
    <CreditBalancePill />
  </QueryClientProvider>);
  await waitFor(() => expect(screen.getByTestId("badge-credit-balance").textContent).toContain("500"));
  const draft = screen.getByLabelText("Draft");
  act(() => focusManager.setFocused(false));
  total = 1350;
  act(() => focusManager.setFocused(true));
  await waitFor(() => expect(screen.getByTestId("badge-credit-balance").textContent).toContain("1350"));
  expect(screen.getByLabelText("Draft")).toBe(draft);
  expect((draft as HTMLInputElement).value).toBe("Keep my unsaved story");
  client.clear();
});

it("polls delayed payment updates quietly while the app is active", async () => {
  let total = 500;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    total, purchased: total, granted: 0, funded: false, mode: "shadow",
  }), { status: 200, headers: { "content-type": "application/json" } })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><CreditBalancePill /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByTestId("badge-credit-balance").textContent).toContain("500"));
  vi.useFakeTimers();
  // Remount only the test observer to install the interval under the fake clock.
  cleanup();
  render(<QueryClientProvider client={client}><CreditBalancePill /></QueryClientProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  total = 1350;
  await act(async () => { await vi.advanceTimersByTimeAsync(30_100); });
  expect(screen.getByTestId("badge-credit-balance").textContent).toContain("1350");
  client.clear();
});