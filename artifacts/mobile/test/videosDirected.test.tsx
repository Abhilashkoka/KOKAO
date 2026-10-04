import React from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const fixture = vi.hoisted(() => ({
  generate: vi.fn(), upload: vi.fn(), pick: vi.fn(),
  plan: "pro", characters: [] as any[], models: [] as any[], wallet: false,
}));
const textId = "atlascloud-wan-3.0-prime-text-to-video";
const referenceId = "atlascloud-wan-3.0-prime-reference";
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  return createApiClientMock({
    useGenerateVideo: () => ({ mutate: fixture.generate, isPending: false }),
    useGetMe: () => ({ data: { tenant: { plan: fixture.plan } } }),
    useWalletGetOverview: () => ({ data: fixture.wallet ? { rates: { videoPaise: 100 }, balancePaise: 200 } : undefined }),
    useListVideoJobs: () => ({ data: [], refetch: vi.fn() }),
    useListVideoModels: () => ({
      data: { models: fixture.models, defaults: {
        text: { provider: "atlascloud", model: "prime-text" },
        image: { provider: "atlascloud", model: "prime-reference" },
      } },
    }),
    useListCharacters: () => ({ data: fixture.characters }),
    useListBrandKits: () => ({ data: [{ id: 7, name: "My brand" }, { id: 8, name: "Colours only" }] }),
    useGetBrandKit: (id: number) => ({ data: { activeVersion: { payload: id === 7 ? {
      logos: { primary: { url: "/objects/logo.png" } },
      video_outro: { enabled: true, duration_seconds: 4 },
    } : {} } } }),
  });
});
vi.mock("@/lib/directedUpload", () => ({
  pickDirectedFiles: fixture.pick,
  uploadDirectedFile: fixture.upload,
}));
vi.mock("@clerk/expo", () => ({ useAuth: () => ({ getToken: vi.fn() }) }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("expo-video", () => ({ useVideoPlayer: () => ({}), VideoView: () => null }));
vi.mock("@expo/vector-icons", () => ({ Feather: Object.assign(() => null, { glyphMap: {} }) }));
vi.mock("@/lib/haptics", () => ({ haptic: vi.fn() }));
vi.mock("@/components/ContentImage", () => ({ ContentImage: () => null }));
vi.mock("@/components/RazorpayCheckoutModal", () => ({ RazorpayCheckoutModal: () => null }));
vi.mock("@/components/CharacterLikenessConsent", () => ({
  CharacterLikenessConsent: ({ characterId }: { characterId: number }) =>
    <div data-testid={`likeness-consent-${characterId}`}>Existing permission controls</div>,
}));
vi.mock("@/components/QuotaInfoSheet", () => ({
  useWalletBilling: () => fixture.wallet, isQuotaError: () => false,
  quotaErrorMessage: () => "", quotaErrorTitle: () => "",
  QuotaInfoSheet: () => null, QuotaErrorNotice: () => null,
}));
import VideosScreen from "../app/videos";

function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <VideosScreen />
  </QueryClientProvider>);
}
const click = (id: string) => fireEvent.click(screen.getByTestId(id));
const input = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } });
function toggle() {
  fireEvent.click(screen.getByRole("switch", { name: "Let KOKAO direct this video" }));
}
function submit() {
  input("input-video-brief", "A clear product story");
  click("button-generate-video");
}
function lastRequest() {
  return fixture.generate.mock.calls.at(-1)?.[0].data;
}
const approvedCharacter = () => ({
  id: 10, name: "Saved actor", referenceSource: "generated",
  provenanceStatus: "verified_generated", identityId: null,
  referenceSheetStatus: "approved",
  outfits: [{ id: 21, status: "approved", isDefault: true, identityVerified: true }],
});

