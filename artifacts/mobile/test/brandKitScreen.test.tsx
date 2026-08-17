// @vitest-environment jsdom
/**
 * Brand Kit screen (mobile) — unit + integration tests.
 *
 * Covers:
 *  1. Pure helpers: payloadToEdit, applyEditToPayload (section preservation),
 *     isDirty
 *  2. Component: seeding from activePayload, dirty detection, save mutation
 *     call shape, post-save cache invalidation, save error notice
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── shims ──────────────────────────────────────────────────────────────────
vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));
vi.mock("@/lib/haptics", () => ({ haptic: vi.fn() }));
vi.mock("@/lib/apiErrorMessage", () => ({
  apiErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

// Minimal UI component shims — enough for the tests without styling noise.
vi.mock("@/components/ui", () => ({
  Button: ({
    title,
    onPress,
    disabled,
    testID,
  }: {
    title: string;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
  }) => (
    <button
      onClick={disabled ? undefined : onPress}
      disabled={disabled}
      data-testid={testID ?? `btn-${title.toLowerCase().replace(/\s+/g, "-")}`}
    >
      {title}
    </button>
  ),
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Chip: ({ label, onPress }: { label: string; onPress?: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
  EmptyState: ({ title }: { title: string }) => <div data-testid="empty-state">{title}</div>,
  ErrorState: ({ message }: { message?: string }) => (
    <div data-testid="error-state">Error: {message}</div>
  ),
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
  Skeleton: ({ height }: { height?: number }) => (
    <div data-testid="skeleton" style={{ height }} aria-busy="true" />
  ),
}));

// ── api-client-react mock ──────────────────────────────────────────────────

// Mutable state shared between mock factories and test bodies.
const listState: {
  data: unknown[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error?: { message?: string } | null;
} = { data: undefined, isLoading: true, isError: false };

const detailState: {
  data: unknown | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
} = { data: undefined, isLoading: false, isFetching: false, isError: false };

// Capture mutate calls so tests can inspect args and fire callbacks.
let lastMutateVars: unknown = undefined;
let lastMutateCallbacks: {
  onSuccess?: (res: unknown) => void;
  onError?: (err: unknown) => void;
} = {};
const mutateSpy = vi.fn((vars: unknown, opts: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void } = {}) => {
  lastMutateVars = vars;
  lastMutateCallbacks = opts;
});

let createVersionIsPending = false;

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  return createApiClientMock({
    useListBrandKits: () => ({ ...listState, refetch: vi.fn() }),
    useGetBrandKit: () => ({ ...detailState }),
    useCreateBrandKitVersion: () => ({
      mutate: mutateSpy,
      isPending: createVersionIsPending,
      isError: false,
      isSuccess: false,
    }),
    getListBrandKitsQueryKey: () => ["list-brand-kits"],
    getGetBrandKitQueryKey: (id: number) => ["get-brand-kit", id],
  });
});

// ── import after mocks are set up ─────────────────────────────────────────
import BrandKitScreen, { payloadToEdit, applyEditToPayload, isDirty } from "../app/brand-kit";
import type { BrandKitPayload } from "@workspace/api-client-react";

// ── helpers ────────────────────────────────────────────────────────────────

const FULL_PAYLOAD: BrandKitPayload = {
  identity: {
    brand_name: "Acme",
    tagline: "We do stuff",
    description: "A fine company",
    industry: "SaaS",
    audience: ["developers", "designers"],
  },
  voice: {
    traits: ["bold", "friendly"],
    dos: ["Be direct", "Use plain language"],
    donts: ["Use jargon", "Make promises"],
    caption_style: "short and punchy",
  },
  // Non-identity/voice sections that must be preserved verbatim.
  colors: {
    primary: [{ hex: "#ff0000", name: "Red" }],
    secondary: [{ hex: "#00ff00", name: "Green" }],
    neutral: [],
  },
  typography: { heading: "Montserrat", body: "Inter" },
  logos: [{ url: "https://cdn.example/logo.png", name: "Primary" }],
} as unknown as BrandKitPayload;

const KIT_LIST_ITEM = { id: 1, name: "Acme", isDefault: true, isArchived: false };
const KIT_DETAIL = {
  id: 1,
  name: "Acme",
  activeVersion: { payload: FULL_PAYLOAD },
};

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderScreen(queryClient = makeQueryClient()) {
  return {
    qc: queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <BrandKitScreen />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  // Reset shared state to a clean "loaded, single kit" baseline.
  listState.data = [KIT_LIST_ITEM];
  listState.isLoading = false;
  listState.isError = false;
  listState.error = null;

  detailState.data = KIT_DETAIL;
  detailState.isLoading = false;
  detailState.isFetching = false;
  detailState.isError = false;

  createVersionIsPending = false;
  mutateSpy.mockClear();
  lastMutateVars = undefined;
  lastMutateCallbacks = {};
});

// ══════════════════════════════════════════════════════════════════════════
// 1. Pure helper tests
// ══════════════════════════════════════════════════════════════════════════

describe("payloadToEdit", () => {
  it("maps identity and voice fields to flat EditState strings", () => {
    const edit = payloadToEdit(FULL_PAYLOAD);
    expect(edit.brandName).toBe("Acme");
    expect(edit.tagline).toBe("We do stuff");
    expect(edit.description).toBe("A fine company");
    expect(edit.industry).toBe("SaaS");
    expect(edit.audience).toBe("developers, designers");
    expect(edit.traits).toBe("bold, friendly");
    expect(edit.dos).toBe("Be direct\nUse plain language");
    expect(edit.donts).toBe("Use jargon\nMake promises");
    expect(edit.captionStyle).toBe("short and punchy");
  });

  it("handles missing optional arrays gracefully", () => {
    const sparse: BrandKitPayload = {
      identity: {},
      voice: {},
    } as unknown as BrandKitPayload;
    const edit = payloadToEdit(sparse);
    expect(edit.audience).toBe("");
    expect(edit.traits).toBe("");
    expect(edit.dos).toBe("");
    expect(edit.donts).toBe("");
  });
});

describe("applyEditToPayload — section preservation", () => {
  it("updates identity fields and leaves colors/typography/logos untouched", () => {
    const edit = payloadToEdit(FULL_PAYLOAD);
    const updated = { ...edit, brandName: "New Name", industry: "Fintech" };
    const result = applyEditToPayload(FULL_PAYLOAD, updated);

    // Changed fields
    expect(result.identity.brand_name).toBe("New Name");
    expect(result.identity.industry).toBe("Fintech");

    // Non-edited identity fields preserved
    expect(result.identity.tagline).toBe("We do stuff");
    expect(result.identity.description).toBe("A fine company");
    expect(result.identity.audience).toEqual(["developers", "designers"]);

    // Non-edited sections preserved verbatim (deep clone, not same reference)
    expect(result.colors).toEqual(FULL_PAYLOAD.colors);
    expect(result.typography).toEqual(FULL_PAYLOAD.typography);
    expect(result.logos).toEqual(FULL_PAYLOAD.logos);

    // Confirm it's a deep clone — mutating the result doesn't affect the original
    (result.colors as Record<string, unknown>).primary = [];
    expect((FULL_PAYLOAD.colors as Record<string, unknown>).primary).toHaveLength(1);
  });

  it("updates voice fields and leaves identity sections untouched", () => {
    const edit = payloadToEdit(FULL_PAYLOAD);
    const updated = {
      ...edit,
      traits: "witty, warm",
      dos: "Tell stories\nAsk questions",
      donts: "",
      captionStyle: "conversational",
    };
    const result = applyEditToPayload(FULL_PAYLOAD, updated);

    expect(result.voice.traits).toEqual(["witty", "warm"]);
    expect(result.voice.dos).toEqual(["Tell stories", "Ask questions"]);
    expect(result.voice.donts).toEqual([]);
    expect(result.voice.caption_style).toBe("conversational");

    // Identity untouched
    expect(result.identity.brand_name).toBe("Acme");
    expect(result.identity.industry).toBe("SaaS");
  });

  it("trims whitespace from text fields", () => {
    const edit = payloadToEdit(FULL_PAYLOAD);
    const updated = { ...edit, brandName: "  Trimmed  ", captionStyle: "  yes  " };
    const result = applyEditToPayload(FULL_PAYLOAD, updated);
    expect(result.identity.brand_name).toBe("Trimmed");
    expect(result.voice.caption_style).toBe("yes");
  });

  it("splits comma-separated audience into an array, dropping blanks", () => {
    const edit = payloadToEdit(FULL_PAYLOAD);
    const updated = { ...edit, audience: " founders,  , makers , " };
    const result = applyEditToPayload(FULL_PAYLOAD, updated);
    expect(result.identity.audience).toEqual(["founders", "makers"]);
  });
});

describe("isDirty", () => {
  it("returns false when current equals original", () => {
    const edit = payloadToEdit(FULL_PAYLOAD);
    expect(isDirty(edit, edit)).toBe(false);
    expect(isDirty({ ...edit }, { ...edit })).toBe(false);
  });

  it("returns true when any field differs", () => {
    const edit = payloadToEdit(FULL_PAYLOAD);
    expect(isDirty({ ...edit, brandName: "Changed" }, edit)).toBe(true);
    expect(isDirty({ ...edit, traits: "" }, edit)).toBe(true);
    expect(isDirty({ ...edit, dos: "New line" }, edit)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. BrandKitScreen component tests
// ══════════════════════════════════════════════════════════════════════════

describe("BrandKitScreen — loading state", () => {
  it("shows skeletons while the kit list is loading", () => {
    listState.data = undefined;
    listState.isLoading = true;
    renderScreen();
    expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0);
  });

  it("shows the error state when list fetch fails", () => {
    listState.data = undefined;
    listState.isLoading = false;
    listState.isError = true;
    listState.error = { message: "Network error" };
    renderScreen();
    expect(screen.getByTestId("error-state")).toBeTruthy();
  });

  it("shows the empty state when there are no kits", () => {
    listState.data = [];
    listState.isLoading = false;
    renderScreen();
    expect(screen.getByTestId("empty-state")).toBeTruthy();
  });
});

describe("BrandKitScreen — seeding from activePayload", () => {
  it("pre-fills brand name and tagline from the active kit payload", async () => {
    renderScreen();
    // TextInput renders as <input> in react-native-web
    const nameInput = screen.getByTestId("input-brand-name") as HTMLInputElement;
    const taglineInput = screen.getByTestId("input-tagline") as HTMLInputElement;
    expect(nameInput.value).toBe("Acme");
    expect(taglineInput.value).toBe("We do stuff");
  });

  it("pre-fills voice fields from the active kit payload", async () => {
    renderScreen();
    const traitsInput = screen.getByTestId("input-traits") as HTMLInputElement;
    const captionInput = screen.getByTestId("input-caption-style") as HTMLInputElement;
    expect(traitsInput.value).toBe("bold, friendly");
    expect(captionInput.value).toBe("short and punchy");
  });

  it("pre-fills dos and donts as newline-separated text", async () => {
    renderScreen();
    const dosInput = screen.getByTestId("input-dos") as HTMLInputElement;
    const dontsInput = screen.getByTestId("input-donts") as HTMLInputElement;
    expect(dosInput.value).toBe("Be direct\nUse plain language");
    expect(dontsInput.value).toBe("Use jargon\nMake promises");
  });
});

describe("BrandKitScreen — dirty detection", () => {
  it("save button is disabled when the form is clean (no edits)", async () => {
    renderScreen();
    const saveBtn = screen.getByText("Save brand kit") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it("save button becomes enabled after a field is edited", async () => {
    renderScreen();
    const nameInput = screen.getByTestId("input-brand-name");
    fireEvent.change(nameInput, { target: { value: "New Brand Name" } });

    await waitFor(() => {
      const saveBtn = screen.getByText("Save brand kit") as HTMLButtonElement;
      expect(saveBtn.disabled).toBe(false);
    });
  });

  it("save button stays disabled when the edit is reverted to the original value", async () => {
    renderScreen();
    const nameInput = screen.getByTestId("input-brand-name");
    fireEvent.change(nameInput, { target: { value: "Changed" } });
    fireEvent.change(nameInput, { target: { value: "Acme" } }); // revert

    await waitFor(() => {
      const saveBtn = screen.getByText("Save brand kit") as HTMLButtonElement;
      expect(saveBtn.disabled).toBe(true);
    });
  });
});

describe("BrandKitScreen — save mutation call shape", () => {
  it("calls createVersion.mutate with the correct id, payload, and flags", async () => {
    renderScreen();

    // Make the form dirty
    const nameInput = screen.getByTestId("input-brand-name");
    fireEvent.change(nameInput, { target: { value: "Updated Brand" } });

    await waitFor(() => {
      const saveBtn = screen.getByText("Save brand kit") as HTMLButtonElement;
      expect(saveBtn.disabled).toBe(false);
    });

    fireEvent.click(screen.getByText("Save brand kit"));

    await waitFor(() => expect(mutateSpy).toHaveBeenCalledTimes(1));

    const [vars] = mutateSpy.mock.calls[0] as [{ id: number; data: Record<string, unknown> }];
    expect(vars.id).toBe(1);
    expect(vars.data.sourceType).toBe("manual");
    expect(vars.data.approvalStatus).toBe("approved");
    expect(vars.data.activate).toBe(true);

    // Payload must reflect the edit and preserve untouched sections
    const payload = vars.data.payload as BrandKitPayload;
    expect(payload.identity.brand_name).toBe("Updated Brand");
    expect(payload.colors).toEqual(FULL_PAYLOAD.colors);
    expect(payload.typography).toEqual(FULL_PAYLOAD.typography);
    expect(payload.logos).toEqual(FULL_PAYLOAD.logos);
  });

  it("does not call mutate when save button is disabled (form is clean)", async () => {
    renderScreen();
    // Click Save without editing anything — it is disabled, so click is no-op
    fireEvent.click(screen.getByText("Save brand kit"));
    expect(mutateSpy).not.toHaveBeenCalled();
  });
});

describe("BrandKitScreen — post-save cache invalidation", () => {
  it("invalidates both list and detail query caches on success", async () => {
    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    renderScreen(qc);

    const nameInput = screen.getByTestId("input-brand-name");
    fireEvent.change(nameInput, { target: { value: "Saved Brand" } });

    await waitFor(() => {
      const saveBtn = screen.getByText("Save brand kit") as HTMLButtonElement;
      expect(saveBtn.disabled).toBe(false);
    });

    fireEvent.click(screen.getByText("Save brand kit"));
    await waitFor(() => expect(mutateSpy).toHaveBeenCalledTimes(1));

    // Simulate the mutation succeeding
    act(() => {
      lastMutateCallbacks.onSuccess?.({});
    });

    await waitFor(() => {
      // Should invalidate the list query
      expect(
        invalidateSpy.mock.calls.some((call) => {
          const opts = call[0] as { queryKey?: unknown[] };
          return JSON.stringify(opts?.queryKey) === JSON.stringify(["list-brand-kits"]);
        }),
      ).toBe(true);
      // Should invalidate the detail query for the selected kit
      expect(
        invalidateSpy.mock.calls.some((call) => {
          const opts = call[0] as { queryKey?: unknown[] };
          return JSON.stringify(opts?.queryKey) === JSON.stringify(["get-brand-kit", 1]);
        }),
      ).toBe(true);
    });
  });

  it("shows a success notice after saving", async () => {
    renderScreen();

    const nameInput = screen.getByTestId("input-brand-name");
    fireEvent.change(nameInput, { target: { value: "Saved" } });
    await waitFor(() => expect((screen.getByText("Save brand kit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText("Save brand kit"));
    await waitFor(() => expect(mutateSpy).toHaveBeenCalledTimes(1));

    act(() => {
      lastMutateCallbacks.onSuccess?.({});
    });

    await waitFor(() => {
      expect(screen.getByTestId("text-brand-kit-notice").textContent).toMatch(/saved/i);
    });
  });
});

describe("BrandKitScreen — save error notice", () => {
  it("shows an error notice when the mutation fails", async () => {
    renderScreen();

    const nameInput = screen.getByTestId("input-brand-name");
    fireEvent.change(nameInput, { target: { value: "Oops" } });
    await waitFor(() => expect((screen.getByText("Save brand kit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText("Save brand kit"));
    await waitFor(() => expect(mutateSpy).toHaveBeenCalledTimes(1));

    act(() => {
      lastMutateCallbacks.onError?.(new Error("Server 500"));
    });

    await waitFor(() => {
      const notice = screen.getByTestId("text-brand-kit-notice");
      expect(notice.textContent).toMatch(/could not save/i);
    });
  });
});

describe("BrandKitScreen — studio kit selector integration", () => {
  it("the saved kit id (kit.id=1) is what gets written to createVersion.mutate's id field", async () => {
    // Confirms the kit the user edits is exactly what the studio's brand-kit
    // selector will reference when brandKitId is set (same numeric id).
    renderScreen();

    fireEvent.change(screen.getByTestId("input-brand-name"), {
      target: { value: "Studio Kit" },
    });
    await waitFor(() =>
      expect((screen.getByText("Save brand kit") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByText("Save brand kit"));
    await waitFor(() => expect(mutateSpy).toHaveBeenCalled());

    const [vars] = mutateSpy.mock.calls[0] as [{ id: number }];
    // The kit id must match the one the studio would pass as brandKitId.
    expect(vars.id).toBe(KIT_LIST_ITEM.id);
  });
});
