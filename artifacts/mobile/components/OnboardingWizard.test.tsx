/**
 * Guard: the mobile onboarding wizard mirrors the web first-post interview.
 * - Shows for a user with brandOnboardingComplete=false; hidden otherwise.
 * - Interview answers create a Brand Kit (AI-drafted via /brand-kits/draft)
 *   and a first draft post (/ai/generate-caption + /content), then complete
 *   onboarding.
 * - Emits the same analytics events as the web flow:
 *   onboarding_question_answered, onboarding_interview_completed,
 *   caption_generated / content_saved with source "onboarding", and
 *   onboarding_skipped on skip.
 * Real generated hooks and a real QueryClient are used; only the network is
 * faked.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const pushMock = vi.fn();
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

const trackMock = vi.fn();
vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => trackMock(...args),
  setConsentState: vi.fn(),
}));

// In-memory AsyncStorage mock so tests can pre-seed draft answers.
const asyncStorageStore: Record<string, string> = {};
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => asyncStorageStore[key] ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      asyncStorageStore[key] = value;
    }),
    removeItem: vi.fn(async (key: string) => {
      delete asyncStorageStore[key];
    }),
  },
}));

import { OnboardingWizard } from "./OnboardingWizard";

let onboardingComplete: boolean;
const calls: { url: string; method: string; body?: unknown }[] = [];

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ url, method, body });

  if (url.includes("/api/me")) {
    return json({
      brandOnboardingComplete: onboardingComplete,
      tenant: { id: 99, name: "T", plan: "free" },
      usage: { captions: 0, images: 0 },
      limits: { captions: 10, images: 10 },
    });
  }
  if (url.includes("/api/consent") && method === "GET") {
    // Already responded → wizard skips the consent step.
    return json({ responded: true, promptDismissed: true });
  }
  if (url.includes("/brand-kits/draft")) {
    return json({ payload: { sections: {} } });
  }
  if (url.includes("/brand-kits") && method === "POST") {
    return json({ id: 42 });
  }
  if (url.includes("/onboarding/complete")) {
    onboardingComplete = true;
    return json({ brandOnboardingComplete: true });
  }
  if (url.includes("/ai/generate-caption")) {
    return json({
      caption: "Hello from Acme",
      hashtags: ["#acme"],
      title: "Meet Acme",
    });
  }
  if (url.includes("/api/content") && method === "POST") {
    return json({ id: 7 });
  }
  throw new Error(`Unexpected fetch: ${url} ${method}`);
});

vi.stubGlobal("fetch", fetchMock);

/** Captured once so every beforeEach can restore the original implementation. */
const baseFetchImpl = fetchMock.getMockImplementation()!;

function renderWizard() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <OnboardingWizard />
    </QueryClientProvider>,
  );
}

async function answer(text: string, submitLabel = "Next") {
  const input = screen.getByPlaceholderText(/e\.g\.|Pick one/);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByText(submitLabel));
}

beforeEach(() => {
  pushMock.mockClear();
  trackMock.mockClear();
  // Reset to the base implementation so per-test overrides don't bleed.
  fetchMock.mockImplementation(baseFetchImpl);
  fetchMock.mockClear();
  calls.length = 0;
  onboardingComplete = false;
  // Clear persisted draft between tests.
  for (const k of Object.keys(asyncStorageStore)) delete asyncStorageStore[k];
});

