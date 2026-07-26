import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: {
  notifications: any[] | undefined;
  lastMarkReadVars: any;
} = {
  notifications: undefined,
  lastMarkReadVars: null,
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListNotifications: () => ({ data: mockState.notifications }),
    useMarkNotificationRead: () => ({
      isPending: false,
      mutate: (vars: unknown, opts: any) => {
        mockState.lastMarkReadVars = vars;
        // Simulate the server marking it read: the row disappears from the
        // unread list, so a refetch would drop the banner.
        mockState.notifications = mockState.notifications?.filter(
          (n) => n.id !== (vars as { id: number }).id,
        );
        opts?.onSuccess?.({ ok: true });
      },
    }),
    useMarkAllNotificationsRead: () => ({ isPending: false, mutate: vi.fn() }),
    getListNotificationsQueryKey: () => ["/notifications"],
  });
});

import { WelcomeBanner } from "./welcome-banner";
import { NotificationsBanner } from "./notifications-banner";

const welcomeNotification = {
  id: 7,
  type: "signup_credits_granted",
  platform: null,
  title: "Welcome! You received free credits",
  message:
    "Your new workspace received 10 caption credits, 5 image credits and 2 video credits to get started. They are already in your balance — head to the Studio to create your first post.",
  linkUrl: "/studio",
  createdAt: new Date().toISOString(),
  readAt: null,
};

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

describe("WelcomeBanner", () => {
  beforeEach(() => {
    cleanup();
    mockState.notifications = undefined;
    mockState.lastMarkReadVars = null;
  });

  it("renders nothing when there is no unread signup-credits notification", () => {
    mockState.notifications = [
      { ...welcomeNotification, id: 1, type: "social_connection_failed" },
    ];
    renderWithClient(<WelcomeBanner />);
    expect(screen.queryByTestId("banner-welcome-credits")).toBeNull();
  });

  it("renders nothing while notifications are still loading", () => {
    renderWithClient(<WelcomeBanner />);
    expect(screen.queryByTestId("banner-welcome-credits")).toBeNull();
  });

  it("shows the credit message and a Start creating link to /studio", () => {
    mockState.notifications = [welcomeNotification];
    renderWithClient(<WelcomeBanner />);
    expect(screen.getByTestId("banner-welcome-credits")).toBeTruthy();
    expect(
      screen.getByText(/10 caption credits, 5 image credits and 2 video credits/),
    ).toBeTruthy();
    const button = screen.getByTestId("button-start-creating");
    expect(button.closest("a")?.getAttribute("href")).toBe("/studio");
  });

  it("dismissing marks the notification read", () => {
    mockState.notifications = [welcomeNotification];
    renderWithClient(<WelcomeBanner />);
    fireEvent.click(screen.getByTestId("button-dismiss-welcome"));
    expect(mockState.lastMarkReadVars).toEqual({ id: 7 });
  });

  it("is excluded from the alert-styled notifications banner", () => {
    mockState.notifications = [welcomeNotification];
    renderWithClient(<NotificationsBanner />);
    expect(screen.queryByText("Welcome! You received free credits")).toBeNull();
  });
});
