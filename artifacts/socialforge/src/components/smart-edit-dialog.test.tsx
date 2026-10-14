import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = vi.hoisted(() => ({
  state: {
    jobId: 7,
    currentVersionId: "v1",
    currentVideoPath: "/objects/1/uploads/v1.mp4",
    versions: [
      { id: "v0", path: "/objects/1/uploads/v0.mp4", thumbnailPath: null, durationSec: 10, createdAt: "", editId: null, label: "Original" },
      { id: "v1", path: "/objects/1/uploads/v1.mp4", thumbnailPath: null, durationSec: 10, createdAt: "", editId: "e1", label: "Change 2.0–5.0s" },
    ],
    edits: [
      {
        id: "e2", type: "remove", status: "ready", startSec: 1, endSec: 3, box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        instruction: "", dialogueText: null, baseVersionId: "v1", cutPath: "/objects/1/uploads/cut.mp4",
        startFramePath: "/objects/1/uploads/a.png", editedStartFramePath: null, clipPath: "/objects/1/uploads/new.mp4",
        childJobId: 9, stage: null, error: null, resultVersionId: null, createdAt: "",
      },
    ],
    limits: { minSeconds: 1, maxSeconds: 12, keepVersions: 10 },
  },
  approve: vi.fn(),
  restore: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetSmartEdit: () => ({ data: api.state, isLoading: false }),
    useApproveSmartEdit: () => ({ mutate: api.approve, isPending: false }),
    useRestoreSmartEditVersion: () => ({ mutate: api.restore, isPending: false }),
  });
});

import { SmartEditDialog, clampRange, formatSeconds } from "./smart-edit-dialog";

beforeEach(() => {
  cleanup();
  api.approve.mockReset();
  api.restore.mockReset();
});

describe("smart edit helpers", () => {
  it("keeps the range inside the video and the per-edit limits", () => {
    const limits = { minSeconds: 1, maxSeconds: 12 };
    expect(clampRange(2, 20, 30, limits, "end")).toEqual([8, 20]);
    expect(clampRange(5, 5.2, 30, limits, "end")).toEqual([4.2, 5.2]);
    expect(clampRange(29.8, 30, 30, limits, "start")).toEqual([29, 30]);
    expect(formatSeconds(65.25)).toBe("1:05.3");
  });
});

describe("SmartEditDialog", () => {
  it("shows before/after for a ready cut and approves it", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SmartEditDialog open onOpenChange={() => {}} job={{ id: 7, videoPath: "/objects/1/uploads/v0.mp4", aspectRatio: "9:16" }} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("smart-edit-before-e2").getAttribute("src")).toBe("/api/storage/objects/1/uploads/cut.mp4");
    expect(screen.getByTestId("smart-edit-after-e2").getAttribute("src")).toBe("/api/storage/objects/1/uploads/new.mp4");
    fireEvent.click(screen.getByTestId("button-smart-edit-approve-e2"));
    expect(api.approve).toHaveBeenCalledWith({ jobId: 7, editId: "e2" }, expect.anything());
    fireEvent.click(screen.getByTestId("button-smart-edit-restore-v0"));
    expect(api.restore).toHaveBeenCalledWith({ jobId: 7, versionId: "v0" }, expect.anything());
  });

  it("needs a marked area before removing", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SmartEditDialog open onOpenChange={() => {}} job={{ id: 7, videoPath: "/objects/1/uploads/v0.mp4" }} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("button-smart-edit-type-remove"));
    expect(screen.getByText("Mark the area to remove on the video.")).toBeTruthy();
    expect((screen.getByTestId("button-smart-edit-generate") as HTMLButtonElement).disabled).toBe(true);
  });
});
