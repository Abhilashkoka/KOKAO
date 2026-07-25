/**
 * The image provider card's automatic-routing surface.
 *
 * "Auto" is not a provider — it is a sentinel that hands the choice to the
 * scorer. So the card has to do two things a normal provider row never does:
 * hide the model/key fields for it, and show the admin what the scorer would
 * currently decide, before they commit to it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ImageGenSettingsView,
  ImageGenRankedProvider,
} from "@workspace/api-client-react";

// Radix needs a few APIs jsdom doesn't implement.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const mockState: {
  settings: ImageGenSettingsView;
  lastUpdateVars: { data: Record<string, unknown> } | null;
} = { settings: baseSettings("openai", []), lastUpdateVars: null };

const updateMutate = vi.fn((vars: { data: Record<string, unknown> }) => {
  mockState.lastUpdateVars = vars;
});

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminGetImageGenSettings: () => ({
      data: mockState.settings,
      isLoading: false,
    }),
    useAdminUpdateImageGenSettings: () => ({ mutate: updateMutate, isPending: false }),
  });
});

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { ImageGenProviderCard } from "./ai-tab";

function ranked(
  id: string,
  label: string,
  score: number,
  reason: string,
  healthy = true,
): ImageGenRankedProvider {
  return { id, label, score, reason, healthy };
}

function baseSettings(
  provider: string,
  autoRanking: ImageGenRankedProvider[],
): ImageGenSettingsView {
  return {
    provider,
    model: null,
    customBaseUrl: null,
    providers: [
      {
        id: "openai",
        label: "OpenAI (built-in)",
        defaultModel: "gpt-image-1",
        configured: true,
        supportsModelOverride: false,
        requiresBaseUrl: false,
      },
      {
        id: "gemini",
        label: "Google Gemini",
        defaultModel: "gemini-2.5-flash-image",
        configured: true,
        supportsModelOverride: true,
        requiresBaseUrl: false,
      },
    ],
    autoRanking,
  };
}

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ImageGenProviderCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  updateMutate.mockClear();
  mockState.lastUpdateVars = null;
  mockState.settings = baseSettings("openai", []);
});

describe("image provider card ranking", () => {
  it("keeps the ranking out of the way while a provider is pinned", () => {
    mockState.settings = baseSettings("openai", [
      ranked("gemini", "Google Gemini", 0.71, "not tried yet"),
    ]);
    renderCard();
    // A pinned provider ignores the score, so showing its table would imply
    // the choice is being made for them.
    expect(screen.queryByTestId("image-gen-auto-ranking")).toBeNull();
  });

  it("lists the ranking best first with its evidence and score", async () => {
    mockState.settings = baseSettings("auto", [
      ranked("gemini", "Google Gemini", 0.7123, "4/4 ok · ~3.2s · ₹2.50"),
      ranked("openai", "OpenAI (built-in)", 0.62, "not tried yet"),
    ]);
    renderCard();

    const rows = screen.getByTestId("image-gen-auto-ranking");
    expect(rows.textContent).toContain("Current ranking");
    const order = Array.from(rows.querySelectorAll("li")).map((li) => li.textContent ?? "");
    expect(order[0]).toContain("Google Gemini");
    expect(order[1]).toContain("OpenAI (built-in)");
    // Numbered so "best first" is readable without comparing the scores.
    expect(order[0]).toContain("1.");
    expect(order[0]).toContain("4/4 ok · ~3.2s · ₹2.50");
    // 0..1 is the scorer's unit, not a useful one to read: shown as 0-100.
    expect(order[0]).toContain("71");
    expect(screen.getByText(/Ranked per request/)).toBeTruthy();
  });

  it("marks a provider whose breaker is open", () => {
    mockState.settings = baseSettings("auto", [
      ranked("openai", "OpenAI (built-in)", 0.62, "not tried yet"),
      ranked("gemini", "Google Gemini", 0.44, "breaker open · 0/3 ok", false),
    ]);
    renderCard();
    expect(screen.getByTestId("ranking-row-gemini").textContent).toContain("Cooling off");
    expect(screen.getByTestId("ranking-row-openai").textContent).not.toContain("Cooling off");
  });

  it("says why the ranking is empty instead of showing a blank box", () => {
    mockState.settings = baseSettings("auto", []);
    renderCard();
    expect(screen.getByTestId("image-gen-auto-ranking").textContent).toContain(
      "No provider is configured yet",
    );
  });

  it("saves auto with no model or base URL of its own", async () => {
    mockState.settings = baseSettings("gemini", []);
    renderCard();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("select-image-gen-provider"));
    await user.click(screen.getByRole("option", { name: /Auto/ }));

    await waitFor(() => expect(mockState.lastUpdateVars).toBeTruthy());
    // Any model override left over from the pinned provider must not travel
    // with the switch — under auto each provider uses its own default.
    expect(mockState.lastUpdateVars!.data).toEqual({
      provider: "auto",
      model: null,
      customBaseUrl: null,
    });
  });

  it("hides the model field under auto", async () => {
    mockState.settings = baseSettings("auto", []);
    renderCard();
    // "auto" is not in the catalog, so there is no provider whose model or key
    // could be edited here.
    expect(screen.queryByTestId("input-image-gen-model")).toBeNull();
  });
});
