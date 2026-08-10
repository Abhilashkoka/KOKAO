/**
 * Getting-started checklist nudge:
 * - renders only for tenants who haven't published and haven't dismissed
 * - highlights the first incomplete step with its CTA
 * - dismiss persists via the API and emits analytics
 * - shown/step-clicked/dismissed analytics events fire with step context
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: {
  progress: Record<string, boolean> | undefined;
  dismiss: ReturnType<typeof vi.fn>;
} = { progress: undefined, dismiss: vi.fn() };

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetFirstPostProgress: () => ({
      data: mockState.progress,
      isLoading: false,
    }),
    useDismissFirstPostNudge: () => ({
      mutate: mockState.dismiss,
      isPending: false,
    }),
    getGetFirstPostProgressQueryKey: () => ["first-post-progress"],
  });
});

const trackSpy = vi.fn();
vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => trackSpy(...args),
}));

import { GettingStartedChecklist } from "./getting-started-checklist";

function renderChecklist() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <GettingStartedChecklist />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockState.progress = undefined;
  mockState.dismiss = vi.fn();
});

describe("GettingStartedChecklist", () => {
  it("renders nothing while loading, when published, or when dismissed", () => {
    renderChecklist();
    expect(screen.queryByTestId("checklist-getting-started")).toBeNull();

    mockState.progress = {
      generated: true,
      saved: true,
      connected: true,
      published: true,
      dismissed: false,
    };
    renderChecklist();
    expect(screen.queryByTestId("checklist-getting-started")).toBeNull();

    mockState.progress = {
      generated: false,
      saved: false,
      connected: false,
      published: false,
      dismissed: true,
    };
    renderChecklist();
    expect(screen.queryByTestId("checklist-getting-started")).toBeNull();
  });

  it("shows the checklist with the first incomplete step's CTA and emits the shown event", () => {
    mockState.progress = {
      generated: true,
      saved: true,
      connected: false,
      published: false,
      dismissed: false,
    };
    renderChecklist();
    expect(screen.getByTestId("checklist-getting-started")).toBeTruthy();
    expect(screen.getByText("2 of 4 steps done — you're close.")).toBeTruthy();

    // Only the next incomplete step (connect) shows a CTA.
    const cta = screen.getByTestId("button-step-connect");
    expect(cta.textContent).toContain("Connect account");
    expect(cta.closest("a")?.getAttribute("href")).toBe("/accounts");
    expect(screen.queryByTestId("button-step-generate")).toBeNull();
    expect(screen.queryByTestId("button-step-publish")).toBeNull();

    expect(trackSpy).toHaveBeenCalledWith("first_post_nudge_shown", {
      next_step: "connect",
      steps_done: 2,
    });

    // Clicking the CTA emits the step-clicked event.
    fireEvent.click(cta);
    expect(trackSpy).toHaveBeenCalledWith("first_post_nudge_step_clicked", {
      step: "connect",
    });
  });

  it("dismiss calls the mutation and emits the dismissed event", () => {
    mockState.progress = {
      generated: false,
      saved: false,
      connected: false,
      published: false,
      dismissed: false,
    };
    renderChecklist();
    fireEvent.click(screen.getByTestId("button-dismiss-checklist"));
    expect(mockState.dismiss).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith("first_post_nudge_dismissed", {
      next_step: "generate",
      steps_done: 0,
    });
  });
});
