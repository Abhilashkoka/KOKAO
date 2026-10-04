import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const mocks = vi.hoisted(() => ({ save: vi.fn(), list: vi.fn(), toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListVideoCoverCandidates: () => ({ ...idleMutation(), mutate: mocks.list }),
    useSetVideoCover: () => ({ ...idleMutation(), mutate: mocks.save }),
  });
});
vi.mock("@/components/cover-studio-dialog", () => ({
  CoverStudioDialog: (props: any) => props.open ? <div>
    <span data-testid="source">{props.imagePath}</span>
    <button onClick={() => {
      props.onApply({ imagePath: "/objects/1/editorial.png", b64: "", layers: {} });
      props.onOpenChange(false);
    }}>Apply editorial cover</button>
    <button onClick={() => props.onOpenChange(false)}>Cancel editorial cover</button>
  </div> : null,
}));
import { CoverPickerDialog } from "./video-studio";
function mount(enabled = true) {
  const onSaved = vi.fn(), onOpenChange = vi.fn();
  render(<QueryClientProvider client={new QueryClient()}>
    <CoverPickerDialog open onOpenChange={onOpenChange} coverStudioEnabled={enabled}
      job={{ id: 12, prompt: "Routine", thumbnailPath: "/objects/1/current.png" }}
      storageUrl={p => p ?? undefined} uploadFile={vi.fn()} onSaved={onSaved} />
  </QueryClientProvider>);
  return { onSaved, onOpenChange };
}
beforeEach(() => {
  cleanup(); vi.clearAllMocks();
  mocks.list.mockImplementation((_args, opts) => opts.onSuccess({ candidates: [
    { path: "/objects/1/frame.png", source: "frame", atSec: 2 },
  ] }));
});
describe("Video editorial covers", () => {
  it("opens a selected frame, stages a cover, then saves against the video", () => {
    const { onSaved, onOpenChange } = mount();
    fireEvent.click(screen.getByTestId("cover-candidate-frame"));
    fireEvent.click(screen.getByTestId("button-make-video-cover"));
    expect(screen.getByTestId("source").textContent).toBe("/objects/1/frame.png");
    fireEvent.click(screen.getByText("Apply editorial cover"));
    expect(mocks.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("button-save-cover"));
    expect(mocks.save.mock.calls[0][0]).toEqual({ jobId: 12, data: { coverPath: "/objects/1/editorial.png" } });
    mocks.save.mock.calls[0][1].onSuccess();
    expect(onSaved).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it("cancels without saving", () => {
    mount();
    fireEvent.click(screen.getByTestId("button-make-video-cover"));
    fireEvent.click(screen.getByText("Cancel editorial cover"));
    expect(mocks.save).not.toHaveBeenCalled();
    expect((screen.getByTestId("button-save-cover") as HTMLButtonElement).disabled).toBe(true);
  });
  it("keeps frame selection when Cover Studio is disabled", () => {
    mount(false);
    expect(screen.queryByTestId("button-make-video-cover")).toBeNull();
    fireEvent.click(screen.getByTestId("cover-candidate-frame"));
    fireEvent.click(screen.getByTestId("button-save-cover"));
    expect(mocks.save.mock.calls[0][0].data.coverPath).toBe("/objects/1/frame.png");
  });
});