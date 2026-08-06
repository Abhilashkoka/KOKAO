/**
 * The Custom AI Providers card's per-provider "Test" action.
 *
 * The button runs one cheap live request per enabled use case server-side;
 * the card must show clear per-use-case pass/fail with the provider's own
 * error message, and disable the action while a test is running or when no
 * use case is enabled.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: {
  providers: Array<Record<string, unknown>>;
  testResponse:
    | { results: Array<{ useCase: string; ok: boolean; message: string }> }
    | null;
  testError: unknown;
} = {
  providers: [],
  testResponse: null,
  testError: null,
};

const testMutate = vi.fn(
  (
    vars: { providerId: string },
    opts?: {
      onSuccess?: (r: unknown) => void;
      onError?: (e: unknown) => void;
      onSettled?: () => void;
    },
  ) => {
    if (mockState.testError) opts?.onError?.(mockState.testError);
    else if (mockState.testResponse) opts?.onSuccess?.(mockState.testResponse);
    opts?.onSettled?.();
  },
);

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminListCustomAiProviders: () => ({
      data: { providers: mockState.providers },
      isLoading: false,
    }),
    useAdminTestCustomAiProvider: () => ({ mutate: testMutate, isPending: false }),
  });
});

vi.mock("@/lib/features", () => ({
  useFeatureFlags: () => ({ flags: {}, isLoading: false }),
}));

import { CustomAiProvidersCard } from "./ai-tab";

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: "custom:42",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    hasKey: true,
    textEnabled: true,
    imageEnabled: true,
    videoEnabled: false,
    ...overrides,
  };
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CustomAiProvidersCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  testMutate.mockClear();
  mockState.providers = [provider()];
  mockState.testResponse = null;
  mockState.testError = null;
});

describe("CustomAiProvidersCard test action", () => {
  it("shows per-use-case pass/fail with the provider's error message", async () => {
    mockState.testResponse = {
      results: [
        { useCase: "text", ok: true, message: "Chat completion succeeded (model m-1)." },
        { useCase: "image", ok: false, message: "HTTP 401: Invalid API key provided" },
      ],
    };
    renderCard();
    await userEvent.click(screen.getByTestId("button-test-custom-provider-custom:42"));
    expect(testMutate).toHaveBeenCalledWith(
      { providerId: "custom:42" },
      expect.anything(),
    );
    await waitFor(() => {
      expect(screen.getByTestId("test-results-custom:42")).toBeTruthy();
    });
    expect(screen.getByTestId("badge-test-text-custom:42").textContent).toContain("Pass");
    expect(screen.getByTestId("badge-test-image-custom:42").textContent).toContain("Fail");
    expect(screen.getByText(/HTTP 401: Invalid API key provided/)).toBeTruthy();
  });

  it("shows a request-level failure message when the test call itself fails", async () => {
    mockState.testError = new Error("boom");
    renderCard();
    await userEvent.click(screen.getByTestId("button-test-custom-provider-custom:42"));
    await waitFor(() => {
      expect(screen.getByTestId("text-test-error-custom:42")).toBeTruthy();
    });
  });

  it("disables Test when no use case is enabled", () => {
    mockState.providers = [
      provider({ textEnabled: false, imageEnabled: false, videoEnabled: false }),
    ];
    renderCard();
    expect(
      (screen.getByTestId("button-test-custom-provider-custom:42") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
