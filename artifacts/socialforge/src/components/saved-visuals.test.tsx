import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
const state = vi.hoisted(() => ({
  characters: [] as Array<{ id: number | string; name: string; referenceImagePath: string }>,
  toast: vi.fn(), deleteCharacter: vi.fn(), invalidate: vi.fn(),
}));
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListCharacters: () => ({ data: state.characters, isLoading: false }),
    useDeleteCharacter: () => ({ mutateAsync: state.deleteCharacter }),
  });
});
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: state.invalidate }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock("@/lib/features", () => ({ useFeatureFlags: () => ({ flags: {} }) }));
import { CharactersCard } from "./saved-visuals";
afterEach(() => { cleanup(); state.toast.mockClear(); });
beforeEach(() => {
  state.deleteCharacter.mockReset().mockResolvedValue(undefined);
  state.invalidate.mockReset().mockResolvedValue(undefined);
});
describe("Add character", () => {
  it.each([0, 46, 49])("opens the upload dialog with %i saved characters", (count) => {
    state.characters = Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `Character ${i}`, referenceImagePath: "/objects/example" }));
    render(<CharactersCard />);
    fireEvent.click(screen.getByTestId("button-add-character"));
    expect(screen.getByRole("dialog").textContent).toContain("Add a character");
    expect(screen.getByTestId("button-saved-visual-file")).toBeTruthy();
  });
  it.each([50, 51])("explains the restriction with %i saved characters", (count) => {
    state.characters = Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `Character ${i}`, referenceImagePath: "/objects/example" }));
    render(<CharactersCard />);
    expect(screen.getByRole("status").textContent).toContain(`Remove ${count - 49}`);
    fireEvent.click(screen.getByTestId("button-add-character"));
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Character limit reached" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Saved character preview", () => {
  beforeEach(() => {
    state.characters = [
      { id: 1, name: "First", referenceImagePath: "/objects/first.png" },
      { id: 2, name: "Second", referenceImagePath: "/objects/second.png" },
      { id: "preset:3", name: "Preset", referenceImagePath: "/objects/preset.png" },
    ];
  });

  it.each(["{Enter}", " "])("opens the correct image by keyboard (%s), closes safely and restores focus", async (key) => {
    const user = userEvent.setup();
    render(<CharactersCard />);
    const trigger = screen.getByRole("button", { name: "Preview Second" });
    trigger.focus();
    await user.keyboard(key);
    const dialog = screen.getByRole("dialog", { name: "Second" });
    const image = within(dialog).getByRole("img", { name: "Second" });
    expect(image.getAttribute("src")).toBe("/api/storage/objects/second.png");
    expect(image.className).toContain("object-contain");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(state.deleteCharacter).not.toHaveBeenCalled();
  });

  it("closes with the explicit action without deleting", async () => {
    render(<CharactersCard />);
    fireEvent.click(screen.getByRole("button", { name: "Preview First" }));
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state.deleteCharacter).not.toHaveBeenCalled();
  });

  it("prevents duplicate deletion, refreshes the list and closes on success", async () => {
    let finish!: () => void;
    state.deleteCharacter.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { rerender } = render(<CharactersCard />);
    state.invalidate.mockImplementation(async () => {
      state.characters = state.characters.filter((character) => character.id !== 2);
      rerender(<CharactersCard />);
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview Second" }));
    const button = screen.getByRole("button", { name: "Delete character" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toContain("Deleting");
    expect(state.deleteCharacter).toHaveBeenCalledExactlyOnceWith({ characterId: 2 });
    await act(async () => finish());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Preview Second" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("button-add-character")));
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["getListCharactersQueryKey"] });
  });

  it("keeps the preview and error feedback after a failed delete, allowing retry", async () => {
    state.deleteCharacter.mockRejectedValueOnce(new Error("Please retry"));
    render(<CharactersCard />);
    fireEvent.click(screen.getByRole("button", { name: "Preview First" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete character" }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith({
      title: "Could not delete", description: "Please retry", variant: "destructive",
    }));
    expect(screen.getByRole("dialog", { name: "First" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Delete character" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete character" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state.deleteCharacter).toHaveBeenCalledTimes(2);
  });

  it("keeps thumbnail deletion independent and excludes presets", async () => {
    const user = userEvent.setup();
    render(<CharactersCard />);
    expect(screen.queryByRole("button", { name: "Preview Preset" })).toBeNull();
    const tile = screen.getByTestId("tile-character-1");
    const deletion = within(tile).getByRole("button", { name: "Delete First" });
    expect(deletion.parentElement).toBe(tile);
    deletion.focus();
    await user.keyboard("{Enter}");
    expect(state.deleteCharacter).toHaveBeenCalledExactlyOnceWith({ characterId: 1 });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes if the selected character disappears and focuses Add character", async () => {
    const { rerender } = render(<CharactersCard />);
    fireEvent.click(screen.getByRole("button", { name: "Preview First" }));
    state.characters = state.characters.filter((character) => character.id !== 1);
    rerender(<CharactersCard />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("button-add-character")));
  });
});