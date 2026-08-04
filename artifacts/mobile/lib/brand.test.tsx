// @vitest-environment jsdom
/**
 * Mobile brand hook: the persisted (durable) on-device logo must render from
 * the first frame, beating both the 5-minute in-memory query cache and the
 * bundled default KOKAO mark.
 */
import React from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      store.delete(k);
    }),
  },
}));

const queryState: {
  data: Record<string, unknown> | undefined;
  isLoading: boolean;
  isError: boolean;
} = { data: undefined, isLoading: true, isError: false };

vi.mock("@workspace/api-client-react", () => ({
  useGetAppBrand: () => ({ ...queryState }),
  getGetAppBrandQueryKey: () => ["app-brand"],
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAppBrand, __resetBrandCacheForTests } from "./brand";

const CACHE_KEY = "kokao-app-brand-cache";

function Probe() {
  const { appName, logoUrl, resolved } = useAppBrand();
  return (
    <div>
      <span data-testid="app-name">{appName}</span>
      <span data-testid="logo-url">{logoUrl ?? ""}</span>
      <span data-testid="resolved">{String(resolved)}</span>
    </div>
  );
}

describe("useAppBrand durable cache", () => {
  beforeEach(() => {
    store.clear();
    __resetBrandCacheForTests();
    queryState.data = undefined;
    queryState.isLoading = true;
    queryState.isError = false;
  });

  afterEach(() => cleanup());

  it("prefers the persisted custom logo over the bundled default while the fetch is loading", async () => {
    store.set(
      CACHE_KEY,
      JSON.stringify({
        appName: "Acme",
        logoUrl: "https://cdn.example/logo.png",
        iconUrl: null,
      }),
    );
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId("resolved").textContent).toBe("true");
    });
    expect(screen.getByTestId("logo-url").textContent).toBe(
      "https://cdn.example/logo.png",
    );
    expect(screen.getByTestId("app-name").textContent).toBe("Acme");
  });

  it("stays unresolved (blank, no bundled mark) on a first-ever launch while loading", async () => {
    render(<Probe />);
    // Give the (empty) storage read time to settle.
    await waitFor(() => {
      expect(AsyncStorage.getItem).toHaveBeenCalled();
    });
    expect(screen.getByTestId("resolved").textContent).toBe("false");
    expect(screen.getByTestId("logo-url").textContent).toBe("");
  });

  it("persists the server-reported brand so the next launch shows the new logo", async () => {
    store.set(
      CACHE_KEY,
      JSON.stringify({ appName: "Acme", logoUrl: "https://cdn.example/old.png", iconUrl: null }),
    );
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId("resolved").textContent).toBe("true");
    });

    queryState.data = {
      appName: "Acme",
      logoUrl: "https://cdn.example/new.png",
      iconUrl: null,
    };
    queryState.isLoading = false;
    cleanup();
    render(<Probe />);

    await waitFor(() => {
      expect(screen.getByTestId("logo-url").textContent).toBe(
        "https://cdn.example/new.png",
      );
      const persisted = JSON.parse(store.get(CACHE_KEY) ?? "{}");
      expect(persisted.logoUrl).toBe("https://cdn.example/new.png");
    });
  });

  it("falls back to defaults (resolved) when the fetch fails with nothing cached", async () => {
    queryState.isError = true;
    queryState.isLoading = false;
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId("resolved").textContent).toBe("true");
    });
    expect(screen.getByTestId("app-name").textContent).toBe("KOKAO");
    expect(screen.getByTestId("logo-url").textContent).toBe("");
  });
});
