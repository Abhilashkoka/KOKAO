/**
 * Regression guard: alert deep links may use the same ?item=<id> shape the
 * library uses (e.g. /schedule?item=<contentItemId>). When the linked post
 * was deleted (or the id is nonsense), the schedule page must load normally
 * and show the same clear "that post no longer exists" notice the library
 * shows — never a silent no-op. Mirrors library.deleted-deep-link.test.tsx.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const toastSpy = vi.fn();
const setLocationSpy = vi.fn();
const mockRoute = { search: "" };

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("wouter", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("wouter");
  return {
    ...actual,
    useSearch: () => mockRoute.search,
    useLocation: () => ["/schedule", setLocationSpy],
  };
});

const mockState: { content: any[]; schedules: any[] } = {
  content: [],
  schedules: [],
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListContent: () => ({ data: mockState.content, isLoading: false }),
    useListSchedules: () => ({ data: mockState.schedules, isLoading: false }),
    getListContentQueryKey: () => ["content"],
    getListSchedulesQueryKey: () => ["schedules"],
  });
});

// Imported after the mocks so the mocked modules are picked up.
import { SchedulePage } from "./schedule";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SchedulePage />
    </QueryClientProvider>,
  );
}

const existingItem = {
  id: 7,
  title: "Still here",
  caption: "A caption",
  platform: "facebook",
  status: "draft",
  imagePath: null,
  permalink: null,
};

const existingSchedule = {
  id: 1,
  contentItemId: 7,
  platform: "facebook",
  status: "pending",
  scheduledAt: new Date("2026-08-01T12:00:00Z").toISOString(),
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockState.content = [existingItem];
  mockState.schedules = [existingSchedule];
  mockRoute.search = "";
});

describe("Schedule deep link to a deleted post", () => {
  it("shows the not-found notice and cleans the URL instead of a silent no-op", async () => {
    mockRoute.search = "item=99999";
    renderPage();

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "That post no longer exists",
          description: "It may have been deleted after this alert was sent.",
        }),
      );
    });
    // Not a destructive/raw error toast.
    expect(toastSpy.mock.calls[0][0].variant).toBeUndefined();
    // Schedule page still rendered normally with the existing schedule.
    expect(screen.getByText("Still here")).toBeTruthy();
    // URL cleaned so a refresh doesn't re-trigger the notice.
    expect(setLocationSpy).toHaveBeenCalledWith("/schedule", { replace: true });
  });

  it("shows the notice for a malformed (non-numeric) item id too", async () => {
    mockRoute.search = "item=not-a-number";
    renderPage();

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "That post no longer exists" }),
      );
    });
    expect(setLocationSpy).toHaveBeenCalledWith("/schedule", { replace: true });
  });

  it("shows no notice when the linked item still exists, but cleans the URL", async () => {
    mockRoute.search = "item=7";
    renderPage();

    await waitFor(() => {
      expect(setLocationSpy).toHaveBeenCalledWith("/schedule", { replace: true });
    });
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "That post no longer exists" }),
    );
    expect(screen.getByText("Still here")).toBeTruthy();
  });
});
