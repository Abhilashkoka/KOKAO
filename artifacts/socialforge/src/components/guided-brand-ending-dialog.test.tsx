import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GuidedBrandEndingDialog, type GuidedBrandEndingSelection } from "./guided-brand-ending-dialog";

const offer = { available: true, revision: 3, token: "t", clipPath: "/objects/c.mp4", clipDurationSeconds: 4, hasAudio: false, replaceSceneId: "s4", replaceSceneDescription: "Logo reveal", sceneDurationSeconds: 5, storyDurationSeconds: 30, replacementDurationSeconds: 29, appendedDurationSeconds: 34 };

function renderDialog(props: Partial<Parameters<typeof GuidedBrandEndingDialog>[0]> = {}) {
  const handlers = { onChoiceChange: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(), onRefresh: vi.fn() };
  render(<GuidedBrandEndingDialog open offer={offer} choice={null as GuidedBrandEndingSelection | null} error={null} stale={false} loading={false} pending={false} {...handlers} {...props} />);
  return handlers;
}

afterEach(cleanup);

describe("GuidedBrandEndingDialog", () => {
  it("shows all choices with timings, explicit audio loss, and no default confirm", async () => {
    const h = renderDialog();
    expect(screen.getByTestId("text-brand-ending-duration-replace").textContent).toContain("29s");
    expect(screen.getByTestId("text-brand-ending-duration-keep").textContent).toContain("30s");
    expect(screen.getByTestId("text-brand-ending-duration-append").textContent).toContain("34s");
    expect(screen.getByTestId("text-brand-ending-replace-audio").textContent).toMatch(/ENTIRE last scene, including its scripted narration and dialogue/);
    expect(screen.getByTestId("text-brand-ending-replace-audio").textContent).toMatch(/silence/);
    expect(screen.getByTestId("video-brand-ending-preview").getAttribute("src")).toBe("/api/storage/objects/c.mp4");
    expect((screen.getByTestId("button-brand-ending-confirm") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId("radio-brand-ending-keep"));
    expect(h.onChoiceChange).toHaveBeenCalledWith("keep");
    expect(h.onConfirm).not.toHaveBeenCalled();
  });

  it("hides replacement without a replaceable scene", () => {
    renderDialog({ offer: { ...offer, replaceSceneId: null } });
    expect(screen.queryByTestId("radio-brand-ending-replace")).toBeNull();
  });

  it("blocks confirm on a stale offer and offers a fresh retry", async () => {
    const h = renderDialog({ choice: "append", stale: true, error: "Draft changed." });
    expect((screen.getByTestId("button-brand-ending-confirm") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId("button-brand-ending-refresh"));
    expect(h.onRefresh).toHaveBeenCalled();
  });

  it("confirms the explicit choice and cancels without confirming", async () => {
    const h = renderDialog({ choice: "append" });
    await userEvent.click(screen.getByTestId("button-brand-ending-cancel"));
    expect(h.onCancel).toHaveBeenCalled();
    expect(h.onConfirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("button-brand-ending-confirm"));
    expect(h.onConfirm).toHaveBeenCalled();
  });
});
