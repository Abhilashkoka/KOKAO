import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchLibraryMusic, downloadLibraryTrack, MusicLibraryError } from "./musicLibrary";

vi.mock("./webFetch", () => ({
  assertPublicHost: vi.fn(async (host: string) => {
    if (host === "blocked.internal") throw new Error("private host");
  }),
}));

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("searchLibraryMusic", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("maps Openverse results and keeps only https tracks", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({
        results: [
          {
            id: "abc",
            title: "Sunny Drive",
            creator: "Jane",
            license: "by",
            license_url: "https://creativecommons.org/licenses/by/4.0/",
            duration: 154_000,
            url: "https://cdn.example.com/sunny.mp3",
          },
          { id: "bad", title: "Insecure", license: "by", url: "http://cdn.example.com/x.mp3" },
          { id: "noise", url: 42 },
        ],
      }),
    );
    const tracks = await searchLibraryMusic("sunny pop");
    expect(tracks).toEqual([
      {
        id: "abc",
        title: "Sunny Drive",
        creator: "Jane",
        license: "by",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        durationSec: 154,
        audioUrl: "https://cdn.example.com/sunny.mp3",
      },
    ]);
    const searchUrl = String(vi.mocked(globalThis.fetch).mock.calls[0]![0]);
    expect(searchUrl).toContain("license_type=commercial");
    expect(searchUrl).toContain("category=music");
  });

  it("surfaces upstream failures as MusicLibraryError", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({}, 503));
    await expect(searchLibraryMusic("x y")).rejects.toThrow(MusicLibraryError);
  });
});

describe("downloadLibraryTrack", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("rejects non-https URLs without fetching", async () => {
    await expect(downloadLibraryTrack("http://cdn.example.com/a.mp3")).rejects.toThrow(/https/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects blocked/private hosts without fetching", async () => {
    await expect(downloadLibraryTrack("https://blocked.internal/a.mp3")).rejects.toThrow(
      /blocked or private/,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("downloads a valid track", async () => {
    const bytes = Buffer.from("audio-bytes");
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(new Uint8Array(bytes), { status: 200 }),
    );
    const out = await downloadLibraryTrack("https://cdn.example.com/a.mp3");
    expect(out.equals(bytes)).toBe(true);
  });

  it("re-validates every redirect hop", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://blocked.internal/b.mp3" } }),
    );
    await expect(downloadLibraryTrack("https://cdn.example.com/a.mp3")).rejects.toThrow(
      /blocked or private/,
    );
  });

  it("rejects oversized tracks", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(new Uint8Array(Buffer.alloc(10)), {
        status: 200,
        headers: { "content-length": String(50 * 1024 * 1024) },
      }),
    );
    await expect(downloadLibraryTrack("https://cdn.example.com/a.mp3")).rejects.toThrow(
      /too large/,
    );
  });
});
