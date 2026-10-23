import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateVideo = vi.fn();
const generateImage = vi.fn();
const navigate = vi.fn();
const searchMusicLibrary = vi.fn();
const importMusic = vi.fn();
let uploads = 0;
let quote: unknown = undefined;

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useQuoteCredits: () => ({ data: quote }),
    useRequestUploadUrl: () => ({
      mutateAsync: async () => ({ uploadURL: "https://upload.test/x", objectPath: `/objects/uploads/${++uploads}` }),
    }),
    useGenerateImage: () => ({ mutateAsync: generateImage, isPending: false }),
    useGenerateVideo: () => ({ mutateAsync: generateVideo, isPending: false }),
    searchMusicLibrary: (...args: unknown[]) => searchMusicLibrary(...args),
    useImportLibraryMusic: () => ({ mutateAsync: importMusic, isPending: false }),
  });
});
vi.mock("wouter", () => ({ useLocation: () => ["/create", navigate] }));
vi.mock("@/lib/beat", async (orig) => ({
  ...(await orig<typeof import("@/lib/beat")>()),
  analyzeMusicFile: async () => ({ bpm: 112, barSec: 2.143, firstBeatSec: 0.4 }),
}));

const { ShowcaseReel } = await import("./showcase-reel");
const { __resetDraftStoreForTests } = await import("@/lib/create-draft");

const png = (name: string) => new File(["x"], name, { type: "image/png" });

function renderReel() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ShowcaseReel disabled={false} creditFunded={false} />
    </QueryClientProvider>,
  );
}

async function addTwoDressedLooks(first = 1) {
  fireEvent.change(screen.getByTestId("reel-outfit-input"), {
    target: { files: [png("saree1.png"), png("saree2.png")] },
  });
  await waitFor(() => expect(screen.getByTestId("reel-look-1")).toBeTruthy());
  generateImage
    .mockResolvedValueOnce({ imagePath: "/objects/generated/a", b64Json: "" })
    .mockResolvedValueOnce({ imagePath: "/objects/generated/b", b64Json: "" });
  fireEvent.click(screen.getByTestId("reel-dress-all"));
  // Looks are dressed one after another so the first face carries over.
  await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
  expect(generateImage.mock.calls[0][0].data.tryOn).toEqual({
    outfitImagePath: `/objects/uploads/${first}`,
    modelImagePath: null,
    gender: "woman",
  });
  await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(2));
  expect(generateImage.mock.calls[1][0].data.tryOn).toEqual({
    outfitImagePath: `/objects/uploads/${first + 1}`,
    modelImagePath: "/objects/generated/a",
    gender: "woman",
  });
  await waitFor(() => expect(screen.getByTestId("reel-dressed-1")).toBeTruthy());
}

describe("Showcase reel", () => {
  beforeEach(() => {
    __resetDraftStoreForTests();
    uploads = 0;
    quote = undefined;
    generateVideo.mockReset();
    generateImage.mockReset();
    navigate.mockReset();
    generateVideo.mockResolvedValue({ id: 42 });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => new Blob(["x"]) })));
    searchMusicLibrary.mockReset();
    importMusic.mockReset();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:preview" }));
  });

  it("needs two dressed looks before the reel can be made", async () => {
    renderReel();
    expect((screen.getByTestId("reel-generate") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("reel-hint").textContent).toContain("at least 2");
  });

  it("makes a beat-synced AI video reel, one clip per look", async () => {
    renderReel();
    fireEvent.change(screen.getByTestId("reel-music-input"), {
      target: { files: [new File(["x"], "song.mp3", { type: "audio/mpeg" })] },
    });
    await waitFor(() => expect(screen.getByTestId("reel-music-info").textContent).toContain("112 BPM"));
    await addTwoDressedLooks(2);

    fireEvent.click(screen.getByTestId("reel-generate"));
    const data = generateVideo.mock.calls[0][0].data;
    expect(data).toMatchObject({
      engine: "image_to_video",
      photoClips: true,
      sourceImagePaths: ["/objects/generated/a", "/objects/generated/b"],
      durationSec: 5,
      beatSec: 2.143,
      musicStartSec: 0.4,
      musicPath: "/objects/uploads/1",
      reviewStoryboard: false,
      generateAudio: false,
      modelGender: "woman",
    });
    expect(data.prompt).toContain("No on-screen text");
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/results?job=42"));
  });

  it("waits for a music track before the reel can be made", async () => {
    renderReel();
    await addTwoDressedLooks();
    expect((screen.getByTestId("reel-generate") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("reel-hint").textContent).toContain("music");
  });

  it("makes a cheaper photo reel with a track from the music library", async () => {
    searchMusicLibrary.mockResolvedValue({
      tracks: [{ id: "t1", title: "Raga Pop", creator: "A", license: "by", audioUrl: "https://cdn.test/t1.mp3" }],
    });
    importMusic.mockResolvedValue({ musicPath: "/objects/music/t1", title: "Raga Pop" });
    renderReel();
    await addTwoDressedLooks();
    fireEvent.click(screen.getByTestId("reel-mood-sitar"));
    await waitFor(() => expect(screen.getByTestId("reel-use-track-t1")).toBeTruthy());
    expect(searchMusicLibrary).toHaveBeenCalledWith({ q: "Sitar" });
    fireEvent.click(screen.getByTestId("reel-use-track-t1"));
    await waitFor(() => expect(screen.getByTestId("reel-music-info").textContent).toContain("Raga Pop"));
    expect(importMusic).toHaveBeenCalledWith({
      data: { audioUrl: "https://cdn.test/t1.mp3", title: "Raga Pop" },
    });

    fireEvent.click(screen.getByTestId("reel-style-photo"));
    fireEvent.click(screen.getByTestId("reel-generate"));
    await waitFor(() => expect(generateVideo).toHaveBeenCalled());
    expect(generateVideo.mock.calls[0][0].data).toMatchObject({
      engine: "slideshow",
      slideDurationSec: 4.286,
      sourceImagePaths: ["/objects/generated/a", "/objects/generated/b"],
      musicPath: "/objects/music/t1",
      beatSec: 2.143,
    });
  });

  it("keeps every look when you leave the page, even one still being dressed", async () => {
    const first = renderReel();
    fireEvent.change(screen.getByTestId("reel-outfit-input"), {
      target: { files: [png("saree1.png"), png("saree2.png")] },
    });
    await waitFor(() => expect(screen.getByTestId("reel-look-1")).toBeTruthy());
    let finish: (v: { imagePath: string; b64Json: string }) => void = () => {};
    generateImage.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    fireEvent.click(screen.getByTestId("reel-dress-0"));
    first.unmount();
    finish({ imagePath: "/objects/generated/late", b64Json: "" });

    renderReel();
    await waitFor(() => expect(screen.getByTestId("reel-dressed-0")).toBeTruthy());
    expect(screen.getByTestId("reel-look-1")).toBeTruthy();
  });

  it("starts on the Photo reel when the balance can't cover the video", async () => {
    quote = { credits: 1020, sufficient: false, balanceAfter: -200 };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ShowcaseReel disabled={false} creditFunded />
      </QueryClientProvider>,
    );
    await addTwoDressedLooks();
    await waitFor(() =>
      expect(screen.getByTestId("reel-style-photo").getAttribute("aria-checked")).toBe("true"),
    );
    expect(screen.getByTestId("reel-video-price").textContent).toContain("1,020");
    expect(screen.getByText("Top up to unlock")).toBeTruthy();
  });
});
