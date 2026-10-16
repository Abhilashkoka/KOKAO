import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const approve = vi.fn();
let jobs: unknown[] = [];

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetMe: () => ({ data: { tenant: { id: 1 } } }),
    useListVideoJobs: () => ({ data: jobs, isLoading: false }),
    useApproveVideoStoryboard: () => ({ mutate: approve, isPending: false }),
    useDiscardVideoStoryboard: () => ({ mutate: vi.fn(), isPending: false }),
  });
});
vi.mock("@/components/video-download-button", () => ({ VideoDownloadButton: () => null }));
vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
  useLocation: () => ["/results", vi.fn()],
  useSearch: () => "",
}));

const { ResultsPage } = await import("./results");

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ResultsPage />
    </QueryClientProvider>,
  );
}

const waiting = {
  id: 7,
  status: "awaiting_review",
  aspectRatio: "9:16",
  prompt: "A saree sway",
  guidedStoryDraftId: null,
  storyboard: { scenes: [{ id: "s1", visual: "Model sways", text: "", durationSec: 5, previewPath: null }] },
  compliance: null,
};

describe("Results review", () => {
  beforeEach(() => {
    approve.mockReset();
  });

  it("approves a waiting plan without leaving the page", () => {
    jobs = [waiting];
    renderPage();
    expect(screen.getByText("Model sways")).toBeTruthy();
    fireEvent.click(screen.getByTestId("results-approve"));
    expect(approve).toHaveBeenCalledWith({ jobId: 7, data: undefined }, expect.any(Object));
  });

  it("requires the compliance acknowledgement before approving", () => {
    jobs = [{ ...waiting, compliance: { report: { blocking: 0, review: 1, reviewAcknowledged: false } } }];
    renderPage();
    const button = screen.getByTestId("results-approve") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(button);
    expect(approve).toHaveBeenCalledWith(
      { jobId: 7, data: { acknowledgeComplianceReview: true } },
      expect.any(Object),
    );
  });

  it("sends guided stories to the studio", () => {
    jobs = [{ ...waiting, guidedStoryDraftId: 3 }];
    renderPage();
    expect(screen.queryByTestId("results-approve")).toBeNull();
    expect(screen.getByTestId("results-review-studio")).toBeTruthy();
  });
});
