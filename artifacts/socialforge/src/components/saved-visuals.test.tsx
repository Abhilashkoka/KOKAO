import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
const state = vi.hoisted(() => ({ characters: [] as Array<{ id: number; name: string; referenceImagePath: string }>, toast: vi.fn() }));
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListCharacters: () => ({ data: state.characters, isLoading: false }),
  });
});
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock("@/lib/features", () => ({ useFeatureFlags: () => ({ flags: {} }) }));
import { CharactersCard } from "./saved-visuals";
afterEach(() => { cleanup(); state.toast.mockClear(); });
describe("Add character", () => {
  it("opens the upload dialog when below the limit", () => {
    state.characters = [];
    render(<CharactersCard />);
    fireEvent.click(screen.getByTestId("button-add-character"));
    expect(screen.getByRole("dialog").textContent).toContain("Add a character");
    expect(screen.getByTestId("button-saved-visual-file")).toBeTruthy();
  });
  it("explains the over-limit restriction on screen and when clicked", () => {
    state.characters = Array.from({ length: 46 }, (_, i) => ({ id: i + 1, name: `Character ${i}`, referenceImagePath: "/objects/example" }));
    render(<CharactersCard />);
    expect(screen.getByRole("status").textContent).toContain("Remove 17");
    fireEvent.click(screen.getByTestId("button-add-character"));
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Character limit reached" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});