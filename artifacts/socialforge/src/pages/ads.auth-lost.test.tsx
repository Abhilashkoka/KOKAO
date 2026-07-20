import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard for the "second reload" bug: when a campaigns/detail
 * fetch fails because the ad platform revoked our grant, the server flags
 * the error payload with `authLost: true` and the page must refetch the
 * ad-connections list so the Reconnect prompt appears without a reload.
 *
 * The generated client throws ApiError with the response body on `.data`,
 * so the hook must recognize that shape (plus the legacy `.payload`).
 */

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    getListAdConnectionsQueryKey: () => ["/api/ads/connections"],
  });
});

import { useRefreshConnectionsOnAuthLoss } from "./ads";

function Probe({ error }: { error: unknown }) {
  useRefreshConnectionsOnAuthLoss(error);
  return null;
}

describe("useRefreshConnectionsOnAuthLoss", () => {
  let queryClient: QueryClient;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    queryClient = new QueryClient();
    invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  function renderWithError(error: unknown) {
    return render(
      <QueryClientProvider client={queryClient}>
        <Probe error={error} />
      </QueryClientProvider>,
    );
  }

  it("invalidates the connections query when the ApiError data carries authLost", () => {
    renderWithError({ data: { error: "Access token expired", authLost: true } });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["/api/ads/connections"],
    });
  });

  it("also recognizes the legacy payload error shape", () => {
    renderWithError({ payload: { error: "Access token expired", authLost: true } });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["/api/ads/connections"],
    });
  });

  it("does nothing for ordinary errors without authLost", () => {
    renderWithError({ data: { error: "Rate limited" } });
    renderWithError(null);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
