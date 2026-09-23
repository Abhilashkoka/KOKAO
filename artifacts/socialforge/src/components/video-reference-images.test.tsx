import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StoryboardReferenceAssignments,
  VideoReferenceImages,
  type VideoReferenceImage,
} from "./video-reference-images";

const objectUrl = vi.fn(() => "blob:reference-preview");
const revokeObjectUrl = vi.fn();
Object.defineProperty(URL, "createObjectURL", { configurable: true, value: objectUrl });
Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function Harness({
  uploadFile,
}: {
  uploadFile: (file: File) => Promise<string>;
}) {
  let current: VideoReferenceImage[] = [];
  return (
    <VideoReferenceImages
      value={current}
      onChange={(next) => {
        current = next;
      }}
      uploadFile={uploadFile}
      onBlockedChange={() => undefined}
    />
  );
}

describe("VideoReferenceImages", () => {
  it("uploads, edits mode and scene numbers, then removes a reference", async () => {
    const changes: VideoReferenceImage[][] = [];
    const blocked: boolean[] = [];
    const uploadFile = vi.fn().mockResolvedValue("/objects/1/uploads/bottle.webp");
    render(
      <VideoReferenceImages
        value={[]}
        onChange={(next) => changes.push(next)}
        uploadFile={uploadFile}
        onBlockedChange={(value) => blocked.push(value)}
      />,
    );

    const file = new File(["image"], "Bottle.webp", { type: "image/webp" });
    await userEvent.upload(screen.getByTestId("input-reference-images"), file);
    await waitFor(() => expect(screen.getByTestId("input-reference-label-0")).toBeTruthy());
    await waitFor(() => expect(changes.at(-1)?.[0]?.objectPath).toBe("/objects/1/uploads/bottle.webp"));

    fireEvent.change(screen.getByTestId("input-reference-label-0"), {
      target: { value: "Hero bottle" },
    });
    fireEvent.change(screen.getByTestId("input-reference-instructions-0"), {
      target: { value: "Keep the label readable" },
    });
    fireEvent.change(screen.getByTestId("select-reference-mode-0"), {
      target: { value: "exact_insert" },
    });
    fireEvent.change(screen.getByTestId("input-reference-scenes-0"), {
      target: { value: "1, 3" },
    });

    expect(changes.at(-1)?.[0]).toMatchObject({
      label: "Hero bottle",
      instructions: "Keep the label readable",
      mode: "exact_insert",
      sceneNumbers: [1, 3],
    });
    expect(blocked.at(-1)).toBe(false);

    fireEvent.click(screen.getByTestId("button-remove-reference-0"));
    expect(changes.at(-1)).toEqual([]);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:reference-preview");
  });

  it("keeps failed uploads visible and retryable", async () => {
    const uploadFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("Storage is temporarily unavailable"))
      .mockResolvedValueOnce("/objects/1/uploads/retried.png");
    const blocked: boolean[] = [];
    render(
      <VideoReferenceImages
        value={[]}
        onChange={() => undefined}
        uploadFile={uploadFile}
        onBlockedChange={(value) => blocked.push(value)}
      />,
    );

    await userEvent.upload(
      screen.getByTestId("input-reference-images"),
      new File(["image"], "product.png", { type: "image/png" }),
    );
    await waitFor(() =>
      expect(screen.getByText("Storage is temporarily unavailable")).toBeTruthy(),
    );
    expect(blocked.at(-1)).toBe(true);

    fireEvent.click(screen.getByTestId("button-retry-reference-0"));
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(blocked.at(-1)).toBe(false));
  });

  it("blocks invalid scene numbers without silently changing them", async () => {
    const blocked: boolean[] = [];
    render(
      <VideoReferenceImages
        value={[
          {
            id: "ref-1",
            label: "Package",
            objectPath: "/objects/1/package.png",
            instructions: "",
            mode: "visual_reference",
          },
        ]}
        onChange={() => undefined}
        uploadFile={vi.fn()}
        onBlockedChange={(value) => blocked.push(value)}
      />,
    );

    fireEvent.change(screen.getByTestId("input-reference-scenes-0"), {
      target: { value: "0, two" },
    });
    expect(screen.getByText("Use comma-separated whole scene numbers from 1 to 80.")).toBeTruthy();
    await waitFor(() => expect(blocked.at(-1)).toBe(true));
  });

  it("shows an explicit overflow error instead of clipping files to six", async () => {
    render(<Harness uploadFile={vi.fn()} />);
    const files = Array.from(
      { length: 7 },
      (_, index) => new File(["x"], `${index}.png`, { type: "image/png" }),
    );
    await userEvent.upload(screen.getByTestId("input-reference-images"), files);
    expect(screen.getAllByText(/You can add up to 6 reference images/).length).toBe(7);
  });

  it("shows frozen storyboard assignments with labels and thumbnails", () => {
    render(
      <StoryboardReferenceAssignments
        references={[
          {
            id: "product",
            label: "Hero product",
            objectPath: "/objects/1/product.png",
            instructions: "",
            mode: "exact_insert",
          },
        ]}
        scenes={[
          { id: "scene-a", referenceImageIds: ["product"] },
          { id: "scene-b", referenceImageIds: [] },
        ]}
      />,
    );
    expect(screen.getByTestId("scene-references-1")).toBeTruthy();
    expect(screen.getByText("Hero product")).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Hero product reference" }).getAttribute("src"),
    ).toBe("/api/storage/objects/1/product.png");
  });
});