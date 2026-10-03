import { describe, expect, it, vi } from "vitest";
vi.mock("./platformFetch", async (original) => ({
  ...await original<typeof import("./platformFetch")>(),
  platformFetch: vi.fn(),
}));
import { platformFetch, PlatformTimeoutError } from "./platformFetch";
import { createInstagramContainer } from "./instagramContainer";

describe("Instagram preparation timeout policy", () => {
  it("gives container creation 30s and forwards its response without publishing", async () => {
    vi.mocked(platformFetch).mockReset();
    const response = new Response('{"id":"container"}');
    vi.mocked(platformFetch).mockResolvedValue(response);
    const body = new URLSearchParams({ caption: "test" });
    expect(await createInstagramContainer("https://graph.facebook.com/ig/media", body)).toBe(response);
    expect(platformFetch).toHaveBeenCalledExactlyOnceWith(
      "https://graph.facebook.com/ig/media", { method: "POST", body }, 30_000,
    );
  });
  it("makes a preparation timeout eligible for the bounded existing retry loop", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new PlatformTimeoutError("https://graph.facebook.com", 30_000));
    const error = await createInstagramContainer("https://graph.facebook.com/ig/media", new URLSearchParams()).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PlatformTimeoutError);
    expect(error.message).toContain("No publish request was sent");
  });
  it("preserves definitive HTTP rejections for the existing auth and status classifier", async () => {
    const response = new Response('{"error":{"code":190}}', { status: 400 });
    vi.mocked(platformFetch).mockResolvedValue(response);
    expect(await createInstagramContainer("https://graph.facebook.com/ig/media", new URLSearchParams())).toBe(response);
  });
});