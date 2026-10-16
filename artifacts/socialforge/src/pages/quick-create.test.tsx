import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateVideo = vi.fn();
const generateImage = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetMe: () => ({ data: { tenant: { id: 1, plan: "pro" } }, isLoading: false }),
    useListQuickCreatePresets: () => ({ data: [] }),
    useListVideoModels: () => ({ data: undefined }),
    useQuoteCredits: () => ({ data: undefined }),
    useRequestUploadUrl: () => ({
      mutateAsync: async () => ({ uploadURL: "https://upload.test/x", objectPath: "/objects/uploads/outfit" }),
    }),
    useGenerateImage: () => ({ mutateAsync: generateImage, isPending: false }),
    useGenerateVideo: () => ({ mutateAsync: generateVideo, isPending: false }),
  });
});
vi.mock("@/components/credit-balance", () => ({ useCreditFunding: () => ({ creditFunded: false }) }));
vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
  useLocation: () => ["/create", vi.fn()],
  useSearch: () => "",
}));

const { QuickCreatePage } = await import("./quick-create");
const { __resetDraftStoreForTests } = await import("@/lib/create-draft");

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <QuickCreatePage />
    </QueryClientProvider>,
  );
}

async function uploadOutfit() {
  const file = new File(["x"], "kurta.png", { type: "image/png" });
  fireEvent.change(screen.getByTestId("qc-photo-input"), { target: { files: [file] } });
  await waitFor(() => expect(screen.getByTestId("qc-tryon")).toBeTruthy());
}

describe("Quick Create try-on", () => {
  beforeEach(() => {
    __resetDraftStoreForTests();
    generateVideo.mockReset();
    generateImage.mockReset();
    generateImage.mockResolvedValue({ imagePath: "/objects/generated/model", b64Json: "" });
    generateVideo.mockResolvedValue({ id: 7 });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:preview" }));
  });

  it("dresses the model and starts the video in one tap", async () => {
    renderPage();
    fireEvent.change(screen.getByTestId("qc-description"), { target: { value: "Model sways gently" } });
    await uploadOutfit();

    fireEvent.click(screen.getByTestId("qc-generate"));
    await waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(1));
    expect(generateImage).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tryOn: { outfitImagePath: "/objects/uploads/outfit" },
        size: "1024x1536",
      }),
    });
    const payload = generateVideo.mock.calls[0][0].data;
    expect(payload.engine).toBe("image_to_video");
    expect(payload.sourceImagePaths).toEqual(["/objects/generated/model"]);
    expect(payload.prompt).toContain("No on-screen text");
  });

  it("reuses the dressed model on the next video instead of paying again", async () => {
    renderPage();
    fireEvent.change(screen.getByTestId("qc-description"), { target: { value: "Sway" } });
    await uploadOutfit();
    fireEvent.click(screen.getByTestId("qc-generate"));
    await waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByTestId("qc-generate") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("qc-generate"));
    await waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(2));
    expect(generateImage).toHaveBeenCalledTimes(1);
  });

  it("animates the photo itself when asked to", async () => {
    renderPage();
    fireEvent.change(screen.getByTestId("qc-description"), { target: { value: "Slow push-in" } });
    await uploadOutfit();
    fireEvent.click(screen.getByTestId("qc-role-as-is"));
    fireEvent.click(screen.getByTestId("qc-generate"));
    await waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(1));
    expect(generateImage).not.toHaveBeenCalled();
    expect(generateVideo.mock.calls[0][0].data.sourceImagePaths).toEqual(["/objects/uploads/outfit"]);
  });

  it("keeps the photo and text after leaving the page and coming back", async () => {
    const first = renderPage();
    fireEvent.change(screen.getByTestId("qc-description"), { target: { value: "Keep me" } });
    await uploadOutfit();
    first.unmount();

    renderPage();
    expect((screen.getByTestId("qc-description") as HTMLTextAreaElement).value).toBe("Keep me");
    expect(screen.getByTestId("qc-tryon")).toBeTruthy();
  });

  it("start over clears the draft", async () => {
    renderPage();
    fireEvent.change(screen.getByTestId("qc-description"), { target: { value: "Gone" } });
    fireEvent.click(screen.getByTestId("qc-start-over"));
    expect((screen.getByTestId("qc-description") as HTMLTextAreaElement).value).toBe("");
  });

  it("opens the showcase reel from a showcase template", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("qc-preset-saree-showcase"));
    await waitFor(() => expect(screen.getByTestId("showcase-reel")).toBeTruthy());
  });

  it("turns several picked photos into reel looks", async () => {
    renderPage();
    fireEvent.change(screen.getByTestId("qc-photo-input"), {
      target: {
        files: [
          new File(["x"], "a.png", { type: "image/png" }),
          new File(["x"], "b.png", { type: "image/png" }),
          new File(["x"], "c.png", { type: "image/png" }),
        ],
      },
    });
    await waitFor(() => expect(screen.getByTestId("reel-look-2")).toBeTruthy());
    expect(screen.queryByTestId("reel-look-3")).toBeNull();
  });
});
