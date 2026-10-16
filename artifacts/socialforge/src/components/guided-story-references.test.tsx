import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

const api = vi.hoisted(() => ({
  inspect: vi.fn(),
  requestUrl: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useInspectGuidedStoryReference: () => ({ mutateAsync: api.inspect, isPending: false }),
    useRequestUploadUrl: () => ({ mutateAsync: api.requestUrl, isPending: false }),
  });
});

import {
  GuidedRequirementChecklist,
  GuidedRequirementsEditor,
  GuidedStoryUploads,
  SceneReferenceToggles,
  MAX_GUIDED_UPLOADS,
  MAX_GUIDED_SCENE_UPLOADS,
  GuidedVideoCategoryQuestion,
  EMPTY_REQUIREMENTS,
  GUIDED_UPLOAD_ACCEPT,
  guidedUploadContentType,
  TopicMentionHelper,
  mentionedHandles,
  patchGuidedUpload,
  requirementsInput,
  uploadInputsFromDrafts,
  uploadsProblem,
  type GuidedUploadDraft,
} from "./guided-story-references";

describe("Guided scene reference capacity", () => {
  it("allows a fourth reference and keeps the selected references", () => {
    const onChange = vi.fn();
    const items = Array.from({ length: 4 }, (_, i) => ({
      id: `r${i + 1}`, handle: `prop_${i + 1}`, use: "prop", media: "image",
      path: `/objects/1/uploads/prop-${i + 1}`,
    }));
    render(<SceneReferenceToggles
      draft={{ setup: { references: { version: 1, items } } } as any}
      referenceIds={["r1", "r2", "r3"]}
      onChange={onChange}
      sceneLabel="test"
    />);
    expect(MAX_GUIDED_UPLOADS).toBe(50);
    expect(MAX_GUIDED_SCENE_UPLOADS).toBe(50);
    const fourth = screen.getByTestId("toggle-scene-upload-test-r4") as HTMLButtonElement;
    expect(fourth.disabled).toBe(false);
    fireEvent.click(fourth);
    expect(onChange).toHaveBeenCalledWith(["r1", "r2", "r3", "r4"]);
  });
});

function wrap(node: ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>;
}

const row = (overrides: Partial<GuidedUploadDraft>): GuidedUploadDraft => ({
  key: "k1",
  savedId: null,
  path: "/objects/1/uploads/a",
  handle: "serum",
  label: "serum.png",
  use: "product",
  notes: "",
  aiDescription: null,
  transcript: null,
  voiceFor: null,
  rightsConfirmed: false,
  media: "image",
  durationSeconds: null,
  suggestedUse: null,
  status: "ready",
  error: null,
  aiError: null,
  ...overrides,
});

beforeEach(() => {
  cleanup();
  api.inspect.mockReset();
  api.requestUrl.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});

