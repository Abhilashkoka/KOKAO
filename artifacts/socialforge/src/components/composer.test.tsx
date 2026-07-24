import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { splitIntoTweets } from "@workspace/social-limits";

if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const calls: {
  published: { platform: string; id: number }[];
  scheduled: { platform: string; contentItemId: number; scheduledAt: string }[];
  captionUpdates: { id: number; caption: string }[];
  failPlatforms: Set<string>;
} = { published: [], scheduled: [], captionUpdates: [], failPlatforms: new Set() };

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

function publishMock(platform: string) {
  return () => ({
    isPending: false,
    mutateAsync: vi.fn(async (vars: { id: number }) => {
      if (calls.failPlatforms.has(platform)) throw new Error(`${platform} down`);
      calls.published.push({ platform, id: vars.id });
      return {};
    }),
  });
}

const liveStatus = { configured: true, connected: true, expired: false };

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    usePublishContentToFacebook: publishMock("facebook"),
    usePublishContentToInstagram: publishMock("instagram"),
    usePublishContentToLinkedin: publishMock("linkedin"),
    usePublishContentToTwitter: publishMock("twitter"),
    usePublishContentToThreads: publishMock("threads"),
    useCreateSchedule: () => ({
      isPending: false,
      mutateAsync: vi.fn(async (vars: { data: any }) => {
        calls.scheduled.push(vars.data);
        return {};
      }),
    }),
    useUpdateContent: () => ({
      isPending: false,
      mutateAsync: vi.fn(async (vars: { id: number; data: any }) => {
        calls.captionUpdates.push({ id: vars.id, caption: vars.data.caption });
        return {};
      }),
    }),
    useGetFacebookCredentials: () => ({
      data: { appConfigured: true, verifyStatus: "verified" },
    }),
    useGetInstagramCredentials: () => ({
      data: { appConfigured: true, verifyStatus: "verified" },
    }),
    useGetLinkedinStatus: () => ({ data: liveStatus }),
    useGetTwitterStatus: () => ({ data: liveStatus }),
    // Threads deliberately NOT connected in these tests.
    useGetThreadsStatus: () => ({ data: { ...liveStatus, connected: false } }),
  });
});

import { ComposerSheet, type ComposerItem } from "./composer";

const ITEM: ComposerItem = {
  id: 42,
  title: "Launch post",
  caption: "Hello world",
  imagePath: "/objects/1/uploads/img.png",
  platform: "facebook",
};

function renderComposer(item: ComposerItem = ITEM) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ComposerSheet open onOpenChange={onOpenChange} item={item} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

beforeEach(() => {
  calls.published = [];
  calls.scheduled = [];
  calls.captionUpdates = [];
  calls.failPlatforms = new Set();
  toastSpy.mockClear();
  localStorage.clear();
  cleanup();
});

describe("ComposerSheet (shared QuickPublishPanel engine)", () => {
  it("hides unconnected platforms and preselects the item's platform", () => {
    renderComposer();
    // Threads has no live connection: not offered at all.
    expect(screen.queryByTestId("checkbox-quick-publish-threads")).toBeNull();
    // The item's platform is preselected; others are not.
    expect(
      screen.getByTestId("checkbox-quick-publish-facebook").getAttribute("data-state"),
    ).toBe("checked");
    expect(
      screen.getByTestId("checkbox-quick-publish-linkedin").getAttribute("data-state"),
    ).toBe("unchecked");
  });

  it("publishes to every selected platform with one click and closes the sheet", async () => {
    const { onOpenChange } = renderComposer();
    fireEvent.click(screen.getByTestId("checkbox-quick-publish-linkedin"));
    fireEvent.click(screen.getByTestId("button-quick-publish-now"));
    await waitFor(() => expect(calls.published).toHaveLength(2));
    expect(calls.published).toEqual([
      { platform: "facebook", id: 42 },
      { platform: "linkedin", id: 42 },
    ]);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Published!" }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // The selection is remembered for next time.
    expect(JSON.parse(localStorage.getItem("kokao.quickPublish.platforms")!)).toEqual([
      "facebook",
      "linkedin",
    ]);
  });

  it("disables Instagram with a hint when the item has no image", () => {
    renderComposer({ ...ITEM, imagePath: null });
    const ig = screen.getByTestId("checkbox-quick-publish-instagram") as HTMLButtonElement;
    expect(ig.disabled).toBe(true);
    expect(screen.getByText("(needs an image)")).toBeTruthy();
  });

  it("saves caption edits before publishing and warns about X threads first", async () => {
    const longCaption = "word ".repeat(90).trim(); // well over 280 chars
    renderComposer({ ...ITEM, platform: "twitter" });
    fireEvent.change(screen.getByTestId("composer-caption"), {
      target: { value: longCaption },
    });
    // The thread warning derives from the SHARED social-limits helper.
    expect(screen.getByTestId("quick-publish-checklist").textContent).toContain(
      `thread of ${splitIntoTweets(longCaption).length} tweets`,
    );
    fireEvent.click(screen.getByTestId("button-quick-publish-now"));
    await waitFor(() => expect(calls.published).toHaveLength(1));
    // Caption persisted BEFORE the platform posted.
    expect(calls.captionUpdates).toEqual([{ id: 42, caption: longCaption }]);
    expect(calls.published).toEqual([{ platform: "twitter", id: 42 }]);
  });

  it("schedules one queue entry per selected platform", async () => {
    renderComposer();
    fireEvent.click(screen.getByTestId("checkbox-quick-publish-twitter"));
    fireEvent.click(screen.getByTestId("button-quick-publish-schedule-toggle"));
    fireEvent.click(screen.getByTestId("button-quick-publish-schedule-confirm"));
    await waitFor(() => expect(calls.scheduled).toHaveLength(2));
    expect(calls.scheduled.map((s) => s.platform)).toEqual(["facebook", "twitter"]);
    expect(calls.scheduled.every((s) => s.contentItemId === 42)).toBe(true);
    expect(calls.published).toHaveLength(0);
  });

  it("reports partial failure without hiding the successes", async () => {
    calls.failPlatforms = new Set(["linkedin"]);
    renderComposer();
    fireEvent.click(screen.getByTestId("checkbox-quick-publish-linkedin"));
    fireEvent.click(screen.getByTestId("button-quick-publish-now"));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Posted to Facebook",
          variant: "destructive",
        }),
      ),
    );
    expect(calls.published).toEqual([{ platform: "facebook", id: 42 }]);
  });

  it("prefers the remembered selection over the item's platform on reopen", () => {
    localStorage.setItem(
      "kokao.quickPublish.platforms",
      JSON.stringify(["linkedin", "twitter"]),
    );
    renderComposer();
    expect(
      screen.getByTestId("checkbox-quick-publish-linkedin").getAttribute("data-state"),
    ).toBe("checked");
    expect(
      screen.getByTestId("checkbox-quick-publish-twitter").getAttribute("data-state"),
    ).toBe("checked");
    expect(
      screen.getByTestId("checkbox-quick-publish-facebook").getAttribute("data-state"),
    ).toBe("unchecked");
  });
});