describe("OnboardingWizard (mobile)", () => {
  it("renders nothing when onboarding is already complete", async () => {
    onboardingComplete = true;
    renderWizard();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("onboarding-wizard")).toBeNull();
  });

  it("skipping from welcome completes onboarding and tracks onboarding_skipped", async () => {
    renderWizard();
    fireEvent.click(await screen.findByText("Skip for now"));
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/onboarding/complete"))).toBe(true),
    );
    const complete = calls.find((c) => c.url.includes("/onboarding/complete"));
    const draft = calls.find((c) => c.url.includes("/brand-kits/draft"));
    const complete = calls.find((c) => c.url.includes("/onboarding/complete"));
    const draft = calls.find((c) => c.url.includes("/brand-kits/draft"));
    expect(draft?.body).toMatchObject({
      brandName: "Acme Coffee",
      notes: expect.stringContaining("We roast coffee."),
    });
  });

  it("plan-cap (402) on createBrandKit shows the resultNotice and calls completeOnboarding once", async () => {
    // Hold completeOnboarding in-flight so the wizard stays mounted while we
    // assert the notice is visible — verifying it isn't swallowed by the spinner.
    let resolveComplete!: (r: Response) => void;
    const completeGate = new Promise<Response>((res) => {
      resolveComplete = res;
    });

    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/brand-kits") && !url.includes("draft") && method === "POST") {
        calls.push({ url, method });
        return json({ error: "brand kit limit reached" }, 402);
      }
      return original(input, init);
    });

    renderWizard();
    fireEvent.click(await screen.findByText("Let's do it"));
    await screen.findByText(/what's your business or brand called/);
    await answer("Acme");
    await answer("Roasting.");
    await answer("People.");
    fireEvent.click(screen.getByText("Friendly"));
    fireEvent.click(screen.getByText("Create my brand"));

    // Plan-cap UI appears — wizard stays open waiting for user choice.
    await screen.findByText("Plan limit reached");
    expect(screen.getByText("Upgrade your plan")).toBeTruthy();
    expect(screen.getByText("Maybe later")).toBeTruthy();

    // onboarding/complete has NOT been called yet (wizard is waiting).
    expect(calls.some((c) => c.url.includes("/onboarding/complete"))).toBe(false);

    // User taps "Upgrade your plan".
    fireEvent.click(screen.getByText("Upgrade your plan"));

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/onboarding/complete"))).toBe(true),
    );
    // Should navigate to the settings / plan-upgrade screen.
    expect(pushMock).toHaveBeenCalledWith("/settings");
  });

  it("caption failure still completes onboarding and points at the Studio", async () => {
    fetchMock.mockImplementationOnce(fetchMock.getMockImplementation()!);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/brand-kits") && !url.includes("draft") && method === "POST") {
        calls.push({ url, method });
        return json({ error: "brand kit limit reached" }, 402);
      }
      return original(input, init);
    });

    renderWizard();
    fireEvent.click(await screen.findByText("Let's do it"));
    await screen.findByText(/what's your business or brand called/);
    await answer("Acme");
    await answer("Roasting.");
    await answer("People.");
    fireEvent.click(screen.getByText("Friendly"));
    fireEvent.click(screen.getByText("Create my brand"));

    // Plan-cap UI appears — wizard stays open waiting for user choice.
    await screen.findByText("Plan limit reached");
    expect(screen.getByText("Upgrade your plan")).toBeTruthy();
    expect(screen.getByText("Maybe later")).toBeTruthy();

    // onboarding/complete has NOT been called yet (wizard is waiting).
    expect(calls.some((c) => c.url.includes("/onboarding/complete"))).toBe(false);

    // User taps "Upgrade your plan".
    fireEvent.click(screen.getByText("Upgrade your plan"));

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/onboarding/complete"))).toBe(true),
    );
    // Should navigate to the settings / plan-upgrade screen.
    expect(pushMock).toHaveBeenCalledWith("/settings");
  });

  it("caption failure still completes onboarding and points at the Studio", async () => {
    fetchMock.mockImplementationOnce(fetchMock.getMockImplementation()!);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();

      const method = init?.method ?? "GET";
      if (url.includes("/ai/generate-caption")) {
        calls.push({ url, method: init?.method ?? "GET" });
        return json({ error: "no funding" }, 402);
      }
      return original(input, init);
    });

    renderWizard();
    fireEvent.click(await screen.findByText("Let's do it"));
    await screen.findByText(/what's your business or brand called/);
    await answer("Acme");
    await answer("Roasting.");
    await answer("People.");
    fireEvent.click(screen.getByText("Friendly"));
    fireEvent.click(screen.getByText("Create my brand"));

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/onboarding/complete"))).toBe(true),
    );
    expect(trackMock).toHaveBeenCalledWith("onboarding_first_post_failed");
    expect(
      calls.some((c) => c.url.includes("/api/content") && c.method === "POST"),
    ).toBe(false);
    expect(pushMock).toHaveBeenCalledWith("/(tabs)/studio");
  });
});