describe("upload helpers", () => {
  it("keeps the selected logo when another image inspection suggests Logo", () => {
    const rows = [
      row({ key: "logo", handle: "logo_full", use: "logo", notes: "Keep lettering exact." }),
      row({ key: "new", handle: "new_image", use: "other_image", status: "inspecting" }),
    ];
    const updated = patchGuidedUpload(rows, "new", { use: "logo", status: "ready" });
    expect(updated.map((item) => item.use)).toEqual(["logo", "other_image"]);
    expect(updated[0]).toEqual(rows[0]);
    expect(updated[1]!.status).toBe("ready");
  });

  it("switches a manually chosen logo without deleting files or reference details", () => {
    const rows = [
      row({ key: "old", handle: "old_logo", use: "logo", notes: "Keep these notes." }),
      row({ key: "new", handle: "new_logo", use: "other_image", path: "/objects/1/uploads/new" }),
    ];
    const updated = patchGuidedUpload(rows, "new", { use: "logo" }, true);
    expect(updated.map((item) => item.use)).toEqual(["other_image", "logo"]);
    expect(updated[0]).toEqual({ ...rows[0], use: "other_image" });
    expect(updated[1]).toEqual({ ...rows[1], use: "logo" });
    expect(rows[0]!.use).toBe("logo");
  });

  it("does not create duplicate logos when two inspections finish in sequence", () => {
    const initial = [
      row({ key: "first", handle: "first", use: "other_image" }),
      row({ key: "second", handle: "second", use: "other_image" }),
    ];
    const first = patchGuidedUpload(initial, "first", { use: "logo" });
    const second = patchGuidedUpload(first, "second", { use: "logo" });
    expect(second.map((item) => item.use)).toEqual(["logo", "other_image"]);
  });

  it("does not demote the current logo for an upload that was removed", () => {
    const rows = [row({ key: "logo", use: "logo" })];
    expect(patchGuidedUpload(rows, "removed", { use: "logo" }, true)).toBe(rows);
  });

  it("explains duplicate logo assignments before submitting to the server", () => {
    expect(uploadsProblem([
      row({ key: "first", handle: "first", use: "logo" }),
      row({ key: "second", handle: "second", use: "logo" }),
    ])).toMatch(/Choose one Logo upload/);
  });

  it.each([
    ["photo.PNG", "", "image/png"],
    ["photo.jpeg", "application/octet-stream", "image/jpeg"],
    ["photo.JPG", "", "image/jpeg"],
    ["voice.MP3", "", "audio/mpeg"],
    ["voice.m4a", "application/octet-stream", "audio/mp4"],
    ["voice.wav", "", "audio/wav"],
    ["voice.ogg", "", "audio/ogg"],
    ["photo.jpg", "image/pjpeg", "image/jpeg"],
    ["voice.mp3", "audio/mp3", "audio/mpeg"],
    ["voice.wav", "audio/x-wav", "audio/wav"],
    ["recording.webm", "audio/webm", "audio/webm"],
    ["unknown.bin", "", "application/octet-stream"],
  ])("normalizes the upload content type for %s (%s)", (name, type, expected) => {
    expect(guidedUploadContentType({ name, type })).toBe(expected);
  });

  it("offers explicit image and audio extensions to file pickers", () => {
    expect(GUIDED_UPLOAD_ACCEPT.split(",")).toEqual(expect.arrayContaining([
      ".png", ".jpg", ".jpeg", ".mp3", ".m4a", ".wav", ".ogg", ".aac",
    ]));
  });

  it("sends only finished rows with normalized handles", () => {
    expect(uploadInputsFromDrafts([row({ handle: "@Night Serum" }), row({ key: "k2", status: "uploading" })])).toEqual([
      expect.objectContaining({ handle: "night_serum", use: "product", rightsConfirmed: null }),
    ]);
  });

  it("explains what blocks saving", () => {
    expect(uploadsProblem([row({ status: "inspecting" })])).toMatch(/Wait/);
    expect(uploadsProblem([row({}), row({ key: "k2" })])).toMatch(/Two uploads are named @serum/);
    expect(uploadsProblem([row({ media: "audio", use: "music" })])).toMatch(/own or licensed @serum/);
    expect(uploadsProblem([row({ media: "audio", use: "voice", rightsConfirmed: true })])).toMatch(/who @serum is the voice of/);
    expect(uploadsProblem([row({})])).toBeNull();
  });

  it("finds @mentions", () => {
    expect(mentionedHandles("@Maya uses @serum, mail a@b.in")).toEqual(["maya", "serum"]);
  });

  it("drops banned words outside medical / CA", () => {
    const value = { ...EMPTY_REQUIREMENTS, bannedWords: ["cure"] };
    expect(requirementsInput(value, "general").bannedWords).toEqual([]);
    expect(requirementsInput(value, "medical").bannedWords).toEqual(["cure"]);
  });
});

describe("GuidedVideoCategoryQuestion", () => {
  it("asks whether the video is medical or CA-related", () => {
    const onChange = vi.fn();
    render(<GuidedVideoCategoryQuestion value={null} onChange={onChange} />);
    expect(screen.getByText("Is this video medical or CA-related?")).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-guided-category-chartered_accountant"));
    expect(onChange).toHaveBeenCalledWith("chartered_accountant");
  });
});

