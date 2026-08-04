/**
 * The admin branding editor must refresh the first-paint brand cache
 * (localStorage) the moment a save succeeds, so a reload never flashes the
 * replaced logo while the fresh fetch is in flight.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const SAVED_BRAND = {
  appName: "Acme",
  logoUrl: "/api/storage/public-objects/brand/logo-new",
  iconUrl: null,
  primaryColor: "#112233",
  backgroundColor: null,
  loaderAnimationUrl: null,
};

const mutateAsyncMock = vi.fn(async () => SAVED_BRAND);

// IMPORTANT: hook results must be referentially stable across renders — the
// settings component re-seeds its form state whenever the brand object
// identity changes, so a fresh object per render would loop forever.
const ME = { data: { isSuperadmin: true } };
const CURRENT_BRAND = {
  data: {
    appName: "Old",
    logoUrl: "/api/storage/public-objects/brand/logo-old",
    iconUrl: null,
    primaryColor: null,
    backgroundColor: null,
    loaderAnimationUrl: null,
  },
};
const UPDATE_BRAND = { mutateAsync: mutateAsyncMock, isPending: false };

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetMe: () => ME,
    useGetAppBrand: () => CURRENT_BRAND,
    useUpdateAppBrand: () => UPDATE_BRAND,
  });
});

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { AppBrandingSettings } from "./app-branding-settings";

const CACHE_KEY = "kokao-app-brand-cache";

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AppBrandingSettings />
    </QueryClientProvider>,
  );
}

describe("AppBrandingSettings brand cache refresh", () => {
  beforeEach(() => {
    localStorage.clear();
    mutateAsyncMock.mockClear();
  });

  it("writes the saved brand into the first-paint cache on save", async () => {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ appName: "Stale", logoUrl: "/stale.png" }),
    );
    renderSettings();

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}");
      expect(cached.logoUrl).toBe("/api/storage/public-objects/brand/logo-new");
      expect(cached.appName).toBe("Acme");
    });
    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
  });
});
