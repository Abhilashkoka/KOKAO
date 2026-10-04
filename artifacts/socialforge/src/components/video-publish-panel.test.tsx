import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

const calls: { updates: any[]; published: number[]; scheduled: any[]; order: string[] } = { updates: [], published: [], scheduled: [], order: [] };
let publishes: any[] = [];
let yt: any = { connected: true, canUpload: true };
let caps: any = { instagram: { available: true }, facebook: { available: true }, youtube: { available: true } };
const toastSpy = vi.fn();
const captionSpy = vi.fn(async () => ({ title: "Relevant title", caption: "Relevant video caption", hashtags: ["#Video"] }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));
vi.mock("@/lib/features", () => ({ useFeatureFlags: () => ({ flags: { scheduling: true } }) }));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    getContentVideoCopySource: async () => ({ text: "A video about caring for indoor plants.", sourceType: "narration" }),
    useGenerateCaption: () => ({ isPending: false, mutateAsync: captionSpy }),
    useUpdateContent: () => ({ isPending: false, mutateAsync: vi.fn(async (v: any) => { calls.updates.push(v); calls.order.push("save"); return {}; }) }),
    usePublishLibraryVideo: () => ({ isPending: false, mutateAsync: vi.fn(async (v: any) => { calls.published.push(v.id); calls.order.push("publish"); return { platform: "youtube", state: "queued" }; }) }),
    useCreateSchedule: () => ({ isPending: false, mutateAsync: vi.fn(async (v: any) => { calls.scheduled.push(v.data); return {}; }) }),
    useGetYoutubeStatus: () => ({ data: yt }),
    useListVideoPublishes: () => ({ data: publishes }),
    useGetVideoPublishCapabilities: () => ({ data: caps, isLoading: false }),
  });
});

import { VideoPublishPanel } from "./video-publish-panel";

function renderPanel(meta: any = null) {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <VideoPublishPanel
        item={{ id: 7, title: "Clip", caption: "Desc", platform: "facebook", videoPublishMetadata: meta }}
        platformLive={{ facebook: true, instagram: true }}
      />
    </QueryClientProvider>,
  );
}

// Radix Select is hard to drive in jsdom; the panel exposes the choice via
// the select triggers, so tests choose through keyboard-free value change.
function choose() {
  for (const [id, label] of [["select-video-audience", "Not made for kids"], ["select-video-privacy", "Unlisted"]]) {
    const trigger = screen.getByTestId(id);
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(screen.getByRole("option", { name: label }));
  }
}

const ytMeta = { destination: "youtube", format: "video", title: "Clip", description: "Desc", privacy: "unlisted", madeForKids: false };

beforeEach(() => {
  calls.updates = []; calls.published = []; calls.scheduled = []; calls.order = [];
  publishes = []; yt = { connected: true, canUpload: true };
  caps = { instagram: { available: true }, facebook: { available: true }, youtube: { available: true } };
  toastSpy.mockClear();
  captionSpy.mockClear();
  cleanup();
});

