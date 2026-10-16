import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SmartEditState, SmartEditAttemptView } from "@workspace/api-client-react";

const mock = vi.hoisted(() => ({
  state: null as unknown as SmartEditState,
  create: vi.fn(), quote: vi.fn(), approve: vi.fn(), discard: vi.fn(), restore: vi.fn(),
  cancel: vi.fn().mockResolvedValue(undefined), fetch: vi.fn().mockResolvedValue(undefined),
  invalidate: vi.fn(), cache: vi.fn(), getCredits: vi.fn(), refetch: vi.fn(),
  stateError: null as unknown, options: null as unknown,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    cancelQueries: mock.cancel, fetchQuery: mock.fetch, invalidateQueries: mock.invalidate, setQueryData: mock.cache,
  }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetSmartEdit: (_: number, options: unknown) => {
      mock.options = options;
      return { data: mock.state, isPending: false, isError: !!mock.stateError, error: mock.stateError, refetch: mock.refetch };
    },
    useGetVideoJob: () => ({ data: { id: 8, status: "succeeded", aspectRatio: "9:16", compliance: { profession: "medical" } }, refetch: mock.refetch }),
    useCreateSmartEdit: () => ({ mutate: mock.create, isPending: false }),
    useQuoteSmartEdit: () => ({ mutateAsync: mock.quote }),
    useApproveSmartEdit: () => ({ mutate: mock.approve, isPending: false }),
    useDiscardSmartEdit: () => ({ mutate: mock.discard, isPending: false }),
    useRestoreSmartEditVersion: () => ({ mutate: mock.restore, isPending: false }),
    getCredits: mock.getCredits,
  });
});
vi.mock("@/components/KeyboardAwareScrollViewCompat", () => ({
  KeyboardAwareScrollViewCompat: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ui", () => ({
  Button: ({ title, disabled, loading, onPress, testID }: { title: string; disabled?: boolean; loading?: boolean; onPress: () => void; testID?: string }) =>
    <button data-testid={testID} disabled={disabled || loading} onClick={onPress}>{title}</button>,
}));
vi.mock("@/components/SmartEditPlayer", () => ({
  SmartEditPlayer: ({ path, onLoad, onBox }: {
    path: string; onLoad?: (duration: number) => void; onBox?: (box: unknown) => void;
  }) => {
    React.useEffect(() => { onLoad?.(30); }, []);
    return <div data-testid="video-path">{path}
      {onBox && <button onClick={() => onBox({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })}>Draw test region</button>}
    </div>;
  },
}));
import { SmartEditScreen } from "./SmartEditScreen";

const attempt = (status: SmartEditAttemptView["status"], baseVersionId = "v0"): SmartEditAttemptView => ({
  id: "e1", type: "change", status, startSec: 0, endSec: 3, box: null, instruction: "blue coat",
  dialogueText: null, baseVersionId, cutPath: "/before.mp4", startFramePath: "/frame.jpg",
  editedStartFramePath: null, clipPath: "/after.mp4", childJobId: 12, stage: "Generating the video",
  error: status === "failed" ? "Provider unavailable" : null, resultVersionId: null, createdAt: "2026-10-14",
});

beforeEach(() => {
  vi.clearAllMocks();
  mock.stateError = null;
  mock.state = {
    jobId: 8, currentVersionId: "v0", currentVideoPath: "/original.mp4",
    versions: [{ id: "v0", path: "/original.mp4", thumbnailPath: null, durationSec: 30, editId: null, createdAt: "2026-10-14", label: "Original" }],
    edits: [], limits: { minSeconds: 1, maxSeconds: 12, keepVersions: 10 },
  };
  mock.quote.mockResolvedValue({ credits: 5, lines: [] });
});
afterEach(cleanup);

async function quoteReady() {
  await waitFor(() => expect(screen.getByText("≈ 5 credits")).toBeTruthy(), { timeout: 2000 });
}

