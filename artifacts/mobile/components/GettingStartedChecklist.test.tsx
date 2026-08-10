/**
 * Guard: the mobile first-post checklist mirrors the web dashboard nudge.
 * - Shows for a tenant that hasn't published or dismissed, with per-step
 *   done/next state driven by GET /api/first-post-progress.
 * - Hidden when the tenant has published or already dismissed (shared flag).
 * - Dismissing posts to /api/first-post-progress/dismiss and hides the card
 *   after refetch.
 * - Next-step CTA navigates to the matching tab and tracks the click.
 * Real generated hooks and a real QueryClient are used; only the network is
 * faked.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const pushMock = vi.fn();
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => "/",
}));
vi.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

const trackMock = vi.fn();
vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => trackMock(...args),
}));

import { GettingStartedChecklist } from "./GettingStartedChecklist";

interface Progress {
  generated: boolean;
  saved: boolean;
  connected: boolean;
  published: boolean;
  dismissed: boolean;
}

let serverProgress: Progress;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("/first-post-progress/dismiss")) {
    serverProgress.dismissed = true;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/first-post-progress")) {
    return new Response(JSON.stringify(serverProgress), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected fetch: ${url} ${init?.method ?? "GET"}`);
});
vi.stubGlobal("fetch", fetchMock);

function renderChecklist() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <GettingStartedChecklist />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  pushMock.mockClear();
  trackMock.mockClear();
  fetchMock.mockClear();
  serverProgress = {
    generated: true,
    saved: false,
    connected: false,
    published: false,
    dismissed: false,
  };
});

describe("GettingStartedChecklist (mobile)", () => {
  it("shows steps and tracks the shown event for a stalled tenant", async () => {
    renderChecklist();
    expect(await screen.findByTestId("checklist-getting-started")).toBeTruthy();
    expect(screen.getByText("Get your first post live")).toBeTruthy();
    expect(screen.getByText(/1 of 4 steps done/)).toBeTruthy();
    // next step is "save" → CTA points at Library
    expect(screen.getByTestId("button-step-save")).toBeTruthy();
    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith("first_post_nudge_shown", {
        next_step: "save",
        steps_done: 1,
      }),
    );
  });

  it("CTA navigates to the matching tab and tracks the click", async () => {
    renderChecklist();
    fireEvent.click(await screen.findByTestId("button-step-save"));
    expect(trackMock).toHaveBeenCalledWith("first_post_nudge_step_clicked", {
      step: "save",
    });
    expect(pushMock).toHaveBeenCalledWith("/(tabs)/library");
  });

  it("renders nothing when the tenant has published", async () => {
    serverProgress.published = true;
    serverProgress.generated = true;
    renderChecklist();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("checklist-getting-started")).toBeNull();
  });

  it("renders nothing when already dismissed (shared server flag)", async () => {
    serverProgress.dismissed = true;
    renderChecklist();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("checklist-getting-started")).toBeNull();
  });

  it("dismiss persists server-side and hides the checklist", async () => {
    renderChecklist();
    fireEvent.click(await screen.findByTestId("button-dismiss-checklist"));
    await waitFor(() =>
      expect(screen.queryByTestId("checklist-getting-started")).toBeNull(),
    );
    expect(serverProgress.dismissed).toBe(true);
    expect(trackMock).toHaveBeenCalledWith("first_post_nudge_dismissed", {
      next_step: "save",
      steps_done: 1,
    });
  });
});
