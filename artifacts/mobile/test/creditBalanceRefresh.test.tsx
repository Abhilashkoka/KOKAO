import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { getGetCreditsQueryKey } from "@workspace/api-client-react";

import {
  refreshCreditBalance,
  useCreditBalance,
} from "@/lib/creditBalance";

let total = 500;
let shouldFail = false;
const fetchMock = vi.fn(async () => {
  if (shouldFail) throw new Error("network unavailable");
  return new Response(
    JSON.stringify({
      total,
      purchased: total,
      granted: 0,
      funded: false,
      mode: "shadow",
      history: [],
      legacyConversion: {
        pending: false,
        captionCredits: 0,
        imageCredits: 0,
        videoCredits: 0,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
});

function BalanceProbe() {
  const { data } = useCreditBalance();
  return <output data-testid="credit-total">{data?.total ?? "loading"}</output>;
}

function TwoBalanceProbes() {
  return (
    <>
      <BalanceProbe />
      <BalanceProbe />
    </>
  );
}

function renderProbe() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={client}>
      <BalanceProbe />
    </QueryClientProvider>,
  );
  return { client, ...rendered };
}

beforeEach(() => {
  total = 500;
  shouldFail = false;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  focusManager.setFocused(true);
});

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
});

describe("mobile unified credit balance refresh", () => {
  it("publishes a verified purchase total to the shared query cache", async () => {
    const { client } = renderProbe();
    await waitFor(() => expect(screen.getByTestId("credit-total").textContent).toBe("500"));

    total = 1350;
    await act(async () => {
      await refreshCreditBalance(client);
    });

    await waitFor(() =>
      expect(screen.getByTestId("credit-total").textContent).toBe("1350"),
    );
    expect(client.getQueryData(getGetCreditsQueryKey())).toMatchObject({ total: 1350 });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/credits",
      expect.objectContaining({ cache: "no-store" }),
    );
    client.clear();
  });

  it("uses one polling timer when multiple balance consumers are mounted", async () => {
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const { client } = (() => {
      const nextClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const rendered = render(
        <QueryClientProvider client={nextClient}>
          <TwoBalanceProbes />
        </QueryClientProvider>,
      );
      return { client: nextClient, ...rendered };
    })();

    await waitFor(() =>
      expect(screen.getAllByTestId("credit-total")[0].textContent).toBe("500"),
    );
    expect(
      intervalSpy.mock.calls.filter(
        ([, delay]) => delay === 30_000,
      ),
    ).toHaveLength(1);
    intervalSpy.mockRestore();
    client.clear();
  });

  it("refreshes on foreground and keeps the last visible balance after a background error", async () => {
    const { client } = renderProbe();
    await waitFor(() => expect(screen.getByTestId("credit-total").textContent).toBe("500"));

    focusManager.setFocused(false);
    total = 750;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    focusManager.setFocused(true);
    await waitFor(() => expect(screen.getByTestId("credit-total").textContent).toBe("750"));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    focusManager.setFocused(false);
    shouldFail = true;
    focusManager.setFocused(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(screen.getByTestId("credit-total").textContent).toBe("750"),
    );
    expect(client.getQueryData(getGetCreditsQueryKey())).toMatchObject({ total: 750 });
    client.clear();
  });
});