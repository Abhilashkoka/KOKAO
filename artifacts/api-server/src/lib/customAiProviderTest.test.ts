import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CustomAiProvider } from "@workspace/db";

// Selections come from the real DB in production; pin them here so tests
// never depend on the shared dev DB's current provider selection.
vi.mock("./textGen", () => ({
  getTextGenSelection: vi.fn(async () => ({
    provider: "builtin",
    models: [],
    defaultModel: null,
  })),
}));
vi.mock("./imageGen", () => ({
  getImageGenSelection: vi.fn(async () => ({
    provider: "openai",
    model: null,
    customBaseUrl: null,
  })),
}));

import { testCustomAiProvider } from "./customAiProviderTest";
import { getTextGenSelection } from "./textGen";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function providerRow(overrides: Partial<CustomAiProvider> = {}): CustomAiProvider {
  return {
    id: 42,
    name: "Test Provider",
    baseUrl: "https://api.example.com/v1",
    encryptedApiKey: null,
    textEnabled: false,
    imageEnabled: false,
    videoEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CustomAiProvider;
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("testCustomAiProvider", () => {
  it("passes text when the catalog and chat completion respond", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/models")) return jsonResponse({ data: [{ id: "m-1" }] });
      if (u.endsWith("/chat/completions"))
        return jsonResponse({ choices: [{ message: { content: "OK" } }] });
      throw new Error(`unexpected url ${u}`);
    });
    const results = await testCustomAiProvider(providerRow({ textEnabled: true }));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ useCase: "text", ok: true });
    expect(results[0].message).toContain("m-1");
  });

  it("surfaces the provider's own error message on a failed call", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/models")) return jsonResponse({ data: [{ id: "m-1" }] });
      if (u.endsWith("/chat/completions"))
        return jsonResponse({ error: { message: "Invalid API key provided" } }, 401);
      throw new Error(`unexpected url ${u}`);
    });
    const [result] = await testCustomAiProvider(providerRow({ textEnabled: true }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("HTTP 401");
    expect(result.message).toContain("Invalid API key provided");
  });

  it("uses the configured model when this provider is selected for text", async () => {
    vi.mocked(getTextGenSelection).mockResolvedValueOnce({
      provider: "custom:42",
      models: ["configured-model"],
      defaultModel: "configured-model",
    } as Awaited<ReturnType<typeof getTextGenSelection>>);
    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/chat/completions")) {
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("configured-model");
        return jsonResponse({ choices: [{ message: { content: "OK" } }] });
      }
      throw new Error(`unexpected url ${u}`);
    });
    const [result] = await testCustomAiProvider(providerRow({ textEnabled: true }));
    expect(result.ok).toBe(true);
    // The /models catalog is never consulted when a model is configured.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails text actionably when no model can be resolved", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ data: [] }));
    const [result] = await testCustomAiProvider(providerRow({ textEnabled: true }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Configure a model");
  });

  it("runs image and video checks per enabled use case", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/videos/models")) return jsonResponse({ data: [{ id: "v-1" }] });
      if (u.endsWith("/models")) return jsonResponse({ data: [{ id: "img-1" }] });
      if (u.endsWith("/images/generations"))
        return jsonResponse({ data: [{ url: "https://img.example.com/x.png" }] });
      throw new Error(`unexpected url ${u}`);
    });
    const results = await testCustomAiProvider(
      providerRow({ imageEnabled: true, videoEnabled: true }),
    );
    expect(results.map((r) => r.useCase).sort()).toEqual(["image", "video"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("fails video when the endpoint is not OpenRouter-shaped", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ something: "else" }));
    const [result] = await testCustomAiProvider(providerRow({ videoEnabled: true }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("OpenRouter-shaped");
  });

  it("reports a network failure as a failed result, not a throw", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const [result] = await testCustomAiProvider(providerRow({ textEnabled: true }));
    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });
});
