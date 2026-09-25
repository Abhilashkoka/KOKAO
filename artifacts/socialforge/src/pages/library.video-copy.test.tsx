import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

const state = vi.hoisted(() => ({
  resolveSource: null as null | ((source: any) => void),
  sourceCalls: 0,
  captionCalls: [] as any[],
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/video-download-button", () => ({ VideoDownloadButton: () => null }));
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListContent: () => ({ isLoading: false, data: [{
      id: 42, title: "My unchanged title", caption: "My unchanged caption",
      videoPath: "/objects/1/demo.mp4", platform: "instagram", status: "draft",
    }] }),
    getContentVideoCopySource: () => {
      state.sourceCalls++;
      return new Promise((resolve) => { state.resolveSource = resolve; });
    },
    useGenerateCaption: () => ({
      mutateAsync: async (args: any) => {
        state.captionCalls.push(args);
        return { title: "AI title", caption: "AI caption", hashtags: ["FromScript"] };
      },
      isPending: false,
    }),
    getListContentQueryKey: () => ["content"],
  });
});

import { LibraryPage } from "./library";

function renderPage() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <LibraryPage />
  </QueryClientProvider>);
}

beforeEach(() => {
  cleanup();
  state.resolveSource = null;
  state.sourceCalls = 0;
  state.captionCalls = [];
});

describe("Library video copy", () => {
  it("uses the saved source with funded caption generation and previews without overwriting unsaved edits", async () => {
    renderPage();
    fireEvent.doubleClick(screen.getByTestId("card-content-42"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByTestId("button-generate-video-copy"));
    fireEvent.click(within(dialog).getByTestId("button-generate-video-copy"));
    expect(state.sourceCalls).toBe(1);
    const fields = dialog.querySelectorAll("input, textarea");
    const titleInput = fields[0] as HTMLInputElement;
    const captionInput = dialog.querySelector("textarea")!;
    fireEvent.change(titleInput, { target: { value: "My new title" } });
    fireEvent.change(captionInput, { target: { value: "My new caption" } });
    state.resolveSource?.({ sourceType: "narration", text: "Real spoken words" });
    await waitFor(() => expect(within(dialog).getByTestId("video-copy-preview")).toBeTruthy());
    expect(state.captionCalls[0].data.prompt).toContain("Real spoken words");
    expect(state.captionCalls[0].data.contentId).toBe(42);
    expect(titleInput.value).toBe("My new title");
    expect(captionInput.value).toBe("My new caption");
    fireEvent.click(within(dialog).getByTestId("button-apply-video-copy"));
    expect(titleInput.value).toBe("AI title");
    expect(captionInput.value).toBe("AI caption\n\n#FromScript");
  });

  it("does not apply a late generation to another item after the dialog closes", async () => {
    renderPage();
    fireEvent.doubleClick(screen.getByTestId("card-content-42"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByTestId("button-generate-video-copy"));
    fireEvent.keyDown(dialog, { key: "Escape" });
    state.resolveSource?.({ sourceType: "brief", text: "a brief" });
    await waitFor(() => expect(state.captionCalls).toHaveLength(0));
  });
});