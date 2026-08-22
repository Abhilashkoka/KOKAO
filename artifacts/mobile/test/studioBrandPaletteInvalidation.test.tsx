/**
 * Guard: the Studio screen's brand palette strip must update instantly after a
 * Brand Kit save, without requiring the user to restart the app.
 *
 * BrandKitScreen calls
 *   queryClient.invalidateQueries({ queryKey: getListBrandKitsQueryKey() })
 * on a successful save.  StudioScreen derives its SwatchStrip colours from the
 * same list query via kitSwatches().  These tests verify that when both
 * screens share the same QueryClient, a cache update triggered by
 * BrandKitScreen's post-save invalidation causes StudioScreen to immediately
 * re-render with the new swatches.
 *
 * Key design:
 *  - The real getListBrandKitsQueryKey() is imported from the actual module
 *    via vi.importActual, so the query key in the test matches production.
 *  - useListBrandKits is overridden to call the real useQuery with that key,
 *    so the shared QueryClient cache drives re-renders just as it would at
 *    runtime.
 *  - Tests call client.invalidateQueries (what BrandKitScreen does) and then
 *    client.setQueryData (simulating the refetch result) to exercise the full
 *    production invalidation path.
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

// ── api-client-react mock ─────────────────────────────────────────────────
// useListBrandKits is backed by the REAL useQuery with the REAL query key so
// that the shared QueryClient cache – and therefore invalidateQueries – drives
// re-renders exactly as in production.
vi.mock("@workspace/api-client-react", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/api-client-react")>(
      "@workspace/api-client-react",
    );
  const { createApiClientMock } = await import("./apiClientMock");

  return createApiClientMock({
    // Expose the real key function so test bodies can derive the exact key.
    getListBrandKitsQueryKey: actual.getListBrandKitsQueryKey,

    useListBrandKits: () =>
      // enabled:false prevents any real network call; data comes exclusively
      // from what tests seed via queryClient.setQueryData.
      useQuery({
        queryKey: actual.getListBrandKitsQueryKey(),
        queryFn: () => Promise.resolve([] as Awaited<ReturnType<typeof actual.listBrandKits>>),
        enabled: false,
      }),
  });
});

// ── dependency shims ──────────────────────────────────────────────────────
vi.mock("expo-router", () => ({
  router: { push: vi.fn(), back: vi.fn(), replace: vi.fn() },
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@expo/vector-icons", () => ({
  Feather: Object.assign(() => null, { glyphMap: {} }),
}));
vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("@/components/KeyboardAwareScrollViewCompat", async () => {
  const { ScrollView } = await import("react-native");
  return {
    KeyboardAwareScrollViewCompat: ({
      children,
      ...props
    }: {
      children: React.ReactNode;
      [k: string]: unknown;
    }) => <ScrollView {...(props as object)}>{children}</ScrollView>,
  };
});
vi.mock("@/components/VoiceNoteButton", () => ({ VoiceNoteButton: () => null }));
vi.mock("@/components/ContentImage", () => ({ ContentImage: () => null }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn(), trackFeatureUse: vi.fn() }));

// ── imports after mocks ───────────────────────────────────────────────────
import StudioScreen from "../app/(tabs)/studio";
import { getListBrandKitsQueryKey } from "@workspace/api-client-react";

// The key is derived from the real function, matching what production uses.
const LIST_KITS_KEY = getListBrandKitsQueryKey();

// ── fixtures ──────────────────────────────────────────────────────────────

/**
 * Build a minimal BrandKit fixture with the two colour groups kitSwatches()
 * reads from (primary → secondary → neutral), cast loosely so the test
 * doesn't have to satisfy every generated-type field.
 */
function makeKit(
  id: number,
  name: string,
  primaryHex: string,
  secondaryHex: string,
) {
  return {
    id,
    name,
    isDefault: true,
    isArchived: false,
    activeVersion: {
      payload: {
        colors: {
          primary: [{ hex: primaryHex, name: "Primary" }],
          secondary: [{ hex: secondaryHex, name: "Secondary" }],
          neutral: [],
        },
      },
    },
  };
}

const INITIAL_KIT = makeKit(1, "Sunrise Brand", "#ff6600", "#ffcc00");
const UPDATED_KIT = makeKit(1, "Sunrise Brand", "#0066ff", "#00ccff");
const SECOND_KIT = {
  ...makeKit(2, "Ocean Brand", "#0066cc", "#33bbff"),
  isDefault: false,
};

// ── helpers ───────────────────────────────────────────────────────────────

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderStudio(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <StudioScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => cleanup());

// ── tests ─────────────────────────────────────────────────────────────────

