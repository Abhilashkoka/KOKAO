import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Double-click a Content Library card to open its edit dialog.
 *
 * - Double-clicking anywhere on the card body opens the Edit Content dialog.
 * - Double-clicking an interactive control inside the card (kebab menu
 *   trigger, buttons) does NOT open the dialog — those keep their own
 *   behavior.
 */

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

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListContent: () => ({
      data: [
        {
          id: 42,
          title: "My draft post",
          caption: "Hello world caption",
          imagePath: null,
          platform: "instagram",
          status: "draft",
          permalink: null,
        },
      ],
      isLoading: false,
    }),
    getListContentQueryKey: () => ["content"],
  });
});

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

beforeEach(() => {
  cleanup();
});

describe("Library card double-click to edit", () => {
  it("opens the edit dialog when the card body is double-clicked", async () => {
    renderPage();
    const card = await screen.findByTestId("card-content-42");

    fireEvent.doubleClick(card);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/edit content/i);
  });

  it("opens the edit dialog when the caption text is double-clicked", async () => {
    renderPage();
    const caption = await screen.findByText("Hello world caption");

    fireEvent.doubleClick(caption);

    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("does not open the edit dialog when a button inside the card is double-clicked", async () => {
    renderPage();
    const card = await screen.findByTestId("card-content-42");
    const kebab = card.querySelector("button");
    expect(kebab).toBeTruthy();

    fireEvent.doubleClick(kebab!);

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
