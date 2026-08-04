/**
 * Regression guard for the notifications banner's action-link label.
 *
 * The verify-mismatch ("didn't stick") alert links to /ads?tab=history and
 * must read "View change history" — a regression here would show the old
 * "Reconnect now" label and send users hunting for a reconnect flow that
 * doesn't apply. Publish-outcome alerts link to /library and read
 * "View post"; everything else stays "Reconnect now".
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: { notifications: any[] } = { notifications: [] };

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListNotifications: () => ({
      data: mockState.notifications,
      isLoading: false,
    }),
    getListNotificationsQueryKey: () => ["notifications"],
  });
});

// Imported after the mock so the mocked module is picked up.
import { NotificationsBanner } from "./notifications-banner";

function renderBanner() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NotificationsBanner />
    </QueryClientProvider>,
  );
}

function makeNotification(id: number, linkUrl: string | null) {
  return {
    id,
    type: "alert",
    title: `Alert ${id}`,
    message: "Something needs attention",
    linkUrl,
  };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockState.notifications = [];
});

describe("NotificationsBanner link label", () => {
  it('labels the verify-mismatch /ads?tab=history link "View change history"', () => {
    mockState.notifications = [makeNotification(1, "/ads?tab=history")];
    renderBanner();
    const link = screen.getByText("View change history");
    expect(link).toBeTruthy();
    // It must NOT fall through to the reconnect label.
    expect(screen.queryByText("Reconnect now")).toBeNull();
    // The link points at the ads change-history deep link.
    expect(link.closest("a")?.getAttribute("href")).toBe("/ads?tab=history");
  });

  it('labels library links "View post" (with or without query params)', () => {
    mockState.notifications = [
      makeNotification(1, "/library"),
      makeNotification(2, "/library?item=42"),
    ];
    renderBanner();
    expect(screen.getAllByText("View post")).toHaveLength(2);
    expect(screen.queryByText("Reconnect now")).toBeNull();
  });

  it('labels connection alerts "Reconnect now" and renders no link without a URL', () => {
    mockState.notifications = [
      makeNotification(1, "/accounts"),
      makeNotification(2, null),
    ];
    renderBanner();
    expect(screen.getAllByText("Reconnect now")).toHaveLength(1);
    expect(screen.queryByText("View change history")).toBeNull();
  });
});
