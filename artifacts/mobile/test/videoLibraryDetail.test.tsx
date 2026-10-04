import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ContentItem, VideoPublishResult } from "@workspace/api-client-react";

const state = vi.hoisted(() => ({
  rows: [] as VideoPublishResult[], available: true, connected: true, statusError: false,
  save: vi.fn(), publish: vi.fn(), fresh: vi.fn(),
}));
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  return createApiClientMock({
    useUpdateContent: () => ({ mutateAsync: state.save }),
    usePublishLibraryVideo: () => ({ mutateAsync: state.publish }),
    useGetYoutubeStatus: () => ({ data: { connected: state.connected, canUpload: state.connected }, refetch: vi.fn() }),
    useGetFacebookCredentials: () => ({ data: { verifyStatus: state.connected ? "verified" : "failed" }, refetch: vi.fn() }),
    useGetInstagramCredentials: () => ({ data: { verifyStatus: state.connected ? "verified" : "failed" }, refetch: vi.fn() }),
    useGetVideoPublishCapabilities: () => ({
      data: Object.fromEntries(["youtube", "facebook", "instagram"].map((key) => [key, { available: state.available }])), refetch: vi.fn(),
    }),
    useListVideoPublishes: () => ({
      data: state.rows, isSuccess: !state.statusError, isError: state.statusError, isLoading: false, isFetching: false, refetch: state.fresh,
    }),
  });
});
vi.mock("expo-router", () => ({ useRouter: () => ({ back: vi.fn() }) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@/components/LibraryVideoPlayer", () => ({ LibraryVideoPlayer: () => <div>Video preview</div> }));
vi.mock("@/components/ContentImage", () => ({ ContentImage: () => null }));
vi.mock("@/components/KeyboardAwareScrollViewCompat", () => ({ KeyboardAwareScrollViewCompat: ({ children }: any) => <div>{children}</div> }));
vi.mock("@/components/ui", () => ({
  Button: ({ title, onPress, disabled }: any) => <button onClick={onPress} disabled={disabled}>{title}</button>,
  Chip: ({ label, onPress, selected }: any) => <button aria-pressed={selected} onClick={onPress}>{label}</button>,
  Card: ({ children }: any) => <div>{children}</div>,
  Label: ({ children }: any) => <label>{children}</label>,
  Input: ({ value, onChangeText, accessibilityLabel, editable }: any) => <input aria-label={accessibilityLabel} value={value} disabled={editable === false} onChange={(e) => onChangeText(e.target.value)} />,
  ErrorState: ({ message }: any) => <div>{message}</div>,
}));

import { VideoLibraryDetail } from "../components/VideoLibraryDetail";
import { initialVideoMetadata, isVideoContent, utf8Length, videoMetadataErrors, videoOutcome } from "../lib/videoPublish";

const item = {
  id: 81, title: "Saved title", caption: "Saved description", platform: "instagram", contentType: "video",
  videoPath: "/objects/test/video.mp4", imagePath: "/objects/test/cover.jpg", status: "draft",
  videoPublishMetadata: { destination: "youtube", format: "video", title: "Stale title", description: "Stale copy", privacy: "unlisted", madeForKids: true },
} as ContentItem;
function mount(value = item) {
  return render(<QueryClientProvider client={new QueryClient()}><VideoLibraryDetail item={value} /></QueryClientProvider>);
}
function reviewYoutube() {
  fireEvent.click(screen.getByText("unlisted"));
  fireEvent.click(screen.getByText("Not made for kids"));
  fireEvent.click(screen.getByText("I reviewed this video, copy and settings"));
}
const disabled = (title: string) => (screen.getByText(title) as HTMLButtonElement).disabled;

describe("Mobile native video review", () => {
  beforeEach(() => {
    cleanup(); vi.clearAllMocks();
    state.rows = []; state.available = true; state.connected = true; state.statusError = false;
    state.save.mockResolvedValue({});
    state.publish.mockResolvedValue({ platform: "youtube", state: "processing" });
    state.fresh.mockImplementation(async () => ({ data: state.rows, isError: false }));
  });
  it("preserves saved copy and requires fresh explicit audience/privacy plus review", () => {
    mount();
    expect((screen.getByLabelText("Video title") as HTMLInputElement).value).toBe("Saved title");
    expect(disabled("Publish to YouTube")).toBe(true);
    expect(screen.getByText("unlisted").getAttribute("aria-pressed")).toBe("false");
    reviewYoutube();
    expect(disabled("Publish to YouTube")).toBe(false);
    fireEvent.change(screen.getByLabelText("Video description"), { target: { value: "Edited" } });
    expect(disabled("Publish to YouTube")).toBe(true);
  });
  it("saves the exact reviewed metadata, confirms explicitly, and reports processing, not live", async () => {
    state.publish.mockImplementation(async () => {
      state.rows = [{ platform: "youtube", state: "processing" }];
      return state.rows[0];
    });
    mount(); reviewYoutube();
    fireEvent.click(screen.getByText("Publish to YouTube"));
    expect(state.publish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm video publish"));
    await waitFor(() => expect(state.publish).toHaveBeenCalledTimes(1));
    expect(state.save).toHaveBeenCalledWith({ id: 81, data: {
      title: "Saved title", caption: "Saved description",
      videoPublishMetadata: { destination: "youtube", format: "video", title: "Saved title", description: "Saved description", privacy: "unlisted", madeForKids: false },
    } });
    expect(state.publish).toHaveBeenCalledWith({ id: 81 });
    expect(await screen.findByText("Processing — not confirmed published yet.")).toBeTruthy();
  });
  it("saves without publishing and never changes media, provenance, or status", async () => {
    mount(); reviewYoutube();
    fireEvent.click(screen.getByText("Save review"));
    await screen.findByText("Review saved. Nothing was posted.");
    expect(Object.keys(state.save.mock.calls[0]![0].data).sort()).toEqual(["caption", "title", "videoPublishMetadata"]);
    expect(state.publish).not.toHaveBeenCalled();
  });
  it("does not enqueue if saving fails", async () => {
    state.save.mockRejectedValue({ data: { error: "Save rejected" } });
    mount(); reviewYoutube();
    fireEvent.click(screen.getByText("Publish to YouTube"));
    fireEvent.click(screen.getByText("Confirm video publish"));
    await screen.findByText("Save rejected");
    expect(state.publish).not.toHaveBeenCalled();
  });
  it("blocks stale, failed, ambiguous, published and active destinations without retry", () => {
    for (const value of ["queued", "uploading", "processing", "committing", "attention", "failed", "published"]) {
      state.rows = [{ platform: "youtube", state: value }];
      mount(); reviewYoutube();
      expect(disabled("Publish to YouTube")).toBe(true);
      cleanup();
    }
    state.rows = []; state.statusError = true;
    mount(); reviewYoutube();
    expect(disabled("Publish to YouTube")).toBe(true);
  });
  it("rechecks destination outcomes before submission", async () => {
    state.fresh.mockResolvedValue({ data: [{ platform: "youtube", state: "processing" }] });
    mount(); reviewYoutube();
    fireEvent.click(screen.getByText("Publish to YouTube"));
    fireEvent.click(screen.getByText("Confirm video publish"));
    await screen.findByText(/This destination already has an upload/);
    expect(state.save).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled();
  });
  it("blocks missing media and unverified connections, with no thumbnail fallback", () => {
    mount({ ...item, videoPath: null }); reviewYoutube();
    expect(disabled("Publish to YouTube")).toBe(true);
    cleanup(); state.connected = false;
    mount(); reviewYoutube();
    expect(disabled("Publish to YouTube")).toBe(true);
    expect(screen.getByText(/Connect or reconnect YouTube/)).toBeTruthy();
  });
  it("blocks unavailable destinations and resets review when switching", () => {
    mount(); reviewYoutube();
    fireEvent.click(screen.getByText("Facebook Reel"));
    expect(disabled("Publish to Facebook Reel")).toBe(true);
    fireEvent.click(screen.getByText("I reviewed this video, copy and settings"));
    expect(disabled("Publish to Facebook Reel")).toBe(false);
    cleanup(); state.available = false; mount(); reviewYoutube();
    expect(disabled("Publish to YouTube")).toBe(true);
  });
  it("validates UTF-8 limits without truncating copy and identifies video even when media is missing", () => {
    const meta = initialVideoMetadata({ ...item, title: "x".repeat(101), caption: "అ".repeat(1667) });
    expect(meta.title).toHaveLength(101);
    expect(utf8Length(meta.description)).toBe(5001);
    expect(videoMetadataErrors(meta, true, true)).toHaveLength(2);
    expect(isVideoContent({ ...item, videoPath: null, videoPublishMetadata: undefined })).toBe(true);
    expect(videoOutcome({ platform: "facebook", state: "processing", error: "permission" })).toMatch(/resumes automatically/);
  });
});