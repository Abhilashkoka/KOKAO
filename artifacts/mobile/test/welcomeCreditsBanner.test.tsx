/**
 * WelcomeCreditsBanner contract: renders only while an unread
 * `signup_credits_granted` notification is in the (unread-only) list;
 * dismissing marks that exact notification read and, once the refreshed
 * list no longer contains it, the banner disappears — including on a
 * completely fresh mount (app restart with a new query cache).
 *
 * The list hook is backed by a real react-query cache reading from a
 * mutable `serverState` (mock DB), so dismissal flows exactly like
 * production: mutate -> onSuccess invalidate -> refetch -> re-render.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const routerPush = vi.fn();

type ServerNotification = {
  id: number;
  type: string;
  title: string;
  message: string;
  linkUrl: string | null;
  readAt: string | null;
  createdAt: string;
};

// Mock server DB: the "list" endpoint returns unread rows only, mirroring
// the real GET /notifications default.
const serverState: { rows: ServerNotification[]; failMarkRead: unknown } = {
  rows: [],
  failMarkRead: null,
};
const markReadCalls: number[] = [];

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  const { useQuery } = await import("@tanstack/react-query");
  const keyFor = (params?: unknown) => ["notifications", params ?? null];
  return createApiClientMock({
    getListNotificationsQueryKey: (params?: unknown) => keyFor(params),
    useListNotifications: (params?: unknown) =>
      useQuery({
        queryKey: keyFor(params),
        queryFn: async () => serverState.rows.filter((r) => r.readAt === null),
      }),
    useMarkNotificationRead: () => {
      // Simulate the real mutation: server marks the row read, then the
      // component's onSuccess invalidates the list query.
      const mutate = (
        vars: { id: number },
        opts?: { onSuccess?: () => void; onError?: (err: unknown) => void },
      ) => {
        markReadCalls.push(vars.id);
        if (serverState.failMarkRead) {
          opts?.onError?.(serverState.failMarkRead);
          return;
        }
        const row = serverState.rows.find((r) => r.id === vars.id);
        if (row) row.readAt = new Date("2026-07-28T10:00:00Z").toISOString();
        opts?.onSuccess?.();
      };
      return { mutate, isPending: false };
    },
  });
});

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: routerPush, back: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@expo/vector-icons", () => ({
  Feather: Object.assign(() => null, { glyphMap: {} }),
}));

import { WelcomeCreditsBanner, SIGNUP_CREDITS_GRANTED } from "../components/WelcomeCreditsBanner";

function seedWelcome(): ServerNotification {
  const row: ServerNotification = {
    id: 41,
    type: SIGNUP_CREDITS_GRANTED,
    title: "Welcome! You received free credits",
    message: "Your new workspace received 10 caption credits to get started.",
    linkUrl: "/studio",
    readAt: null,
    createdAt: new Date("2026-07-27T09:00:00Z").toISOString(),
  };
  serverState.rows = [row];
  return row;
}

function renderBanner() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <WelcomeCreditsBanner />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  serverState.rows = [];
  serverState.failMarkRead = null;
  markReadCalls.length = 0;
  routerPush.mockClear();
});

afterEach(() => cleanup());

describe("WelcomeCreditsBanner", () => {
  it("renders for an unread signup_credits_granted notification", async () => {
    seedWelcome();
    renderBanner();
    expect(
      await screen.findByTestId("banner-welcome-credits"),
    ).toBeTruthy();
    expect(
      screen.getByText("Welcome! You received free credits"),
    ).toBeTruthy();
  });

  it("dismiss marks the exact notification read and hides the banner", async () => {
    const row = seedWelcome();
    renderBanner();
    fireEvent.click(await screen.findByTestId("button-dismiss-welcome"));

    // Marked read on the "server" (mock DB persisted the readAt).
    expect(markReadCalls).toEqual([row.id]);
    expect(serverState.rows[0].readAt).not.toBeNull();

    // Invalidation refetches the unread-only list; banner unmounts.
    await waitFor(() =>
      expect(screen.queryByTestId("banner-welcome-credits")).toBeNull(),
    );
  });

  it("stays gone on a fresh mount after dismissal (app restart)", async () => {
    const row = seedWelcome();
    renderBanner();
    fireEvent.click(await screen.findByTestId("button-dismiss-welcome"));
    await waitFor(() =>
      expect(screen.queryByTestId("banner-welcome-credits")).toBeNull(),
    );
    cleanup();

    // Fresh mount with a brand-new QueryClient = cold app start; the
    // server row is still read, so the unread list is empty.
    expect(row.readAt).not.toBeNull();
    renderBanner();
    await waitFor(() =>
      // give the fresh query a tick to resolve before asserting absence
      expect(screen.queryByTestId("banner-welcome-credits")).toBeNull(),
    );
    expect(markReadCalls).toEqual([row.id]);
  });

  it("shows an error message when dismiss fails and allows retry", async () => {
    const row = seedWelcome();
    serverState.failMarkRead = { data: { error: "You appear to be offline" } };
    renderBanner();
    fireEvent.click(await screen.findByTestId("button-dismiss-welcome"));

    // Failure is surfaced inline; banner stays visible and dismissible.
    expect(
      (await screen.findByTestId("text-dismiss-error")).textContent,
    ).toContain("You appear to be offline");
    expect(screen.getByTestId("banner-welcome-credits")).toBeTruthy();
    expect(row.readAt).toBeNull();

    // Retry succeeds: error clears and the banner disappears.
    serverState.failMarkRead = null;
    fireEvent.click(screen.getByTestId("button-dismiss-welcome"));
    expect(markReadCalls).toEqual([row.id, row.id]);
    await waitFor(() =>
      expect(screen.queryByTestId("banner-welcome-credits")).toBeNull(),
    );
  });

  it("falls back to a generic dismiss error message when the failure has no body", async () => {
    seedWelcome();
    serverState.failMarkRead = new Error("network down");
    renderBanner();
    fireEvent.click(await screen.findByTestId("button-dismiss-welcome"));
    expect(
      (await screen.findByTestId("text-dismiss-error")).textContent,
    ).toContain("Couldn't dismiss right now");
  });

  it("renders nothing when there is no unread welcome notification", async () => {
    renderBanner();
    await waitFor(() =>
      expect(screen.queryByTestId("banner-welcome-credits")).toBeNull(),
    );
  });
});
