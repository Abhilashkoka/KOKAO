import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";

// Radix components need a few APIs jsdom doesn't implement.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const mockState: {
  kits: any[];
  voiceStatus: any;
  cloneCalls: any[];
  removeCalls: any[];
} = {
  kits: [],
  voiceStatus: { enabled: true, configured: true, provider: "elevenlabs" },
  cloneCalls: [],
  removeCalls: [],
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListBrandKits: () => ({ data: mockState.kits, isLoading: false }),
    useGetBrandVoiceStatus: () => ({ data: mockState.voiceStatus, isLoading: false }),
    useCloneBrandVoice: () => ({
      ...idleMutation(),
      mutateAsync: vi.fn(async (vars: any) => {
        mockState.cloneCalls.push(vars);
        return { activeVersion: { payload: null } };
      }),
    }),
    useRemoveBrandVoice: () => ({
      ...idleMutation(),
      mutate: vi.fn((vars: any, opts: any) => {
        mockState.removeCalls.push(vars);
        opts?.onSuccess?.({ activeVersion: { payload: null } });
      }),
    }),
  });
});

import { BrandKitsPage } from "./brand-kits";

function makeKit(brandVoice: any = null) {
  return {
    id: 7,
    name: "Acme",
    slug: "acme",
    brandType: "primary",
    isDefault: true,
    activeVersion: {
      id: 1,
      version: 1,
      payload: {
        identity: {
          brand_name: "Acme",
          brand_slug: "acme",
          tagline: "",
          description: "",
          industry: "",
          audience: [],
        },
        voice: { traits: [], dos: [], donts: [], caption_style: "", cta_style: "" },
        colors: { primary: [], secondary: [], neutral: [] },
        logos: { primary: null, secondary: null, icon_mark: null, favicon: null, usage_rules: [] },
        visual_style: {
          imagery_style: [],
          icon_style: "",
          illustration_style: "",
          motion_style: "",
        },
        brand_voice: brandVoice,
      },
    },
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <BrandKitsPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function openVoiceTab() {
  fireEvent.click(screen.getByTestId("button-edit-kit-7"));
  const voiceTab = await screen.findByRole("tab", { name: "Voice" });
  fireEvent.mouseDown(voiceTab);
  fireEvent.click(voiceTab);
  await screen.findByTestId("section-brand-voice");
}

describe("Brand Voice section in the Brand Kit editor", () => {
  beforeEach(() => {
    cleanup();
    mockState.kits = [makeKit()];
    mockState.voiceStatus = { enabled: true, configured: true, provider: "elevenlabs" };
    mockState.cloneCalls = [];
    mockState.removeCalls = [];
  });

  it("offers the sample upload and stock voice picker when no voice is cloned", async () => {
    renderPage();
    await openVoiceTab();

    expect((screen.getByTestId("button-upload-voice-sample") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("select-preset-voice")).toBeTruthy();
    expect(screen.getByTestId("input-delivery-style")).toBeTruthy();
    expect(screen.queryByTestId("button-preview-brand-voice")).toBeNull();
  });

  it("shows preview/replace/remove actions once a voice is cloned", async () => {
    mockState.kits = [
      makeKit({
        mode: "cloned",
        preset_voice: "nova",
        delivery_style: "",
        provider: "elevenlabs",
        provider_voice_id: "el-1",
        sample_asset_path: "/objects/x",
        cloned_label: "Founder voice",
        cloned_at: "2026-08-01T00:00:00.000Z",
      }),
    ];
    renderPage();
    await openVoiceTab();

    expect(screen.getByText("Founder voice")).toBeTruthy();
    expect(screen.getByTestId("button-preview-brand-voice")).toBeTruthy();
    expect(screen.getByTestId("button-replace-brand-voice")).toBeTruthy();
    expect(screen.getByTestId("button-remove-brand-voice")).toBeTruthy();
  });

  it("explains when the feature is switched off and blocks cloning", async () => {
    mockState.voiceStatus = { enabled: false, configured: true, provider: "elevenlabs" };
    renderPage();
    await openVoiceTab();

    expect(screen.getByTestId("text-brand-voice-disabled")).toBeTruthy();
    expect((screen.getByTestId("button-upload-voice-sample") as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains when no provider key is configured", async () => {
    mockState.voiceStatus = { enabled: true, configured: false, provider: "elevenlabs" };
    renderPage();
    await openVoiceTab();

    expect(screen.getByTestId("text-brand-voice-unconfigured")).toBeTruthy();
    expect((screen.getByTestId("button-upload-voice-sample") as HTMLButtonElement).disabled).toBe(true);
  });

  it("removes the voice through the in-app confirm dialog", async () => {
    mockState.kits = [
      makeKit({
        mode: "cloned",
        preset_voice: "nova",
        delivery_style: "",
        provider: "elevenlabs",
        provider_voice_id: "el-1",
        sample_asset_path: "/objects/x",
        cloned_label: "Founder voice",
        cloned_at: "2026-08-01T00:00:00.000Z",
      }),
    ];
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-remove-brand-voice"));
    fireEvent.click(await screen.findByTestId("button-confirm-remove-voice"));

    await waitFor(() => expect(mockState.removeCalls).toHaveLength(1));
    expect(mockState.removeCalls[0]).toMatchObject({ id: 7 });
  });

  it("opens the recording script dialog before a voice is cloned and copies the script", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.assign(navigator, { clipboard: { writeText } });
    renderPage();
    await openVoiceTab();

    fireEvent.click(screen.getByTestId("button-recording-script"));
    const dialog = await screen.findByTestId("dialog-recording-script");
    expect(dialog).toBeTruthy();
    expect(screen.getByTestId("text-recording-script").textContent).toContain(
      "Have you ever noticed",
    );
    expect(screen.getByTestId("list-recording-tips").textContent).toContain("quiet room");

    fireEvent.click(screen.getByTestId("button-copy-recording-script"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain("March 3rd, 2025");
    await screen.findByText("Copied!");
  });

  it("shows the script button next to Replace sample once a voice is cloned", async () => {
    mockState.kits = [
      makeKit({
        mode: "cloned",
        preset_voice: "nova",
        delivery_style: "",
        provider: "elevenlabs",
        provider_voice_id: "el-1",
        sample_asset_path: "/objects/x",
        cloned_label: "Founder voice",
        cloned_at: "2026-08-01T00:00:00.000Z",
      }),
    ];
    renderPage();
    await openVoiceTab();

    expect(screen.getByTestId("button-replace-brand-voice")).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-recording-script"));
    expect(await screen.findByTestId("dialog-recording-script")).toBeTruthy();
  });

  it("keeps the script dialog available when cloning is disabled", async () => {
    mockState.voiceStatus = { enabled: false, configured: true, provider: "elevenlabs" };
    renderPage();
    await openVoiceTab();

    const btn = screen.getByTestId("button-recording-script") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(await screen.findByTestId("dialog-recording-script")).toBeTruthy();
  });
});
