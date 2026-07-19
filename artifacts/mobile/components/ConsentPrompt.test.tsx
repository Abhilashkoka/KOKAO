/**
 * Guard: the first-sign-in privacy prompt must appear exactly once.
 * - Shows for a user whose GET /consent says responded: false and who has no
 *   AsyncStorage ack.
 * - Never comes back after "Not now" (per-user AsyncStorage ack).
 * - Never comes back after the user saves any toggle on the Privacy screen
 *   (server then reports responded: true).
 * - Never shows at all for users who already responded.
 * Real generated hooks and a real QueryClient are used; only the network and
 * AsyncStorage are faked.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const storage = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => storage.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      storage.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      storage.delete(k);
    }),
  },
}));

const pushMock = vi.fn();
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => "/",
}));
vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ userId: "user_prompt_test", isSignedIn: true, getToken: async () => null }),
}));
vi.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@/components/ui", () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) => (
    <button onClick={onPress}>{title}</button>
  ),
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ErrorState: () => <div>error</div>,
  Skeleton: () => <div>loading</div>,
}));

import { ConsentPrompt } from "./ConsentPrompt";
import PrivacyScreen from "@/app/privacy";

type Consent = Record<string, unknown>;

let serverConsent: Consent;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  if (!url.includes("/api/consent")) throw new Error(`unexpected fetch: ${url}`);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.includes("/consent/dismiss-prompt")) {
    if (method !== "POST") throw new Error(`unexpected method: ${method}`);
    serverConsent = { ...serverConsent, promptDismissed: true };
  } else if (method === "PUT") {
    serverConsent = {
      ...serverConsent,
      ...JSON.parse(String(init?.body)),
      responded: true,
    };
  }
  return new Response(JSON.stringify(serverConsent), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
vi.stubGlobal("fetch", fetchMock);

function mountPrompt(withPrivacy = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConsentPrompt />
      {withPrivacy ? <PrivacyScreen /> : null}
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  storage.clear();
  pushMock.mockClear();
  fetchMock.mockClear();
  serverConsent = {
    analytics: false,
    deviceDetails: false,
    locationCoarse: false,
    locationPrecise: false,
    carrier: false,
    responded: false,
    promptDismissed: false,
  };
});

describe("ConsentPrompt one-time behavior", () => {
  it("appears for a user with responded: false and no stored ack", async () => {
    mountPrompt();
    expect(await screen.findByText("Your privacy choices")).toBeTruthy();
  });

  it("never appears for a user who already responded", async () => {
    serverConsent.responded = true;
    mountPrompt();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Your privacy choices")).toBeNull();
  });

  it("does not reappear after 'Not now'", async () => {
    const first = mountPrompt();
    fireEvent.click(await screen.findByLabelText("Not now"));
    await waitFor(() =>
      expect(screen.queryByText("Your privacy choices")).toBeNull(),
    );
    await waitFor(() =>
      expect(storage.get("kokao-consent-prompt-user_prompt_test")).toBe("1"),
    );
    first.unmount();

    // Fresh app launch: server still says responded: false, but the ack wins.
    mountPrompt();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Your privacy choices")).toBeNull();
  });

  it("does not reappear after 'Review choices' (routes to /privacy and acks)", async () => {
    const first = mountPrompt();
    fireEvent.click(await screen.findByText("Review choices"));
    expect(pushMock).toHaveBeenCalledWith("/privacy");
    await waitFor(() =>
      expect(storage.get("kokao-consent-prompt-user_prompt_test")).toBe("1"),
    );
    first.unmount();

    mountPrompt();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Your privacy choices")).toBeNull();
  });

  it("persists 'Not now' server-side so a second device never shows the prompt", async () => {
    const first = mountPrompt();
    fireEvent.click(await screen.findByLabelText("Not now"));
    // Dismissal is sent to the server, not just stored locally.
    await waitFor(() => expect(serverConsent.promptDismissed).toBe(true));
    first.unmount();

    // Second device / reinstall: no AsyncStorage ack, but the server-side
    // promptDismissed flag keeps the prompt away.
    storage.clear();
    mountPrompt();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Your privacy choices")).toBeNull();
  });

  it("never shows for a user whose server record already has promptDismissed: true", async () => {
    serverConsent.promptDismissed = true;
    mountPrompt();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Your privacy choices")).toBeNull();
  });

  it("does not reappear after saving any toggle on the Privacy screen (no ack needed)", async () => {
    // User reaches /privacy without acking the prompt (e.g. via the shield
    // icon) and flips a toggle: the server marks responded: true.
    const privacy = render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
          })
        }
      >
        <PrivacyScreen />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByLabelText("Usage analytics"));
    await waitFor(() => expect(serverConsent.responded).toBe(true));
    privacy.unmount();
    expect(storage.size).toBe(0);

    // Next launch: prompt stays away purely because responded is now true.
    mountPrompt();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Your privacy choices")).toBeNull();
  });
});
