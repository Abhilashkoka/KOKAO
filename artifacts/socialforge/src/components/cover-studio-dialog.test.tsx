import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const { toastSpy, createCoverMutate, draftMutate } = vi.hoisted(() => ({
  toastSpy: vi.fn(), createCoverMutate: vi.fn(), draftMutate: vi.fn(),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("../test/apiClientMock");
  return createApiClientMock({
    useCreateCover: () => ({ ...idleMutation(), mutate: createCoverMutate }),
    useDraftCoverCopy: () => ({ ...idleMutation(), mutate: draftMutate }),
  });
});
import { CoverStudioDialog } from "./cover-studio-dialog";
const RESULT = {
  imagePath: "/objects/1/uploads/cover.png", b64Json: "Y292ZXI=", basePath: "/objects/1/uploads/base.png",
  subjectPath: "/objects/1/uploads/subject.png", layout: "behind", notice: null, units: 1,
  layers: { version: 1, basePath: "/objects/1/uploads/base.png", layers: [] },
};
function renderDialog() {
  const onApply = vi.fn(), onOpenChange = vi.fn();
  const client = new QueryClient();
  const view = render(<QueryClientProvider client={client}>
    <CoverStudioDialog open onOpenChange={onOpenChange} onApply={onApply}
      imagePath="/objects/1/uploads/photo.png" topic="skin routine" />
  </QueryClientProvider>);
  return { ...view, onApply, onOpenChange };
}
beforeEach(() => {
  cleanup(); toastSpy.mockClear(); createCoverMutate.mockReset(); draftMutate.mockReset();
  draftMutate.mockImplementation((_v, opts) => { opts.onSuccess({ kicker: "My", headline: "Skin Routine", subline: "for oily skin", source: "ai" }); opts.onSettled?.(); });
  createCoverMutate.mockImplementation((_v, opts) => { opts.onSuccess(RESULT); opts.onSettled?.(); });
});
describe("CoverStudioDialog", () => {
  it("drafts text on opening, but does not make a paid cover automatically", () => {
    renderDialog();
    expect((screen.getByTestId("input-cover-headline") as HTMLInputElement).value).toBe("Skin Routine");
    expect(createCoverMutate).not.toHaveBeenCalled();
  });
  it("creates then reuses the canvas on wording changes, and explicitly applies layers", () => {
    const { onApply } = renderDialog();
    fireEvent.click(screen.getByTestId("button-cover-create"));
    expect(createCoverMutate.mock.calls[0][0].data).toMatchObject({ imagePath: "/objects/1/uploads/photo.png", layout: "behind" });
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("input-cover-headline"), { target: { value: "New words" } });
    fireEvent.click(screen.getByTestId("button-cover-create"));
    expect(createCoverMutate.mock.calls[1][0].data).toMatchObject({ reuse: { basePath: RESULT.basePath, subjectPath: RESULT.subjectPath }, copy: { headline: "New words" } });
    fireEvent.click(screen.getByTestId("button-cover-apply"));
    expect(onApply).toHaveBeenCalledWith({ imagePath: RESULT.imagePath, b64: RESULT.b64Json, layers: RESULT.layers });
  });
  it("surfaces the no-matte notice", () => {
    createCoverMutate.mockImplementation((_v, opts) => { opts.onSuccess({ ...RESULT, layout: "over", subjectPath: null, notice: "Couldn't separate the person" }); opts.onSettled?.(); });
    renderDialog(); fireEvent.click(screen.getByTestId("button-cover-create"));
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ description: "Couldn't separate the person" }));
  });
  it("never lets a late copy draft overwrite manual typing", () => {
    draftMutate.mockImplementation(() => {});
    renderDialog();
    fireEvent.change(screen.getByTestId("input-cover-headline"), { target: { value: "My own headline" } });
    draftMutate.mock.calls[0][1].onSuccess({ kicker: "", headline: "Old draft", subline: "" });
    expect((screen.getByTestId("input-cover-headline") as HTMLInputElement).value).toBe("My own headline");
  });
  it("does not mix an earlier cutout into a new graded canvas", () => {
    renderDialog(); fireEvent.click(screen.getByTestId("button-cover-create"));
    fireEvent.click(screen.getByTestId("switch-cover-behind"));
    fireEvent.click(screen.getByTestId("switch-cover-grade"));
    createCoverMutate.mockImplementation((_v, opts) => { opts.onSuccess({ ...RESULT, subjectPath: null }); opts.onSettled?.(); });
    fireEvent.click(screen.getByTestId("button-cover-create"));
    fireEvent.click(screen.getByTestId("switch-cover-behind"));
    fireEvent.click(screen.getByTestId("button-cover-create"));
    expect(createCoverMutate.mock.calls[2][0].data.reuse).toBeUndefined();
  });
});