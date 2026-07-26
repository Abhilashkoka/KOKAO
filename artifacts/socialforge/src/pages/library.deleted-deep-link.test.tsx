/**
 * Regression guard: inbox notifications link to /library?item=<id>. When the
 * linked post was deleted (or the id is nonsense), the library must load
 * normally and show a clear "that post no longer exists" notice — never a
 * raw error or a broken/empty editor dialog. Mirrors the mobile content
 * detail not-found behavior (test/contentDetailNotFound.test.tsx).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const toastSpy = vi.fn();
const setLocationSpy = vi.fn();
const mockRoute = { search: "" };

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("wouter", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("wouter");
  return {
    ...actual,
    useSearch: () => mockRoute.search,
    useLocation: () => ["/library", setLocationSpy],
  };
});

const mockState: { content: any[] } = { content: [] };

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListContent: () => ({ data: mockState.content, isLoading: false }),
    getListContentQueryKey: () => ["content"],
  });
});

// Imported after the mocks so the mocked modules are picked up.
import { LibraryPage } from "./library";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LibraryPage />
    </QueryClientProvider>,
  );
}

const existingItem = {
  id: 7,
  title: "Still here",
  caption: "A caption",
  platform: "facebook",
  status: "draft",
  imagePath: null,
  permalink: null,
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockState.content = [existingItem];
  mockRoute.search = "";
});

describe("Library deep link to a deleted post", () => {
  it("shows the not-found notice and cleans the URL instead of dead-ending", async () => {
    mockRoute.search = "item=99999";
    renderPage();

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "That post no longer exists",
          description: "It may have been deleted after this alert was sent.",
        }),
      );
    });
    // Not a destructive/raw error toast.
    expect(toastSpy.mock.calls[0][0].variant).toBeUndefined();
    // Library still rendered normally with the existing content.
    expect(screen.getByText("Still here")).toBeTruthy();
    // No broken edit dialog opened for the missing item.
    expect(screen.queryByRole("dialog")).toBeNull();
    // URL cleaned so a refresh doesn't re-trigger the notice.
    expect(setLocationSpy).toHaveBeenCalledWith("/library", { replace: true });
  });

  it("shows the notice for a malformed (non-numeric) item id too", async () => {
    mockRoute.search = "item=not-a-number";
    renderPage();

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "That post no longer exists" }),
      );
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("still opens the edit dialog (no notice) when the linked item exists", async () => {
    mockRoute.search = "item=7";
    renderPage();

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "That post no longer exists" }),
    );
    expect(setLocationSpy).toHaveBeenCalledWith("/library", { replace: true });
  });
});
