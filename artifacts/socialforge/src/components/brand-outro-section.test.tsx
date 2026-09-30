import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { useState } from "react";

const mutateAsync = vi.hoisted(() => vi.fn());
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({ useRequestUploadUrl: () => ({ mutateAsync }) });
});

import {
  BrandOutroSection,
  defaultVideoOutro,
  normalizeVideoOutro,
  videoOutroError,
  type VideoOutro,
} from "./brand-outro-section";

function Harness({ initial, logoUrl = "/logo.png", onUploadLogo = () => {}, dur = 4 }: {
  initial?: Partial<VideoOutro>;
  logoUrl?: string | null;
  onUploadLogo?: () => void;
  dur?: number | null;
}) {
  const [v, setV] = useState<VideoOutro>({ ...defaultVideoOutro(), ...initial });
  return (
    <>
      <BrandOutroSection value={v} logoUrl={logoUrl} onChange={setV} onUploadLogo={onUploadLogo} probeDuration={async () => dur} />
      <pre data-testid="state">{JSON.stringify(v)}</pre>
    </>
  );
}
const state = () => JSON.parse(screen.getByTestId("state").textContent!) as VideoOutro;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mutateAsync.mockReset();
});

describe("video outro helpers", () => {
  it("defaults off, preset fade, 3s", () => {
    expect(defaultVideoOutro()).toMatchObject({ enabled: false, mode: "preset", preset: "fade", duration_seconds: 3, clip_path: null });
  });
  it("normalizes missing and out-of-range values", () => {
    expect(normalizeVideoOutro(undefined).enabled).toBe(false);
    expect(normalizeVideoOutro({ duration_seconds: 9 }).duration_seconds).toBe(5);
    expect(normalizeVideoOutro({ duration_seconds: 1 }).duration_seconds).toBe(2);
    expect(normalizeVideoOutro({ background_color: "red" }).background_color).toBe("#111111");
  });
  it("flags missing logo, missing clip, and bad hex only when enabled", () => {
    const base = { ...defaultVideoOutro(), enabled: true };
    expect(videoOutroError({ ...base, enabled: false }, null)).toBeNull();
    expect(videoOutroError(base, null)).toMatch(/no primary logo/);
    expect(videoOutroError({ ...base, mode: "upload" }, "/l.png")).toMatch(/Upload an outro clip/);
    expect(videoOutroError({ ...base, background_color: "#12" }, "/l.png")).toMatch(/hex/);
    expect(videoOutroError(base, "/l.png")).toBeNull();
    expect(videoOutroError(base, "https://x.com/logo.svg")).toMatch(/PNG, JPEG or WebP/);
    expect(videoOutroError(base, "/api/storage/objects/abc")).toBeNull();
  });
});

describe("BrandOutroSection", () => {
  it("is off by default and explains new-video scope when enabled", () => {
    render(<Harness />);
    expect(screen.getByTestId("status-outro").textContent).toBe("Off");
    fireEvent.click(screen.getByTestId("switch-outro-enabled"));
    expect(state().enabled).toBe(true);
    expect(screen.getByTestId("section-video-outro").textContent).toMatch(/new/);
    expect(screen.getByTestId("img-outro-preview")).toBeTruthy();
  });

  it("shows missing-logo error with upload action", () => {
    const onUploadLogo = vi.fn();
    render(<Harness initial={{ enabled: true }} logoUrl={null} onUploadLogo={onUploadLogo} />);
    expect(screen.getByTestId("text-outro-error").textContent).toMatch(/no primary logo/);
    fireEvent.click(screen.getByTestId("button-outro-upload-logo"));
    expect(onUploadLogo).toHaveBeenCalled();
  });

  it("changes preset and duration", () => {
    render(<Harness initial={{ enabled: true }} />);
    fireEvent.click(screen.getByTestId("button-outro-preset-zoom"));
    fireEvent.change(screen.getByTestId("input-outro-duration"), { target: { value: "5" } });
    expect(state()).toMatchObject({ preset: "zoom", duration_seconds: 5 });
    expect(screen.getByTestId("button-outro-preset-slide").textContent).toMatch(/from below/);
  });

  it("hides the duration slider in upload mode and explains full-clip length", () => {
    render(<Harness initial={{ enabled: true, mode: "upload" }} />);
    expect(screen.queryByTestId("input-outro-duration")).toBeNull();
    expect(screen.getByTestId("section-video-outro").textContent).toMatch(/full uploaded clip/);
    expect(screen.getByTestId("input-outro-file").getAttribute("accept")).toBe("video/mp4,video/webm");
  });

  it("uploads via presigned URL, previews, and removes the clip", async () => {
    mutateAsync.mockResolvedValue({ uploadURL: "https://put.example/x", objectPath: "/objects/outro-1" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    render(<Harness initial={{ enabled: true, mode: "upload" }} />);
    const file = new File(["x"], "outro.mp4", { type: "video/mp4" });
    fireEvent.change(screen.getByTestId("input-outro-file"), { target: { files: [file] } });
    await waitFor(() => expect(state().clip_path).toBe("/objects/outro-1"));
    expect(mutateAsync).toHaveBeenCalledWith({ data: { name: "outro.mp4", size: 1, contentType: "video/mp4" } });
    expect(screen.getByTestId("video-outro-preview").getAttribute("src")).toBe("/api/storage/objects/outro-1");
    fireEvent.click(screen.getByTestId("button-outro-remove"));
    expect(state().clip_path).toBeNull();
  });

  it("rejects non-video files and surfaces upload failures", async () => {
    render(<Harness initial={{ enabled: true, mode: "upload" }} />);
    fireEvent.change(screen.getByTestId("input-outro-file"), {
      target: { files: [new File(["x"], "a.png", { type: "image/png" })] },
    });
    expect(screen.getByTestId("text-outro-upload-error").textContent).toMatch(/MP4 or WebM/);
    fireEvent.change(screen.getByTestId("input-outro-file"), {
      target: { files: [new File(["x"], "a.mov", { type: "video/quicktime" })] },
    });
    expect(screen.getByTestId("text-outro-upload-error").textContent).toMatch(/MP4 or WebM/);
    const big = new File(["x"], "big.mp4", { type: "video/mp4" });
    Object.defineProperty(big, "size", { value: 40 * 1024 * 1024 });
    fireEvent.change(screen.getByTestId("input-outro-file"), { target: { files: [big] } });
    expect(screen.getByTestId("text-outro-upload-error").textContent).toMatch(/40 MB/);
    mutateAsync.mockRejectedValue(new Error("boom"));
    fireEvent.change(screen.getByTestId("input-outro-file"), {
      target: { files: [new File(["x"], "a.mp4", { type: "video/mp4" })] },
    });
    await waitFor(() => expect(screen.getByTestId("text-outro-upload-error")).toBeTruthy());
    expect(state().clip_path).toBeNull();
  });

  it("rejects clips outside 1 to 10 seconds before uploading", async () => {
    render(<Harness initial={{ enabled: true, mode: "upload" }} dur={12.4} />);
    fireEvent.change(screen.getByTestId("input-outro-file"), {
      target: { files: [new File(["x"], "long.webm", { type: "video/webm" })] },
    });
    await waitFor(() =>
      expect(screen.getByTestId("text-outro-upload-error").textContent).toMatch(/1 to 10 seconds.*12\.4s/),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
