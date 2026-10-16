import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateVideo = vi.fn();
const generateImage = vi.fn();
const navigate = vi.fn();
let uploads = 0;

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useQuoteCredits: () => ({ data: undefined }),
    useRequestUploadUrl: () => ({
      mutateAsync: async () => ({ uploadURL: "https://upload.test/x", objectPath: `/objects/uploads/${++uploads}` }),
    }),
    useGenerateImage: () => ({ mutate: generateImage, isPending: false }),
    useGenerateVideo: () => ({ mutate: generateVideo, isPending: false }),
  });
});
vi.mock("wouter", () => ({ useLocation: () => ["/create", navigate] }));
vi.mock("@/lib/beat", async (orig) => ({
  ...(await orig<typeof import("@/lib/beat")>()),
  analyzeMusicFile: async () => ({ bpm: 112, barSec: 2.143, firstBeatSec: 0.4 }),
}));

const { ShowcaseReel } = await import("./showcase-reel");

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
  fireEvent.click(screen.getByTestId("reel-dress-all"));
  // Looks are dressed one after another so the first face carries over.
  await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
  expect(generateImage.mock.calls[0][0].data.tryOn).toEqual({
    outfitImagePath: `/objects/uploads/${first}`,
    modelImagePath: null,
  });
  generateImage.mock.calls[0][1].onSuccess({ imagePath: "/objects/generated/a", b64Json: "" });
  await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(2));
  expect(generateImage.mock.calls[1][0].data.tryOn).toEqual({
    outfitImagePath: `/objects/uploads/${first + 1}`,
    modelImagePath: "/objects/generated/a",
  });
  generateImage.mock.calls[1][1].onSuccess({ imagePath: "/objects/generated/b", b64Json: "" });
  await waitFor(() => expect(screen.getByTestId("reel-dressed-1")).toBeTruthy());
}

describe("Showcase reel", () => {
  beforeEach(() => {
    uploads = 0;
    generateVideo.mockReset();
    generateImage.mockReset();
    navigate.mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
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
    });
    expect(data.prompt).toContain("No on-screen text");
    generateVideo.mock.calls[0][1].onSuccess({ id: 42 });
    expect(navigate).toHaveBeenCalledWith("/results?job=42");
  });

  it("makes a cheaper photo reel as a slideshow", async () => {
    renderReel();
    await addTwoDressedLooks();
    fireEvent.click(screen.getByTestId("reel-style-photo"));
    fireEvent.click(screen.getByTestId("reel-generate"));
    expect(generateVideo.mock.calls[0][0].data).toMatchObject({
      engine: "slideshow",
      slideDurationSec: 3,
      sourceImagePaths: ["/objects/generated/a", "/objects/generated/b"],
      musicPath: null,
    });
  });
});
