import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard: incomplete published chains (LinkedIn follow-up
 * comments, Threads/X thread pieces still pending) must be surfaced on the
 * Schedule page too — not only on the Content Library card — and the
 * warning must offer the same resend action.
 */

const resendThreadsMutate = vi.fn();
const resendTwitterMutate = vi.fn();
const resendLinkedinMutate = vi.fn();
const deleteScheduleMutate = vi.fn();

const mockState: { schedules: any[]; content: any[] } = {
  schedules: [],
  content: [],
};

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Resilient mock: unknown hooks fall back to an idle stub, so adding a new
// hook to schedule.tsx does not break these tests.
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListSchedules: () => ({ data: mockState.schedules, isLoading: false }),
    useListContent: () => ({ data: mockState.content, isLoading: false }),
    useResendLinkedinComments: () => ({ mutate: resendLinkedinMutate, isPending: false }),
    useResendThreadsPosts: () => ({ mutate: resendThreadsMutate, isPending: false }),
    useResendTwitterPosts: () => ({ mutate: resendTwitterMutate, isPending: false }),
    useDeleteSchedule: () => ({ mutate: deleteScheduleMutate, isPending: false }),
    getListSchedulesQueryKey: () => ["schedules"],
    getListContentQueryKey: () => ["content"],
  });
});

// Imported after the mock so the mocked module is picked up.
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

const contentItem = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  title: "Long announcement",
  caption: "A caption",
  imagePath: null,
  platform: "threads",
  status: "published",
  permalink: null,
  ...overrides,
});

const schedule = (contentItemId = 7) => ({
  id: 1,
  contentItemId,
  platform: "threads",
  scheduledAt: new Date("2026-01-05T12:00:00Z").toISOString(),
});

describe("SchedulePage pending-chain warnings", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockState.schedules = [];
    mockState.content = [];
  });

  it("shows no warning when nothing is pending", () => {
    mockState.schedules = [schedule()];
    mockState.content = [contentItem()];
    renderPage();
    expect(screen.queryByTestId("text-schedule-threads-posts-pending-7")).toBeNull();
    expect(screen.queryByTestId("text-schedule-twitter-posts-pending-7")).toBeNull();
    expect(screen.queryByTestId("text-schedule-linkedin-comments-pending-7")).toBeNull();
  });

  it("shows the Threads warning and the resend button triggers the resend", () => {
    mockState.schedules = [schedule()];
    mockState.content = [contentItem({ threadsPostsPending: 2 })];
    renderPage();
    expect(
      screen.getByTestId("text-schedule-threads-posts-pending-7").textContent,
    ).toContain("2 Threads follow-up posts");
    fireEvent.click(screen.getByTestId("button-schedule-resend-threads-posts-7"));
    expect(resendThreadsMutate).toHaveBeenCalledWith(
      { id: 7 },
      expect.anything(),
    );
  });

  it("shows the X and LinkedIn warnings with resend actions", () => {
    mockState.schedules = [schedule()];
    mockState.content = [
      contentItem({ twitterPostsPending: 1, linkedinCommentsPending: 3 }),
    ];
    renderPage();
    expect(
      screen.getByTestId("text-schedule-twitter-posts-pending-7").textContent,
    ).toContain("1 X follow-up post");
    expect(
      screen.getByTestId("text-schedule-linkedin-comments-pending-7").textContent,
    ).toContain("3 LinkedIn follow-up comments");
    fireEvent.click(screen.getByTestId("button-schedule-resend-twitter-posts-7"));
    expect(resendTwitterMutate).toHaveBeenCalledWith({ id: 7 }, expect.anything());
    fireEvent.click(screen.getByTestId("button-schedule-resend-linkedin-comments-7"));
    expect(resendLinkedinMutate).toHaveBeenCalledWith({ id: 7 }, expect.anything());
  });
});

/**
 * Regression guard: the "Remove this scheduled post?" confirmation must use an
 * in-app dialog. Native confirm() is silently blocked inside the sandboxed
 * preview iframe, making the button appear dead.
 */
describe("SchedulePage delete confirmation dialog", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockState.schedules = [schedule()];
    mockState.content = [contentItem()];
  });

  it("opens an in-app dialog instead of calling native confirm()", () => {
    const nativeConfirm = vi.fn();
    vi.stubGlobal("confirm", nativeConfirm);
    renderPage();
    fireEvent.click(screen.getByTestId("button-delete-schedule-1"));
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("Remove this scheduled post?")).toBeTruthy();
    expect(deleteScheduleMutate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("cancel leaves the schedule untouched", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("button-delete-schedule-1"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(deleteScheduleMutate).not.toHaveBeenCalled();
  });

  it("confirming runs the delete mutation", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("button-delete-schedule-1"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(deleteScheduleMutate).toHaveBeenCalledWith(
      { id: 1 },
      expect.anything(),
    );
  });
});
