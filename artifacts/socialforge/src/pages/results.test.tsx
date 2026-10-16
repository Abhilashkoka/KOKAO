import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const approve = vi.fn();
const navigate = vi.fn();
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
  useLocation: () => ["/results", navigate],
  useSearch: () => "",
}));

const { ResultsPage } = await import("./results");
const { getDraft, __resetDraftStoreForTests } = await import("@/lib/create-draft");

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

describe("Photo reel upgrade", () => {
  const photoReel = {
    id: 9,
    status: "succeeded",
    engine: "slideshow",
    aspectRatio: "9:16",
    sourceImagePaths: ["/objects/look-a", "/objects/look-b"],
    videoPath: "/objects/reel.mp4",
    currentVideoPath: "/objects/reel.mp4",
    guidedStoryDraftId: null,
    compliance: null,
  };

  beforeEach(() => {
    __resetDraftStoreForTests();
    navigate.mockReset();
  });

  it("brings a photo reel's looks back to Create as a video reel", () => {
    jobs = [photoReel];
    renderPage();
    fireEvent.click(screen.getByTestId("results-bring-to-life-button"));
    const draft = getDraft();
    expect(draft.mode).toBe("reel");
    expect(draft.reel.style).toBe("video");
    expect(draft.reel.looks.map((l) => l.dressed?.objectPath)).toEqual(["/objects/look-a", "/objects/look-b"]);
    expect(navigate).toHaveBeenCalledWith("/create?mode=reel");
  });

  it("is not offered on AI video jobs", () => {
    jobs = [{ ...photoReel, engine: "image_to_video" }];
    renderPage();
    expect(screen.queryByTestId("results-bring-to-life")).toBeNull();
  });
});