describe("VideoPublishPanel", () => {
  it("generates from the video source without overwriting edits or publishing, then applies on approval", async () => {
    renderPanel(ytMeta);
    fireEvent.change(screen.getByTestId("input-video-description"), { target: { value: "My edited caption" } });
    fireEvent.click(screen.getByTestId("button-generate-publish-caption"));
    await screen.findByTestId("publish-caption-suggestion");
    expect(captionSpy).toHaveBeenCalledWith({ data: expect.objectContaining({
      platform: "youtube", videoCopy: true, contentId: 7,
      prompt: expect.stringContaining("caring for indoor plants"),
    }) });
    expect((screen.getByTestId("input-video-description") as HTMLTextAreaElement).value).toBe("My edited caption");
    expect(calls.updates).toEqual([]);
    expect(calls.published).toEqual([]);
    fireEvent.click(screen.getByTestId("button-use-publish-caption"));
    expect((screen.getByTestId("input-video-description") as HTMLTextAreaElement).value).toContain("Relevant video caption");
    expect((screen.getByTestId("input-video-description") as HTMLTextAreaElement).value).toContain("#Video");
    expect((screen.getByTestId("input-video-title") as HTMLInputElement).value).toBe("Clip");
    expect((screen.getByTestId("button-video-publish") as HTMLButtonElement).disabled).toBe(true);
  });
  it("requires explicit review before publish, saves the snapshot first, and reports queued not published", async () => {
    renderPanel(ytMeta);
    choose();
    const publish = screen.getByTestId("button-video-publish") as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("checkbox-video-reviewed"));
    expect(publish.disabled).toBe(false);
    fireEvent.click(publish);
    fireEvent.click(await screen.findByTestId("button-video-confirm-publish"));
    await waitFor(() => expect(calls.published).toEqual([7]));
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Video queued" }));
  });

  it("saves edited metadata with exact title/caption before posting", async () => {
    renderPanel(ytMeta);
    fireEvent.change(screen.getByTestId("input-video-title"), { target: { value: "New title" } });
    choose();
    fireEvent.click(screen.getByTestId("checkbox-video-reviewed"));
    fireEvent.click(screen.getByTestId("button-video-publish"));
    fireEvent.click(await screen.findByTestId("button-video-confirm-publish"));
    await waitFor(() => expect(calls.order).toEqual(["save", "publish"]));
    expect(calls.updates[0].data).toMatchObject({ title: "New title", caption: "Desc", videoPublishMetadata: { destination: "youtube", title: "New title" } });
  });

  it("blocks YouTube until audience and privacy are chosen", () => {
    renderPanel({ ...ytMeta, destination: "facebook", format: "reel", privacy: "public" });
    expect(screen.queryByTestId("select-video-audience")).toBeNull();
    expect(screen.getByTestId("video-destination-specs").textContent).toMatch(/540x960/);
  });

  it("distinguishes connected from canUpload", () => {
    yt = { connected: true, canUpload: false, uploadGuidance: "Grant upload scope." };
    renderPanel(ytMeta);
    expect(screen.getByTestId("text-video-readiness").textContent).toMatch(/connected but cannot upload.*Grant upload scope/);
  });

  it("never resubmits an ambiguous attention outcome", () => {
    publishes = [{ platform: "youtube", state: "attention" }];
    renderPanel(ytMeta);
    fireEvent.click(screen.getByTestId("checkbox-video-reviewed"));
    expect((screen.getByTestId("button-video-publish") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("text-video-submit-blocked")).toBeTruthy();
  });

  it("blocks a definitive failure with new-item guidance and no retry promise", () => {
    publishes = [{ platform: "youtube", state: "failed", error: "Rejected." }];
    renderPanel(ytMeta);
    fireEvent.click(screen.getByTestId("checkbox-video-reviewed"));
    expect((screen.getByTestId("button-video-publish") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("text-video-submit-blocked").textContent).toMatch(/new Library item/);
    expect(screen.queryByText(/Retry/)).toBeNull();
    expect(screen.queryByText(/resumes the original/)).toBeNull();
  });

  it("fails closed for Meta when capabilities are not loaded", () => {
    caps = undefined;
    renderPanel({ ...ytMeta, destination: "facebook", format: "reel", privacy: "public" });
    fireEvent.click(screen.getByTestId("checkbox-video-reviewed"));
    expect((screen.getByTestId("button-video-publish") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("text-video-readiness").textContent).toMatch(/Could not confirm/);
  });

  it("never trusts saved audience/privacy: blocks until chosen again", () => {
    renderPanel(ytMeta);
    expect(screen.getByTestId("video-publish-errors").textContent).toMatch(/made for kids.*privacy/);
    expect((screen.getByTestId("checkbox-video-reviewed") as HTMLButtonElement).disabled).toBe(true);
  });

  it("uses the item's current title/caption over stale saved metadata", () => {
    renderPanel({ ...ytMeta, title: "Old", description: "Old desc" });
    expect((screen.getByTestId("input-video-title") as HTMLInputElement).value).toBe("Clip");
    expect((screen.getByTestId("input-video-description") as HTMLTextAreaElement).value).toBe("Desc");
  });

  it("schedules the single reviewed destination", async () => {
    renderPanel(ytMeta);
    choose();
    fireEvent.click(screen.getByTestId("checkbox-video-reviewed"));
    fireEvent.click(screen.getByTestId("button-video-schedule-toggle"));
    fireEvent.click(screen.getByTestId("button-video-schedule-confirm"));
    await waitFor(() => expect(calls.scheduled).toHaveLength(1));
    expect(calls.scheduled[0]).toMatchObject({ contentItemId: 7, platform: "youtube" });
  });
});
