import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = vi.hoisted(() => ({
  profile: { isOwner: false, isSuperadmin: false, team: { role: "owner" }, tenant: { id: 1 } },
}));
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
  useGetMe: () => ({ data: state.profile }),
  useListVideoPublishSupport: () => ({ data: [], isLoading: false }),
  getListVideoPublishSupportQueryKey: () => ["/api/video-publish-support"],
  getListContentQueryKey: () => ["/api/content"],
  getListVideoPublishesQueryKey: () => ["/api/content/1/video-publishes"],
  reconcileVideoPublishSupport: vi.fn(),
  resolveVideoPublishSupport: vi.fn(),
  });
});
import { VideoPublishSupport } from "./video-publish-support";
afterEach(cleanup);
describe("video support workspace authorization", () => {
  it.each([
    ["owner", false, false, true],
    ["admin", false, false, false],
    ["member", false, false, false],
    ["member", false, true, true],
    ["member", true, false, false],
  ])("uses workspace role %s (root owner=%s, superadmin=%s)", (role, isOwner, isSuperadmin, visible) => {
    state.profile = { isOwner, isSuperadmin, team: { role }, tenant: { id: 1 } };
    render(<QueryClientProvider client={new QueryClient()}><VideoPublishSupport /></QueryClientProvider>);
    expect(Boolean(screen.queryByTestId("card-video-publish-support"))).toBe(visible);
  });
});