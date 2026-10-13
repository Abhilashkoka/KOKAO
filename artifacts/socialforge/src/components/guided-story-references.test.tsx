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
  GuidedVideoCategoryQuestion,
  EMPTY_REQUIREMENTS,
  TopicMentionHelper,
  mentionedHandles,
  requirementsInput,
  uploadInputsFromDrafts,
  uploadsProblem,
  type GuidedUploadDraft,
} from "./guided-story-references";

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