describe("GuidedRequirementsEditor", () => {
  it("shows banned words only for medical and CA videos", () => {
    const { rerender } = render(<GuidedRequirementsEditor value={EMPTY_REQUIREMENTS} onChange={() => {}} category="general" handles={["serum"]} />);
    expect(screen.queryByTestId("input-guided-banned-words")).toBeNull();
    expect(screen.getByText("+ @serum")).toBeTruthy();
    rerender(<GuidedRequirementsEditor value={EMPTY_REQUIREMENTS} onChange={() => {}} category="medical" handles={[]} />);
    expect(screen.getByTestId("input-guided-banned-words")).toBeTruthy();
  });
});

describe("TopicMentionHelper", () => {
  it("inserts handles and warns about unknown ones", () => {
    const onInsert = vi.fn();
    render(<TopicMentionHelper topic="Meet @ghost" handles={["serum"]} onInsert={onInsert} />);
    fireEvent.click(screen.getByTestId("button-guided-mention-serum"));
    expect(onInsert).toHaveBeenCalledWith("serum");
    expect(screen.getByTestId("warning-guided-unknown-mentions").textContent).toContain("@ghost");
  });
});

describe("GuidedRequirementChecklist", () => {
  it("counts unmet requirements", () => {
    render(<GuidedRequirementChecklist checks={[{ kind: "must_say", text: "Free delivery", met: false }, { kind: "must_show", text: "@serum", met: true }]} />);
    expect(screen.getByText("1 requirement not met yet")).toBeTruthy();
  });
});

function UploadsHarness() {
  const [rows, setRows] = useState<GuidedUploadDraft[]>([]);
  return (
    <>
      <GuidedStoryUploads rows={rows} onChange={(update) => setRows(update)} hasBrandKit />
      <pre data-testid="rows">{JSON.stringify(rows.map((item) => ({ handle: item.handle, use: item.use, status: item.status })))}</pre>
    </>
  );
}

