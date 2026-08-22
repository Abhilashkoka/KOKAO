/**
 * Localize Studio: the parts that are easy to break and expensive to notice.
 *
 * The timing spine is what every syllable budget is measured against, so a
 * regression there silently produces lines that do not fit the cut. The
 * blocked-track surfacing matters for the same reason — a track with an error
 * that renders as if it were clean is worse than no track at all.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Radix needs a few APIs jsdom does not implement.
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

const toastSpy = vi.hoisted(() => vi.fn());
const localizeSpy = vi.hoisted(() => vi.fn());
const generateVideoSpy = vi.hoisted(() => vi.fn());
const requestUploadUrlSpy = vi.hoisted(() => vi.fn().mockResolvedValue({ uploadURL: "http://upload", objectPath: "/objects/video.mp4" }));
const jobState = vi.hoisted(() => ({
  job: undefined as
    | {
        id: number;
        status: "queued" | "processing" | "succeeded" | "failed";
        stage: string | null;
        error: string | null;
        videoPath: string | null;
      }
    | undefined,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useLocalizeScript: () => ({
      mutate: localizeSpy,
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
      isSuccess: false,
      data: undefined,
      error: null,
      reset: vi.fn(),
    }),
    useGenerateVideo: () => ({
      mutate: generateVideoSpy,
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
      isSuccess: false,
      data: undefined,
      error: null,
      reset: vi.fn(),
    }),
    useRequestUploadUrl: () => ({
      mutateAsync: requestUploadUrlSpy,
    }),
    useGetVideoJob: () => ({
      data: jobState.job,
      isLoading: false,
      isFetching: false,
      error: null,
    }),
  });
});

vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob() }));

import { LocalizeStudioPage } from "./localize-studio";

function generateButton(): HTMLButtonElement {
  return screen.getByTestId("button-localize") as HTMLButtonElement;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LocalizeStudioPage />
    </QueryClientProvider>,
  );
}

const SAMPLE_TRACK = {
  locale: "te",
  label: "Telugu",
  blocked: true,
  srt: "1\n00:00:00,000 --> 00:00:03,000\nమీకు కావాల్సినవన్నీ\n",
  vtt: "WEBVTT\n\n1\n00:00:00.000 --> 00:00:03.000\nమీకు కావాల్సినవన్నీ\n",
  trackIssues: [],
  cues: [
    {
      index: 1,
      startMs: 0,
      endMs: 3000,
      text: "మీకు కావాల్సినవన్నీ ఒకే చోట.",
      backTranslation: "Everything you need, one place.",
      sourceSyllables: 9,
      syllables: 12,
      syllableBudget: 13,
      issues: [
        {
          code: "avoided_term",
          severity: "warning",
          message: 'Textbook coinage. Prefer "యాప్".',
        },
      ],
      cueIssues: [
        {
          code: "reading_speed",
          severity: "error",
          message: "24.0 characters per second. Maximum is 22.",
        },
      ],
    },
  ],
};

const SAMPLE_CLEAN_TRACK = {
  locale: "ta",
  label: "Tamil",
  blocked: false,
  srt: "1\n00:00:00,000 --> 00:00:03,000\nதமிழ்\n",
  vtt: "WEBVTT\n\n1\n00:00:00.000 --> 00:00:03.000\nதமிழ்\n",
  trackIssues: [],
  cues: [
    {
      index: 1,
      startMs: 0,
      endMs: 3000,
      text: "தமிழ்.",
      backTranslation: "Tamil.",
      sourceSyllables: 9,
      syllables: 10,
      syllableBudget: 13,
      issues: [],
      cueIssues: [],
    },
  ],
};

describe("LocalizeStudioPage", () => {
  beforeEach(() => {
    cleanup();
    toastSpy.mockClear();
    localizeSpy.mockClear();
    generateVideoSpy.mockReset();
    requestUploadUrlSpy.mockReset();
    requestUploadUrlSpy.mockResolvedValue({
      uploadURL: "http://upload",
      objectPath: "/objects/video.mp4",
    });
    jobState.job = undefined;
  });

  it("builds a timing spine from a pasted script", () => {
    renderPage();
    fireEvent.change(screen.getByTestId("input-localize-script"), {
      target: { value: "Everything you need.\nIn one place.\nDownload now." },
    });
    expect(screen.getByTestId("text-localize-cue-count").textContent).toContain("3 lines");
  });

  it("keeps the generate button disabled until there is a script", () => {
    renderPage();
    expect(generateButton().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("input-localize-script"), {
      target: { value: "Everything you need." },
    });
    expect(generateButton().disabled).toBe(false);
  });

  it("disables generate when every language is deselected", () => {
    renderPage();
    fireEvent.change(screen.getByTestId("input-localize-script"), {
      target: { value: "Everything you need." },
    });
    for (const locale of ["te", "ta", "hi"]) {
      fireEvent.click(screen.getByTestId(`checkbox-locale-${locale}`));
    }
    expect(generateButton().disabled).toBe(true);
  });

  it("sends cues, locales and the voice profile", () => {
    renderPage();
    fireEvent.change(screen.getByTestId("input-localize-script"), {
      target: { value: "Everything you need." },
    });
    fireEvent.change(screen.getByTestId("input-localize-ui-strings"), {
      target: { value: "Continue, Get started" },
    });
    fireEvent.click(screen.getByTestId("checkbox-locale-ta"));
    fireEvent.click(screen.getByTestId("button-localize"));

    expect(localizeSpy).toHaveBeenCalledTimes(1);
    const payload = localizeSpy.mock.calls[0]![0].data;
    expect(payload.locales).toEqual(["te", "hi"]);
    expect(payload.cues).toHaveLength(1);
    expect(payload.cues[0]).toMatchObject({ index: 1, startMs: 0, text: "Everything you need." });
    expect(payload.voiceProfile.uiStrings).toEqual(["Continue", "Get started"]);
    expect(payload.voiceProfile.uiIsLocalized).toBe(false);
  });

  it("lets the writer combine tone choices and sends them as register guidance", () => {
    renderPage();
    fireEvent.change(screen.getByTestId("input-localize-script"), {
      target: { value: "Everything you need." },
    });
    fireEvent.click(screen.getByTestId("button-register-conversational"));
    fireEvent.click(screen.getByTestId("button-register-warm"));
    fireEvent.change(screen.getByTestId("input-localize-register-note"), {
      target: { value: "Keep sentences short." },
    });
    fireEvent.click(screen.getByTestId("button-localize"));

    const payload = localizeSpy.mock.calls[0]![0].data;
    expect(payload.voiceProfile.register).toBe(
      "Conversational. Warm. Keep sentences short.",
    );
    expect(screen.getByTestId("button-register-conversational").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByTestId("button-register-warm").getAttribute("aria-pressed")).toBe("true");
  });

  it("ends the spine exactly on the stated runtime", () => {
    renderPage();
    fireEvent.change(screen.getByTestId("input-localize-script"), {
      target: { value: "One line here.\nAnother line that is quite a lot longer than the first." },
    });
    fireEvent.change(screen.getByTestId("input-localize-runtime"), { target: { value: "20" } });
    fireEvent.click(screen.getByTestId("button-localize"));

    const cues = localizeSpy.mock.calls[0]![0].data.cues;
    expect(cues[cues.length - 1].endMs).toBe(20000);
    // Longer line, more syllables, more time.
    expect(cues[1].endMs - cues[1].startMs).toBeGreaterThan(cues[0].endMs - cues[0].startMs);
  });

  it("renders a returned track with its issues and back-translation", () => {
    localizeSpy.mockImplementation((_vars: unknown, opts: { onSuccess: (d: unknown) => void }) => {
      opts.onSuccess({ tracks: [SAMPLE_TRACK] });
    });
    renderPage();
    fireEvent.change(screen.getByTestId("input-localize-script"), {
      target: { value: "Everything you need." },
    });
    fireEvent.click(screen.getByTestId("button-localize"));

    expect(screen.getByTestId("card-track-te")).toBeTruthy();
    expect(screen.getByText("Everything you need, one place.")).toBeTruthy();
    expect(screen.getByText(/24.0 characters per second/)).toBeTruthy();
    expect(screen.getByText(/Textbook coinage/)).toBeTruthy();
    expect(screen.getByTestId("badge-localize-blocked")).toBeTruthy();
    expect(screen.getByTestId("cue-te-1").textContent).toContain("12/13 syl");
  });

  it("tells the user how many tracks need a fix", () => {
    localizeSpy.mockImplementation((_vars: unknown, opts: { onSuccess: (d: unknown) => void }) => {
      opts.onSuccess({ tracks: [SAMPLE_TRACK] });
    });
    renderPage();
    fireEvent.change(screen.getByTestId("input-localize-script"), {
      target: { value: "Everything you need." },
    });
    fireEvent.click(screen.getByTestId("button-localize"));

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("needs a fix") }),
    );
  });

  it("surfaces an API failure as a destructive toast", () => {
    localizeSpy.mockImplementation((_vars: unknown, opts: { onError: (e: unknown) => void }) => {
      opts.onError({ data: { error: "Out of credits" } });
    });
    renderPage();
    fireEvent.change(screen.getByTestId("input-localize-script"), {
      target: { value: "Everything you need." },
    });
    fireEvent.click(screen.getByTestId("button-localize"));

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive", description: "Out of credits" }),
    );
  });

  it("prevents approval of a blocked track", () => {
    localizeSpy.mockImplementation((_vars: unknown, opts: { onSuccess: (d: unknown) => void }) => {
      opts.onSuccess({ tracks: [SAMPLE_TRACK] });
    });
    renderPage();
    fireEvent.change(screen.getByTestId("input-localize-script"), {
      target: { value: "Everything you need." },
    });
    fireEvent.click(screen.getByTestId("button-localize"));

    const approveSwitch = screen.getByTestId("switch-approve-te") as HTMLButtonElement;
    expect(approveSwitch.disabled).toBe(true);
    expect(screen.queryByText("Final Render")).toBeNull();
  });

  it("unblocked track approval reveals final flow and resets on new localization", () => {
    localizeSpy.mockImplementation((_vars: unknown, opts: { onSuccess: (d: unknown) => void }) => {
      opts.onSuccess({ tracks: [SAMPLE_CLEAN_TRACK] });
    });
    renderPage();
    fireEvent.change(screen.getByTestId("input-localize-script"), {
      target: { value: "Everything you need." },
    });
    fireEvent.click(screen.getByTestId("button-localize"));

    const approveSwitch = screen.getByTestId("switch-approve-ta") as HTMLButtonElement;
    expect(approveSwitch.disabled).toBe(false);
    expect(screen.queryByText("Final Render")).toBeNull();

    fireEvent.click(approveSwitch);
    expect(screen.getByText("Final Render")).toBeTruthy();

    // New localization resets approvals
    fireEvent.click(screen.getByTestId("button-localize"));
    expect(screen.queryByText("Final Render")).toBeNull();
  });

  it("sends exact selected track cue payload unchanged after mocked upload", async () => {
    localizeSpy.mockImplementation((_vars: unknown, opts: { onSuccess: (d: unknown) => void }) => {
      opts.onSuccess({ tracks: [SAMPLE_CLEAN_TRACK] });
    });
    renderPage();
    fireEvent.change(screen.getByTestId("input-localize-script"), {
      target: { value: "Everything you need." },
    });
    fireEvent.click(screen.getByTestId("button-localize"));

    fireEvent.click(screen.getByTestId("switch-approve-ta"));

    // Add file
    const file = new File(["dummy video"], "video.mp4", { type: "video/mp4" });
    const videoInput = screen.getByTestId("input-render-video");
    fireEvent.change(videoInput, { target: { files: [file] } });

    // Ensure language is selected (should be auto-selected to ta since it's the only one)
    expect((screen.getByTestId("button-render-video") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId("button-render-video"));

    // Wait for the async upload and generate request
    await screen.findByText(/Uploading video.mp4/);

    // wait for mock resolve
    await waitFor(() => expect(generateVideoSpy).toHaveBeenCalledTimes(1));

    expect(requestUploadUrlSpy).toHaveBeenCalledWith({
      data: { name: "video.mp4", size: file.size, contentType: "video/mp4" },
    });
    const req = generateVideoSpy.mock.calls[0][0].data;
    expect(req.engine).toBe("localized_dub");
    expect(req.sourceVideoPath).toBe("/objects/video.mp4");
    expect(req.localizedTrack.scriptApproved).toBe(true);
    expect(req.localizedTrack.locale).toBe("ta");
    expect(req.localizedTrack).toMatchObject({
      provider: "openai",
      model: "gpt-audio",
      speaker: "alloy",
    });
    expect(req.localizedTrack.cues).toHaveLength(1);
    expect(req.localizedTrack.cues[0]).toEqual({
      index: 1,
      startMs: 0,
      endMs: 3000,
      text: "தமிழ்.",
    });
  });

  it("submits the selected Sarvam provider, bulbul model, and speaker unambiguously", async () => {
    localizeSpy.mockImplementation((_vars: unknown, opts: { onSuccess: (d: unknown) => void }) => {
      opts.onSuccess({ tracks: [SAMPLE_CLEAN_TRACK] });
    });
    renderPage();
    fireEvent.change(screen.getByTestId("input-localize-script"), {
      target: { value: "Everything you need." },
    });
    fireEvent.click(screen.getByTestId("button-localize"));
    fireEvent.click(screen.getByTestId("switch-approve-ta"));

    const voiceTrigger = screen.getByTestId("select-render-voice");
    fireEvent.pointerDown(voiceTrigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByText("Sarvam · Priya"));
    expect(voiceTrigger.textContent).toContain("Sarvam · Priya");

    const file = new File(["dummy video"], "video.mp4", { type: "video/mp4" });
    fireEvent.change(screen.getByTestId("input-render-video"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByTestId("button-render-video"));
    await waitFor(() => expect(generateVideoSpy).toHaveBeenCalledTimes(1));

    expect(generateVideoSpy.mock.calls[0][0].data.localizedTrack).toMatchObject({
      locale: "ta",
      provider: "sarvam",
      model: "bulbul:v3",
      speaker: "priya",
    });
    expect(generateVideoSpy.mock.calls[0][0].data.localizedTrack.voice).toBeUndefined();
  });

  it("keeps the paid action disabled until a supported source video is selected", () => {
    localizeSpy.mockImplementation((_vars: unknown, opts: { onSuccess: (d: unknown) => void }) => {
      opts.onSuccess({ tracks: [SAMPLE_CLEAN_TRACK] });
    });
    renderPage();
    fireEvent.change(screen.getByTestId("input-localize-script"), {
      target: { value: "Everything you need." },
    });
    fireEvent.click(screen.getByTestId("button-localize"));
    fireEvent.click(screen.getByTestId("switch-approve-ta"));

    const renderButton = screen.getByTestId("button-render-video") as HTMLButtonElement;
    expect(renderButton.disabled).toBe(true);
    expect(screen.getByTestId("select-render-voice").textContent).toContain("OpenAI · Alloy");

    const unsupported = new File(["not a video"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("input-render-video"), {
      target: { files: [unsupported] },
    });

    expect(renderButton.disabled).toBe(true);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "destructive",
        title: "Unsupported video",
      }),
    );
  });

  it("disables duplicate paid renders while the video job is active", async () => {
    localizeSpy.mockImplementation((_vars: unknown, opts: { onSuccess: (d: unknown) => void }) => {
      opts.onSuccess({ tracks: [SAMPLE_CLEAN_TRACK] });
    });
    generateVideoSpy.mockImplementation(
      (_vars: unknown, opts: { onSuccess: (job: { id: number }) => void }) => {
        jobState.job = {
          id: 42,
          status: "queued",
          stage: "Dubbing and burning subtitles",
          error: null,
          videoPath: null,
        };
        opts.onSuccess({ id: 42 });
      },
    );

    renderPage();
    fireEvent.change(screen.getByTestId("input-localize-script"), {
      target: { value: "Everything you need." },
    });
    fireEvent.click(screen.getByTestId("button-localize"));
    fireEvent.click(screen.getByTestId("switch-approve-ta"));
    fireEvent.change(screen.getByTestId("input-render-video"), {
      target: { files: [new File(["video"], "video.mp4", { type: "video/mp4" })] },
    });
    fireEvent.click(screen.getByTestId("button-render-video"));

    await waitFor(() =>
      expect((screen.getByTestId("button-render-video") as HTMLButtonElement).disabled).toBe(true),
    );
    fireEvent.click(screen.getByTestId("button-render-video"));
    expect(generateVideoSpy).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId("switch-approve-ta") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a preview and download action when the dubbed video succeeds", async () => {
    localizeSpy.mockImplementation((_vars: unknown, opts: { onSuccess: (d: unknown) => void }) => {
      opts.onSuccess({ tracks: [SAMPLE_CLEAN_TRACK] });
    });
    generateVideoSpy.mockImplementation(
      (_vars: unknown, opts: { onSuccess: (job: { id: number }) => void }) => {
        jobState.job = {
          id: 43,
          status: "succeeded",
          stage: null,
          error: null,
          videoPath: "/objects/7/generated/dub.mp4",
        };
        opts.onSuccess({ id: 43 });
      },
    );

    renderPage();
    fireEvent.change(screen.getByTestId("input-localize-script"), {
      target: { value: "Everything you need." },
    });
    fireEvent.click(screen.getByTestId("button-localize"));
    fireEvent.click(screen.getByTestId("switch-approve-ta"));
    fireEvent.change(screen.getByTestId("input-render-video"), {
      target: { files: [new File(["video"], "video.mp4", { type: "video/mp4" })] },
    });
    fireEvent.click(screen.getByTestId("button-render-video"));

    expect(await screen.findByTestId("job-success-preview")).toBeTruthy();
    expect(screen.getByTestId("video-preview").getAttribute("src")).toBe(
      "/api/storage/objects/7/generated/dub.mp4",
    );
    expect(screen.getByTestId("button-download-video")).toBeTruthy();
  });
});
