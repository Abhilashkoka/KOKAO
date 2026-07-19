import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard: while a publish mutation is in flight, EVERY publish
 * control on the Library cards (footer platform buttons and the dropdown
 * menu items) must be disabled, so a fast double-click can never reach the
 * server's 409 "publish already in progress" guard. The item actively being
 * published shows a "Publishing..." label on the matching platform button.
 */

// Radix menus/dialogs need a few APIs jsdom doesn't implement.
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

const publishTwitterMutate = vi.fn();
let twitterPending = false;

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    // Pass-through retry wrapper: run the mutation immediately, no retry.
    useRestartRetry: () => ({
      isRetrying: false,
      run: (mutation: any, vars: any, cbs: any) => mutation.mutate(vars, cbs),
    }),
    useListContent: () => ({
      data: [
        {
          id: 7,
          title: "First post",
          caption: "A caption",
          imagePath: null,
          platform: "twitter",
          status: "draft",
          permalink: null,
        },
        {
          id: 8,
          title: "Second post",
          caption: "Another caption",
          imagePath: null,
          platform: "twitter",
          status: "draft",
          permalink: null,
        },
      ],
      isLoading: false,
    }),
    usePublishContentToTwitter: () => ({
      mutate: publishTwitterMutate,
      isPending: twitterPending,
    }),
    useGetTwitterStatus: () => ({ data: { connected: true, accountName: "tester" } }),
    useGetLinkedinStatus: () => ({ data: { connected: true } }),
    useGetThreadsStatus: () => ({ data: { connected: true } }),
    getListContentQueryKey: () => ["content"],
  });
});

// Imported after the mock so the mocked module is picked up.
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
  publishTwitterMutate.mockReset();
  twitterPending = false;
});

describe("Library publish controls lock while a publish is in flight", () => {
  it("keeps card publish buttons enabled when nothing is publishing", () => {
    renderPage();
    expect(
      (screen.getByTestId("button-publish-twitter-7") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByTestId("button-publish-linkedin-8") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("disables every card publish button while a publish mutation is pending, and shows Publishing... on the active one", async () => {
    renderPage();
    const user = userEvent.setup();

    // Open the Publish-to-X dialog for item 7 so the page knows which
    // item/platform is being published.
    await user.click(screen.getByTestId("button-publish-twitter-7"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /^publish$/i })).toBeTruthy();

    // Flip the mutation to pending and re-render (in the real app the
    // mutation state change triggers this re-render).
    twitterPending = true;
    cleanup();
    renderPage();
    await user.click(screen.getByTestId("button-publish-twitter-7"));

    // With the mutation pending, ALL footer publish buttons (both items,
    // every platform) are disabled.
    for (const id of [7, 8]) {
      for (const key of ["facebook", "instagram", "twitter", "linkedin", "threads"]) {
        expect(
          (screen.getByTestId(`button-publish-${key}-${id}`) as HTMLButtonElement).disabled,
        ).toBe(true);
      }
    }
  });

  it("shows Publishing... on the active item's platform button, surviving dialog close", async () => {
    const { rerender } = renderPage();
    const user = userEvent.setup();

    // Open the Publish-to-X dialog for item 7 and confirm — this records the
    // submit-time publish target.
    await user.click(screen.getByTestId("button-publish-twitter-7"));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^publish$/i }));
    expect(publishTwitterMutate).toHaveBeenCalledTimes(1);

    // The mutation is now in flight.
    twitterPending = true;
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <LibraryPage />
      </QueryClientProvider>,
    );

    // Close the dialog while the request is still pending — the card button
    // must still show the Publishing... spinner label.
    const openDialog = screen.queryByRole("dialog");
    if (openDialog) {
      await user.click(within(openDialog).getByRole("button", { name: /cancel/i }));
    }

    const activeButton = screen.getByTestId("button-publish-twitter-7") as HTMLButtonElement;
    expect(activeButton.disabled).toBe(true);
    expect(activeButton.textContent).toMatch(/publishing\.\.\./i);

    // The other item's button is disabled but NOT labelled Publishing.
    const otherButton = screen.getByTestId("button-publish-twitter-8") as HTMLButtonElement;
    expect(otherButton.disabled).toBe(true);
    expect(otherButton.textContent).not.toMatch(/publishing/i);
  });

  it("disables the dropdown publish menu items while a publish is pending", async () => {
    twitterPending = true;
    renderPage();
    const user = userEvent.setup();
    const triggers = screen.getAllByRole("button").filter((b) => b.querySelector("svg"));
    await user.click(triggers[0]!);
    for (const label of [
      /publish to facebook/i,
      /publish to instagram/i,
      /publish to linkedin/i,
      /publish to x/i,
      /publish to threads/i,
    ]) {
      const item = await screen.findByRole("menuitem", { name: label });
      expect(item.getAttribute("aria-disabled")).toBe("true");
    }
    // Edit and Delete stay enabled.
    const edit = await screen.findByRole("menuitem", { name: /edit/i });
    expect(edit.getAttribute("aria-disabled")).not.toBe("true");
  });
});