describe("native Smart Edit shared API workflow", () => {
  it("quotes the selection and submits the pinned current version without server-owned fields", async () => {
    render(<SmartEditScreen jobId={8} />);
    fireEvent.change(screen.getByTestId("smart-edit-instruction"), { target: { value: "Make the coat blue" } });
    await quoteReady();
    fireEvent.click(screen.getByTestId("smart-edit-generate"));
    expect(mock.create.mock.calls[0][0]).toEqual({
      jobId: 8, data: { type: "change", startSec: 0, endSec: 3, box: null,
        instruction: "Make the coat blue", dialogueText: null, baseVersionId: "v0" },
    });
    act(() => mock.create.mock.calls[0][1].onSuccess(mock.state));
    await waitFor(() => expect(mock.fetch).toHaveBeenCalled());
    expect(mock.cache).toHaveBeenCalled();
    expect(mock.invalidate.mock.calls.map(([arg]) => arg.queryKey[0])).toContain("getListVideoJobsQueryKey");
    expect(mock.cancel).toHaveBeenCalled();
  });
  it("requires fresh dialogue consent and sends only the selected explicit voice", async () => {
    render(<SmartEditScreen jobId={8} />);
    fireEvent.click(screen.getByTestId("smart-edit-type-dialogue"));
    fireEvent.change(screen.getByTestId("smart-edit-dialogue"), { target: { value: "Hello there" } });
    fireEvent.click(screen.getByText("nova"));
    await quoteReady();
    expect((screen.getByTestId("smart-edit-generate") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByTestId("smart-edit-generate"));
    expect(mock.create.mock.calls[0][0].data).toMatchObject({ consent: true, voice: "nova", dialogueText: "Hello there" });
  });
  it("requires a marked region for removal and includes normalized coordinates", async () => {
    render(<SmartEditScreen jobId={8} />);
    fireEvent.click(screen.getByTestId("smart-edit-type-remove"));
    expect((screen.getByTestId("smart-edit-generate") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Draw test region"));
    await quoteReady();
    fireEvent.click(screen.getByTestId("smart-edit-generate"));
    expect(mock.create.mock.calls[0][0].data.box).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
  });
  it("shows Before/After but blocks approval of stale attempts", () => {
    mock.state.edits = [attempt("ready", "older")];
    render(<SmartEditScreen jobId={8} />);
    expect(screen.getByText("Before")).toBeTruthy();
    expect(screen.getByText("After")).toBeTruthy();
    expect(screen.queryByText("Approve & stitch")).toBeNull();
    fireEvent.click(screen.getByText("Try again"));
    expect(mock.create).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("blue coat")).toBeTruthy();
  });
  it("approves only after confirmation and publishes new video and balances", async () => {
    mock.state.edits = [attempt("ready")];
    render(<SmartEditScreen jobId={8} />);
    fireEvent.click(screen.getByText("Approve & stitch"));
    expect(mock.approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm approve"));
    expect(mock.approve.mock.calls[0][0]).toEqual({ jobId: 8, editId: "e1" });
    act(() => mock.approve.mock.calls[0][1].onSuccess({ ...mock.state, currentVersionId: "v1", currentVideoPath: "/stitched.mp4" }));
    await waitFor(() => expect(mock.fetch).toHaveBeenCalled());
    expect(mock.cache.mock.calls[0][1].currentVideoPath).toBe("/stitched.mp4");
    expect(mock.invalidate.mock.calls.map(([arg]) => arg.queryKey[0])).toContain("getGetVideoJobQueryKey");
  });
  it("discards a generating attempt without replacing the current video", () => {
    mock.state.edits = [attempt("generating")];
    render(<SmartEditScreen jobId={8} />);
    expect(screen.getByText("Generating the video")).toBeTruthy();
    fireEvent.click(screen.getByText("Discard"));
    expect(screen.getByText(/not refunded/)).toBeTruthy();
    fireEvent.click(screen.getByText("Confirm discard"));
    expect(mock.discard.mock.calls[0][0]).toEqual({ jobId: 8, editId: "e1" });
    const interval = (mock.options as { query: { refetchInterval: (query: unknown) => number } }).query.refetchInterval;
    expect(interval({ state: { data: mock.state } })).toBe(4000);
    expect(interval({ state: { data: { ...mock.state, edits: [] } } })).toBe(15000);
  });
  it("restores the original and resets the marked editor when the version changes", () => {
    mock.state.currentVersionId = "v1";
    mock.state.currentVideoPath = "/stitched.mp4";
    mock.state.versions.push({ ...mock.state.versions[0], id: "v1", path: "/stitched.mp4", label: "Edit 1" });
    const rendered = render(<SmartEditScreen jobId={8} />);
    fireEvent.click(screen.getByText("Restore"));
    fireEvent.click(screen.getByText("Confirm restore"));
    expect(mock.restore.mock.calls[0][0]).toEqual({ jobId: 8, versionId: "v0" });
    mock.state = { ...mock.state, currentVersionId: "v0", currentVideoPath: "/original.mp4" };
    act(() => mock.restore.mock.calls[0][1].onSuccess(mock.state));
    rendered.rerender(<SmartEditScreen jobId={8} />);
    expect(screen.getAllByTestId("video-path")[0].textContent).toContain("/original.mp4");
  });
  it("surfaces free-plan and compliance errors and refreshes state after rejected mutations", async () => {
    render(<SmartEditScreen jobId={8} />);
    fireEvent.change(screen.getByTestId("smart-edit-instruction"), { target: { value: "New product claim" } });
    await quoteReady();
    fireEvent.click(screen.getByTestId("smart-edit-generate"));
    act(() => mock.create.mock.calls[0][1].onError({ data: { error: "AI video is not available on your free plan." } }));
    expect(screen.getByText(/AI video is not available/)).toBeTruthy();
    expect(mock.invalidate).toHaveBeenCalled();
  });
  it("does not display or submit an obsolete quote response", async () => {
    let resolveOld!: (value: { credits: number }) => void;
    mock.quote.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    render(<SmartEditScreen jobId={8} />);
    await waitFor(() => expect(mock.quote).toHaveBeenCalled(), { timeout: 2000 });
    fireEvent.change(screen.getByTestId("smart-edit-instruction"), { target: { value: "New request" } });
    await act(async () => resolveOld({ credits: 999 }));
    expect(screen.queryByText("≈ 999 credits")).toBeNull();
    await quoteReady();
  });
  it("reloads after a state fetch failure", () => {
    mock.stateError = { data: { error: "Video not found." } };
    render(<SmartEditScreen jobId={8} />);
    expect(screen.getByText("Video not found.")).toBeTruthy();
    fireEvent.click(screen.getByText("Reload"));
    expect(mock.refetch).toHaveBeenCalled();
  });
});