describe("Mobile director intercepted submissions (no provider calls)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.plan = "pro";
    fixture.wallet = false;
    fixture.characters = [];
    fixture.models = [
      { id: "atlascloud-wan-3.0-text-to-video", label: "Wan Standard", provider: "atlascloud", providerModels: { text: "standard" }, durations: [5, 10], canGenerateAudio: true },
      { id: textId, label: "Wan Prime", provider: "atlascloud", providerModels: { text: "prime-text" }, durations: [5, 10, 30], canGenerateAudio: true },
      { id: referenceId, label: "Wan Prime Reference", provider: "atlascloud", providerModels: { image: "prime-reference" }, durations: [5, 10], canGenerateAudio: true },
      { id: "seedance", label: "Not supported", durations: [5] },
    ];
    fixture.pick.mockResolvedValue([{ uri: "fixture.mp4", name: "demo.mp4", type: "video/mp4", size: 20 }]);
    fixture.upload.mockResolvedValue("/objects/demo.mp4");
  });
  afterEach(cleanup);

  it("preserves ordinary generation and hides direction on free plans", () => {
    const view = mount();
    submit();
    expect(lastRequest()).toEqual({ engine: "text_to_video", prompt: "A clear product story" });
    view.unmount();
    fixture.plan = "free";
    mount();
    expect(screen.queryByTestId("panel-directed-video")).toBeNull();
    submit();
    expect(lastRequest()).toEqual({ engine: "topic_to_video", visualsSource: "stock", prompt: "A clear product story" });
  });

  it("uses configured Prime, one generation and default-none branding; off omits director", () => {
    mount(); toggle();
    expect(screen.queryByTestId("option-directed-model-seedance")).toBeNull();
    input("input-directed-fictional", "An invented actor");
    click("option-directed-duration-30");
    click("option-directed-brand-kit-7");
    input("input-directed-branding", "Teal and cream");
    submit();
    expect(lastRequest()).toMatchObject({
      modelId: textId, durationSec: 30, shotCount: 1, reviewStoryboard: false, brandKitId: 7,
      directedVideo: { ending: "none", brandImage: "none", fictionalCharacter: "An invented actor", brandingInstructions: "Teal and cream", assets: [], overlays: [] },
    });
    toggle(); submit();
    expect(lastRequest()).toEqual({ engine: "text_to_video", prompt: "A clear product story" });
  });

  it("pins approved saved references and preserves likeness-consent entry points", () => {
    fixture.characters = [{ ...approvedCharacter(), referenceSource: "uploaded" }];
    mount(); toggle();
    input("input-directed-fictional", "Do not send alongside saved actor");
    click("option-directed-cast-saved-10");
    expect(screen.getByTestId("likeness-consent-10")).toBeTruthy();
    submit();
    expect(lastRequest()).toMatchObject({ modelId: referenceId, characterId: 10, outfitId: 21, presetCharacterId: null });
    expect(lastRequest().directedVideo.fictionalCharacter).toBeUndefined();
  });

  it.each([
    { identityId: 9 },
    { referenceSheetStatus: "pending" },
    { outfits: [{ id: 21, status: "approved", identityVerified: false }] },
  ])("blocks unready or provider-bound saved characters: %j", (patch) => {
    fixture.characters = [{ ...approvedCharacter(), ...patch }];
    mount(); toggle(); click("option-directed-cast-saved-10"); submit();
    expect(fixture.generate).not.toHaveBeenCalled();
    expect(screen.getByTestId("text-directed-block-reason").textContent).toBeTruthy();
  });

  it("sends preset identity rather than tenant character IDs", () => {
    fixture.characters = [{ id: "preset:host", source: "preset", name: "Host" }];
    mount(); toggle(); click("option-directed-cast-preset-preset:host"); submit();
    expect(lastRequest()).toMatchObject({ modelId: referenceId, presetCharacterId: "preset:host", characterId: null, outfitId: null });
  });

  it("blocks unavailable models without silently submitting ordinary generation", () => {
    fixture.models = [];
    mount(); toggle(); submit();
    expect(fixture.generate).not.toHaveBeenCalled();
    toggle(); submit();
    expect(lastRequest().directedVideo).toBeUndefined();
  });

  it("discloses model-multiplied reservation even though only one generation is sent", () => {
    fixture.wallet = true;
    fixture.models[1].unitMultiplier = 4;
    mount(); toggle();
    expect(screen.getByTestId("text-wallet-estimate").textContent).toContain("₹4.00");
    expect(screen.getByTestId("text-wallet-estimate-shortfall")).toBeTruthy();
    submit();
    expect(lastRequest().shotCount).toBe(1);
  });

  it("shows server approval rejection even with an empty library and keeps the brief", () => {
    fixture.generate.mockImplementationOnce((_vars, options) =>
      options.onError({ data: { error: "Renew permission for the selected provider." } }));
    mount(); toggle(); submit();
    expect(screen.getByTestId("banner-video-cancel-notice").textContent).toContain("Renew permission");
    expect((screen.getByTestId("input-video-brief") as HTMLTextAreaElement).value).toBe("A clear product story");
  });

  it("requires explicit branding choices, discloses duration, resets choices on kit change", () => {
    mount(); toggle(); click("option-directed-brand-kit-7");
    click("option-directed-ending-animation"); click("option-directed-brand-image-primary");
    expect(screen.getByTestId("text-directed-ending-length").textContent).toContain("adds 4 seconds");
    submit();
    expect(lastRequest().directedVideo).toMatchObject({ ending: "animation", brandImage: "primary" });
    click("option-directed-brand-kit-8"); submit();
    expect(lastRequest().directedVideo).toMatchObject({ ending: "none", brandImage: "none" });
  });

  it("uploads a timed recording with retry; blocks failures and invalid windows", async () => {
    fixture.upload.mockRejectedValueOnce(new Error("Fixture upload failed"));
    mount(); toggle(); click("button-directed-add-asset");
    await waitFor(() => expect(screen.getByTestId("status-directed-asset-0").textContent).toContain("Fixture upload failed"));
    submit(); expect(fixture.generate).not.toHaveBeenCalled();
    click("button-directed-asset-retry-0");
    await waitFor(() => expect(screen.getByTestId("status-directed-asset-0").textContent).toContain("Recording ready"));
    expect(screen.getByTestId("text-directed-audio-notice").textContent).toContain("audio is not used");
    input("input-directed-asset-end-0", "20"); submit();
    expect(fixture.generate).not.toHaveBeenCalled();
    input("input-directed-asset-end-0", "4");
    click("option-directed-asset-placement-full_frame-0");
    submit();
    expect(lastRequest().directedVideo.assets).toEqual([{ objectPath: "/objects/demo.mp4", startSec: 0, endSec: 4, placement: "full_frame" }]);
    click("button-directed-asset-remove-0");
    expect(screen.queryByTestId("row-directed-asset-0")).toBeNull();
  });

  it("blocks oversized files before upload and empty text until edited or removed", async () => {
    fixture.pick.mockResolvedValue([{ name: "huge.png", type: "image/png", size: 11 * 1024 * 1024 }]);
    mount(); toggle(); click("button-directed-add-asset");
    await waitFor(() => expect(screen.getByTestId("status-directed-asset-0").textContent).toContain("10 MB"));
    expect(fixture.upload).not.toHaveBeenCalled();
    click("button-directed-asset-remove-0");
    click("button-directed-add-text"); submit();
    expect(fixture.generate).not.toHaveBeenCalled();
    input("input-directed-text-0", "KOKAO — exact words");
    input("input-directed-text-start-0", "1.2");
    input("input-directed-text-end-0", "3");
    submit();
    expect(lastRequest().directedVideo.overlays).toEqual([{ text: "KOKAO — exact words", startSec: 1.2, endSec: 3 }]);
    click("button-directed-text-remove-0");
    expect(screen.queryByTestId("row-directed-text-0")).toBeNull();
  });
});