describe("Studio palette strip — shared QueryClient cache invalidation", () => {
  it("switches to the selected kit's colours and restores the default palette in Auto mode", async () => {
    const client = makeClient();

    // Seed two kits in the same cache that powers the real list query.
    act(() => {
      client.setQueryData(LIST_KITS_KEY, [INITIAL_KIT, SECOND_KIT]);
    });

    renderStudio(client);

    // Auto starts with the default kit's palette.
    await waitFor(() => {
      expect(screen.getByText("Generating for Sunrise Brand")).toBeTruthy();
      const palette = screen.getByTestId("active-brand-palette");
      expect(
        palette.querySelectorAll('[style*="background-color: rgb(255, 102, 0)"]').length,
      ).toBeGreaterThan(0);
    });

    // Select the second kit through its real chip. The active palette must
    // replace the default kit's colours.
    fireEvent.click(screen.getByText("Ocean Brand"));

    await waitFor(() => {
      expect(screen.getByText("Generating for Ocean Brand")).toBeTruthy();
      const palette = screen.getByTestId("active-brand-palette");
      const oceanSwatches = palette.querySelectorAll(
        '[style*="background-color: rgb(0, 102, 204)"]',
      );
      expect(oceanSwatches.length).toBeGreaterThan(0);
      expect(
        palette.querySelectorAll('[style*="background-color: rgb(255, 102, 0)"]').length,
      ).toBe(0);
    });

    // Returning to Auto must restore the default palette rather than leaving
    // the previously selected kit's colours behind.
    fireEvent.click(screen.getByText("Auto"));

    await waitFor(() => {
      expect(screen.getByText("Generating for Sunrise Brand")).toBeTruthy();
      const palette = screen.getByTestId("active-brand-palette");
      expect(
        palette.querySelectorAll('[style*="background-color: rgb(255, 102, 0)"]').length,
      ).toBeGreaterThan(0);
      expect(
        palette.querySelectorAll('[style*="background-color: rgb(0, 102, 204)"]').length,
      ).toBe(0);
    });
  });

  it("reflects updated colours after BrandKitScreen's post-save cache bust", async () => {
    const client = makeClient();

    // Seed initial colours.
    act(() => {
      client.setQueryData(LIST_KITS_KEY, [INITIAL_KIT]);
    });

    renderStudio(client);

    fireEvent.click(screen.getByText("Sunrise Brand (default)"));

    // Confirm the initial palette row is visible.
    await waitFor(() => {
      expect(screen.getByText("Generating for Sunrise Brand")).toBeTruthy();
    });

    // Confirm the original primary colour is present in the rendered output.
    // SwatchStrip renders a View per hex; in react-native-web these become
    // divs with an inline backgroundColor style.
    const initialSwatches = document.querySelectorAll(
      '[style*="background-color: rgb(255, 102, 0)"]',
    );
    expect(initialSwatches.length).toBeGreaterThan(0);

    // ── simulate BrandKitScreen's post-save invalidation ──────────────────
    // The real code calls:
    //   queryClient.invalidateQueries({ queryKey: getListBrandKitsQueryKey() })
    // which marks the cache stale and triggers a background refetch.  We
    // exercise that exact call here, then supply the refetch result via
    // setQueryData – the same pair of operations React Query performs
    // internally when the refetch resolves.
    act(() => {
      client.invalidateQueries({ queryKey: LIST_KITS_KEY });
      // Supply the refetch result immediately (no network in tests).
      client.setQueryData(LIST_KITS_KEY, [UPDATED_KIT]);
    });

    // The palette strip must update within the same render cycle – no restart
    // or manual refresh required.
    await waitFor(() => {
      const updatedSwatches = document.querySelectorAll(
        '[style*="background-color: rgb(0, 102, 255)"]',
      );
      expect(updatedSwatches.length).toBeGreaterThan(0);
    });

    // The stale colour must no longer appear.
    const staleSwatches = document.querySelectorAll(
      '[style*="background-color: rgb(255, 102, 0)"]',
    );
    expect(staleSwatches.length).toBe(0);
  });

  it("hides the palette row when the updated kit carries no colour payload", async () => {
    const client = makeClient();

    act(() => {
      client.setQueryData(LIST_KITS_KEY, [INITIAL_KIT]);
    });

    renderStudio(client);

    fireEvent.click(screen.getByText("Sunrise Brand (default)"));

    await waitFor(() => {
      expect(screen.getByText("Generating for Sunrise Brand")).toBeTruthy();
    });

    // Simulate a save that removes all colour data.
    const kitWithoutColors = {
      ...INITIAL_KIT,
      activeVersion: { payload: { colors: null } },
    };

    act(() => {
      client.invalidateQueries({ queryKey: LIST_KITS_KEY });
      client.setQueryData(LIST_KITS_KEY, [kitWithoutColors]);
    });

    await waitFor(() => {
      expect(screen.queryByText("Generating for Sunrise Brand")).toBeNull();
    });
  });

  it("keeps the palette row absent when the cache contains no kits", async () => {
    const client = makeClient();

    act(() => {
      client.setQueryData(LIST_KITS_KEY, []);
    });

    renderStudio(client);

    await waitFor(() => {
      expect(screen.queryByText(/Generating for/)).toBeNull();
    });
  });
});
