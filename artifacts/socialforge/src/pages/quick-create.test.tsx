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
    useGenerateImage: () => ({ mutate: generateImage, isPending: false }),
    useGenerateVideo: () => ({ mutate: generateVideo, isPending: false }),
  });
});
vi.mock("@/components/credit-balance", () => ({ useCreditFunding: () => ({ creditFunded: false }) }));
vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
  useLocation: () => ["/create", vi.fn()],
  useSearch: () => "",
}));

const { QuickCreatePage } = await import("./quick-create");

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
    generateVideo.mockReset();
    generateImage.mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:preview" }));
  });

  it("dresses a model from the outfit photo before any video is made", async () => {
    renderPage();
    fireEvent.change(screen.getByTestId("qc-description"), { target: { value: "Model sways gently" } });
    await uploadOutfit();

    const generate = screen.getByTestId("qc-generate") as HTMLButtonElement;
    expect(generate.disabled).toBe(true);

    fireEvent.click(screen.getByTestId("qc-tryon-generate"));
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ referenceImagePath: "/objects/uploads/outfit", size: "1024x1536" }),
      }),
      expect.any(Object),
    );
    const { onSuccess } = generateImage.mock.calls[0][1];
    onSuccess({ imagePath: "/objects/generated/model", b64Json: "" });

    await waitFor(() => expect((screen.getByTestId("qc-generate") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("qc-generate"));
    const payload = generateVideo.mock.calls[0][0].data;
    expect(payload.engine).toBe("image_to_video");
    expect(payload.sourceImagePaths).toEqual(["/objects/generated/model"]);
    expect(payload.prompt).toContain("No on-screen text");
  });

  it("animates the photo itself when asked to", async () => {
    renderPage();
    fireEvent.change(screen.getByTestId("qc-description"), { target: { value: "Slow push-in" } });
    await uploadOutfit();
    fireEvent.click(screen.getByTestId("qc-role-as-is"));
    fireEvent.click(screen.getByTestId("qc-generate"));
    expect(generateImage).not.toHaveBeenCalled();
    expect(generateVideo.mock.calls[0][0].data.sourceImagePaths).toEqual(["/objects/uploads/outfit"]);
  });
});
