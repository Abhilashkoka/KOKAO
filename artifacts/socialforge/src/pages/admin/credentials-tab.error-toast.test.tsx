import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard for admin credentials error toasts:
 * the shared ApiError exposes the parsed body on `.data` (never `.payload`),
 * so error handlers must go through apiErrorMessage. This drives a Google Ads
 * credentials save, fails it with a server-400-shaped ApiError, and asserts
 * the server's message reaches the toast description.
 */

const saveMutate = vi.fn();

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminGetGoogleAdsCredentials: () => ({
      data: { configured: false },
      isLoading: false,
    }),
    useAdminSaveGoogleAdsCredentials: () => ({
      mutate: saveMutate,
      isPending: false,
    }),
  });
});

// Imported after the mock so the mocked module is picked up.
import { GoogleAdsCredentialsCard } from "./credentials-tab";

// Mirrors the shared ApiError: parsed JSON body on `.data`, no `.payload`.
class FakeApiError extends Error {
  data: unknown;
  status: number;
  constructor(status: number, data: unknown) {
    super(`Request failed with status ${status}`);
    this.status = status;
    this.data = data;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("Google Ads credentials save error toast", () => {
  it("shows the server 400 message in the toast description", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <GoogleAdsCredentialsCard />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByTestId("input-google-ads-client-id"), {
      target: { value: "client-id-123" },
    });
    fireEvent.change(screen.getByTestId("input-google-ads-client-secret"), {
      target: { value: "secret-456" },
    });
    fireEvent.change(screen.getByTestId("input-google-ads-developer-token"), {
      target: { value: "dev-token-789" },
    });
    fireEvent.click(screen.getByTestId("button-save-google-ads-credentials"));

    expect(saveMutate).toHaveBeenCalledTimes(1);
    const options = saveMutate.mock.calls[0]![1] as {
      onError: (err: unknown) => void;
    };
    options.onError(
      new FakeApiError(400, {
        error: "Developer token is not valid for this OAuth client.",
      }),
    );

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "destructive",
        title: "Could not save",
        description: "Developer token is not valid for this OAuth client.",
      }),
    );
  });
});
