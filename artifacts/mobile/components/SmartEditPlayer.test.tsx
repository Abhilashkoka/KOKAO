import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const media = vi.hoisted(() => ({
  os: "ios",
  token: vi.fn().mockResolvedValue("test-session"),
  source: null as unknown,
  duration: 0,
  currentTime: 0,
  pause: vi.fn(),
  listeners: {} as Record<string, (event: unknown) => void>,
  remove: vi.fn(),
}));
vi.mock("react-native", async () => {
  const actual = await vi.importActual<typeof import("react-native")>("react-native");
  return { ...actual, Platform: { ...actual.Platform, get OS() { return media.os; } } };
});
vi.mock("@clerk/expo", () => ({ useAuth: () => ({ getToken: media.token }) }));
vi.mock("expo-video", () => ({
  VideoView: () => <div data-testid="native-video" />,
  useVideoPlayer: (source: unknown) => {
    media.source = source;
    return player;
  },
}));
const player = {
  get duration() { return media.duration; },
  get currentTime() { return media.currentTime; },
  set currentTime(value: number) { media.currentTime = value; },
  pause: media.pause,
  addListener: (name: string, handler: (event: unknown) => void) => {
    media.listeners[name] = handler;
    return { remove: media.remove };
  },
};
import { SmartEditPlayer } from "./SmartEditPlayer";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EXPO_PUBLIC_DOMAIN", "preview.example.test");
  media.os = "ios";
  media.duration = 0;
  media.currentTime = 0;
  media.listeners = {};
  media.token.mockResolvedValue("test-session");
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("authenticated Smart Edit media", () => {
  it("streams with bearer headers on native and consumes real metadata exactly once", async () => {
    const loaded = vi.fn();
    const tick = vi.fn();
    render(<SmartEditPlayer path="/tenant/video.mp4" onLoad={loaded} onTime={tick} />);
    await screen.findByTestId("native-video");
    expect(media.source).toEqual({
      uri: "https://preview.example.test/api/storage/tenant/video.mp4",
      headers: { Authorization: "Bearer test-session" },
    });
    act(() => {
      media.listeners.sourceLoad({ duration: 26.2, availableVideoTracks: [{ size: { width: 1920, height: 1080 } }] });
      media.duration = 26.2;
      media.listeners.statusChange({ status: "readyToPlay" });
      media.listeners.timeUpdate({ currentTime: 7.1 });
    });
    expect(loaded).toHaveBeenCalledExactlyOnceWith(26.2);
    expect(tick).toHaveBeenCalledWith(7.1);
  });
  it("pauses for marking and seeks without playing the clip", async () => {
    const rendered = render(<SmartEditPlayer path="/video.mp4" />);
    await screen.findByTestId("native-video");
    rendered.rerender(<SmartEditPlayer path="/video.mp4" drawing seek={{ at: 5.2, nonce: 1 }} />);
    expect(media.pause).toHaveBeenCalled();
    expect(media.currentTime).toBe(5.2);
    expect(screen.getByTestId("smart-edit-region")).toBeTruthy();
  });
  it("shows authorization and playback failures explicitly", async () => {
    const rendered = render(<SmartEditPlayer path="/video.mp4" />);
    await screen.findByTestId("native-video");
    act(() => media.listeners.statusChange({ status: "error" }));
    expect(screen.getByText(/Could not play this video/)).toBeTruthy();
    rendered.unmount();
    media.token.mockResolvedValue(null);
    render(<SmartEditPlayer path="/other.mp4" />);
    await screen.findByText(/Video preview unavailable/);
    expect(screen.queryByTestId("native-video")).toBeNull();
  });
  it("uses authenticated revocable browser media and readyToPlay metadata on Expo web", async () => {
    media.os = "web";
    const loaded = vi.fn();
    const createUrl = vi.fn().mockReturnValue("blob:authorized-video");
    const revokeUrl = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    const fetchMedia = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["video"]) });
    vi.stubGlobal("fetch", fetchMedia);
    const rendered = render(<SmartEditPlayer path="/video.mp4" onLoad={loaded} />);
    await screen.findByTestId("native-video");
    expect(fetchMedia.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer test-session" });
    expect(media.source).toMatchObject({ uri: "blob:authorized-video" });
    media.duration = 21;
    act(() => media.listeners.statusChange({ status: "readyToPlay" }));
    expect(loaded).toHaveBeenCalledWith(21);
    rendered.unmount();
    expect(revokeUrl).toHaveBeenCalledWith("blob:authorized-video");
  });
  it("removes media event subscriptions when leaving the screen", async () => {
    const rendered = render(<SmartEditPlayer path="/video.mp4" />);
    await screen.findByTestId("native-video");
    rendered.unmount();
    await waitFor(() => expect(media.remove).toHaveBeenCalledTimes(3));
  });
});