describe("GuidedStoryUploads", () => {
  it("preserves the existing logo when a newly uploaded image is automatically labelled Logo", async () => {
    api.requestUrl.mockResolvedValue({ uploadURL: "https://upload", objectPath: "/objects/1/uploads/new" });
    api.inspect.mockResolvedValue({
      media: "image", durationSeconds: null, aiDescription: "A logo image.", aiError: null,
      allowedUses: ["logo", "other_image"], suggestedUse: "logo",
    });
    function LogoHarness() {
      const [rows, setRows] = useState<GuidedUploadDraft[]>([
        row({ key: "existing", handle: "logo_full", use: "logo" }),
      ]);
      return <>
        <GuidedStoryUploads rows={rows} onChange={setRows} hasBrandKit />
        <pre data-testid="logo-rows">{JSON.stringify(rows.map(({ handle, use, status }) => ({ handle, use, status })))}</pre>
      </>;
    }
    render(wrap(<LogoHarness />));
    fireEvent.change(screen.getByTestId("input-guided-upload-files"), {
      target: { files: [new File(["x"], "extra.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(screen.getByTestId("logo-rows").textContent).toContain('"handle":"extra","use":"other_image","status":"ready"'));
    expect(screen.getByTestId("logo-rows").textContent).toContain('"handle":"logo_full","use":"logo"');
  });

  it.each([
    ["image.PNG", "", "image/png", "image"],
    ["image.jpeg", "application/octet-stream", "image/jpeg", "image"],
    ["sound.MP3", "", "audio/mpeg", "audio"],
    ["sound.m4a", "application/octet-stream", "audio/mp4", "audio"],
  ])("uploads %s when the picker omits a usable MIME type", async (name, type, contentType, media) => {
    api.requestUrl.mockResolvedValue({ uploadURL: "https://upload", objectPath: "/objects/1/uploads/x" });
    api.inspect.mockResolvedValue({
      media, durationSeconds: null, aiDescription: null, aiError: null,
      allowedUses: media === "image" ? ["character"] : ["voice"], suggestedUse: null,
    });
    render(wrap(<UploadsHarness />));
    fireEvent.change(screen.getByTestId("input-guided-upload-files"), {
      target: { files: [new File(["x"], name, { type })] },
    });
    await waitFor(() => expect(screen.getByTestId("rows").textContent).toContain('"status":"ready"'));
    expect(api.requestUrl).toHaveBeenCalledWith({
      data: { name, size: 1, contentType },
    });
    expect(fetch).toHaveBeenCalledWith("https://upload", expect.objectContaining({
      method: "PUT", headers: { "Content-Type": contentType },
    }));
    expect(api.inspect).toHaveBeenCalledWith({ data: { path: "/objects/1/uploads/x", label: name } });
  });

  it("shows a useful storage connection error instead of leaving the upload pending", async () => {
    api.requestUrl.mockResolvedValue({ uploadURL: "https://upload", objectPath: "/objects/1/uploads/x" });
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    render(wrap(<UploadsHarness />));
    fireEvent.change(screen.getByTestId("input-guided-upload-files"), {
      target: { files: [new File(["x"], "photo.png", { type: "image/png" })] },
    });
    await screen.findByText(/browser could not send this file to storage/);
    expect(screen.getByTestId("rows").textContent).toContain('"status":"failed"');
    expect(api.inspect).not.toHaveBeenCalled();
  });

  it("explains an upload timeout", async () => {
    api.requestUrl.mockResolvedValue({ uploadURL: "https://upload", objectPath: "/objects/1/uploads/x" });
    vi.mocked(fetch).mockRejectedValue(new DOMException("Request timed out", "TimeoutError"));
    render(wrap(<UploadsHarness />));
    fireEvent.change(screen.getByTestId("input-guided-upload-files"), {
      target: { files: [new File(["x"], "photo.png", { type: "image/png" })] },
    });
    await screen.findByText(/upload timed out/);
    expect(api.inspect).not.toHaveBeenCalled();
  });

  it("shows a rejected storage upload without running inspection", async () => {
    api.requestUrl.mockResolvedValue({ uploadURL: "https://upload", objectPath: "/objects/1/uploads/x" });
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403 } as Response);
    render(wrap(<UploadsHarness />));
    fireEvent.change(screen.getByTestId("input-guided-upload-files"), {
      target: { files: [new File(["x"], "photo.png", { type: "image/png" })] },
    });
    await screen.findByText(/Upload failed \(403\)/);
    expect(api.inspect).not.toHaveBeenCalled();
  });

  it("uploads, applies the AI suggestion and asks how to use audio", async () => {
    api.requestUrl.mockResolvedValue({ uploadURL: "https://upload", objectPath: "/objects/1/uploads/x" });
    api.inspect.mockResolvedValueOnce({
      media: "image", mimeType: "image/png", sha256: "s", byteLength: 1, durationSeconds: null, documentExcerpt: null,
      allowedUses: ["character", "product", "prop"], suggestedUse: "prop", suggestedHandle: "mug", aiDescription: "A red mug.", aiError: null,
    });
    render(wrap(<UploadsHarness />));
    fireEvent.change(screen.getByTestId("input-guided-upload-files"), {
      target: { files: [new File(["x"], "Red Mug.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(screen.getByTestId("rows").textContent).toContain('"status":"ready"'));
    expect(screen.getByTestId("rows").textContent).toContain('"handle":"red_mug","use":"prop"');

    api.inspect.mockResolvedValueOnce({
      media: "audio", mimeType: "audio/mpeg", sha256: "t", byteLength: 1, durationSeconds: 12, documentExcerpt: null,
      allowedUses: ["voice", "music", "voiceover", "sfx"], suggestedUse: null, suggestedHandle: "jingle", aiDescription: null, aiError: null,
    });
    fireEvent.change(screen.getByTestId("input-guided-upload-files"), {
      target: { files: [new File(["y"], "jingle.mp3", { type: "audio/mpeg" })] },
    });
    await screen.findByTestId("dialog-guided-audio-use");
    fireEvent.click(screen.getByTestId("button-guided-audio-use-music"));
    expect(screen.getByTestId("checkbox-guided-audio-rights")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("rows").textContent).toContain('"handle":"jingle","use":"music"'));
  });
});
