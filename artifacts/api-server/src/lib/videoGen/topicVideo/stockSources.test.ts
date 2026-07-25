import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { like } from "drizzle-orm";
import { db, appCredentialsTable } from "@workspace/db";
import { recordProviderFailure, resetProviderHealthForTests } from "../../providerHealth";
import {
  STOCK_SOURCES,
  collectStockCandidates,
  getStockKeySource,
  isStockSourceConfigured,
  searchStockClips,
  stockCandidates,
  stockNotConfiguredError,
} from "./stockSources";

const ENV_KEYS = ["PEXELS_API_KEY", "PIXABAY_API_KEY"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const wikimedia = STOCK_SOURCES.find((s) => s.id === "wikimedia")!;

/** Trip a circuit breaker the way three real consecutive failures would. */
function open(key: string): void {
  for (let i = 0; i < 3; i++) recordProviderFailure(key);
}

function ids(candidates: { def: { id: string } }[]): string[] {
  return candidates.map((c) => c.def.id);
}

beforeEach(async () => {
  resetProviderHealthForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "stock_%"));
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ---------------------------------------------------------------------------
// Which sources a choice may use

describe("stockCandidates", () => {
  it("treats the keyless archive as configured but not as a stock account", async () => {
    expect(await isStockSourceConfigured(wikimedia)).toBe(true);
    expect(await getStockKeySource(wikimedia)).toBe("builtin");
    // Nothing keyed is configured, so "auto" has nothing to offer: the operator
    // should hear "add a Pexels key", not quietly start shipping archive footage.
    expect(await stockCandidates("auto")).toEqual([]);
    expect(stockNotConfiguredError("auto").message).toMatch(/Pexels/);
  });

  it("puts the archive behind the configured library as failover", async () => {
    process.env.PEXELS_API_KEY = "test-pexels-key";
    expect(ids(await stockCandidates("auto"))).toEqual(["pexels", "wikimedia"]);
  });

  it("promotes the archive when every keyed library is failing", async () => {
    process.env.PEXELS_API_KEY = "test-pexels-key";
    process.env.PIXABAY_API_KEY = "test-pixabay-key";
    open("stock:pexels");
    open("stock:pixabay");

    expect(ids(await stockCandidates("auto"))).toEqual(["wikimedia", "pexels", "pixabay"]);
  });

  it("keeps a healthy library ahead of the archive", async () => {
    process.env.PEXELS_API_KEY = "test-pexels-key";
    process.env.PIXABAY_API_KEY = "test-pixabay-key";
    open("stock:pexels");

    expect(ids(await stockCandidates("auto"))).toEqual(["pixabay", "wikimedia", "pexels"]);
  });

  it("honours an explicit archive choice with no keys configured at all", async () => {
    const candidates = await stockCandidates("wikimedia");
    expect(ids(candidates)).toEqual(["wikimedia"]);
    expect(candidates[0]!.apiKey).toBe("");
  });

  it("does not fall back off an explicit library choice", async () => {
    process.env.PEXELS_API_KEY = "test-pexels-key";
    expect(await stockCandidates("pixabay")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Wikimedia Commons search

/** One Commons search hit, formatversion=2 shape. */
function page(licence: string, extra: Record<string, unknown> = {}) {
  return {
    title: "File:Example.webm",
    videoinfo: [
      {
        url: "https://upload.wikimedia.org/example.webm",
        width: 1920,
        height: 1080,
        duration: 12,
        mime: "video/webm",
        thumburl: "https://upload.wikimedia.org/thumb.jpg",
        extmetadata: { License: { value: licence } },
        derivatives: [
          { src: "https://upload.wikimedia.org/example.480p.webm", width: 854, height: 480 },
          { src: "https://upload.wikimedia.org/example.1080p.webm", width: 1920, height: 1080 },
        ],
        ...extra,
      },
    ],
  };
}

function commonsResponse(pages: unknown[]): Response {
  return new Response(JSON.stringify({ query: { pages } }), { status: 200 });
}

describe("searchStockClips on Wikimedia Commons", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts public-domain and CC0 files and picks the rendition that covers the frame", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => commonsResponse([page("cc0"), page("pd-old-70")])),
    );

    const clips = await searchStockClips(wikimedia, "", "monsoon street", "9:16");
    expect(clips).toHaveLength(2);
    // The 480p transcode is below the 720p floor, so the 1080p one wins.
    expect(clips[0]!.url).toBe("https://upload.wikimedia.org/example.1080p.webm");
    expect(clips[0]!.provider).toBe("wikimedia");
    expect(clips[0]!.durationSec).toBe(12);
  });

  it("rejects every licence that would attach a condition to the tenant's video", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        commonsResponse([
          page("cc-by-4.0"),
          page("cc-by-sa-3.0"),
          page("attribution"),
          page("fair use"),
        ]),
      ),
    );

    expect(await searchStockClips(wikimedia, "", "monsoon street", "9:16")).toEqual([]);
  });

  it("accepts an unambiguous human-readable licence when the code is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        commonsResponse([
          {
            ...page("cc0"),
            videoinfo: [
              {
                ...page("cc0").videoinfo[0],
                extmetadata: { LicenseShortName: { value: "Public domain" } },
              },
            ],
          },
          {
            ...page("cc0"),
            videoinfo: [
              {
                ...page("cc0").videoinfo[0],
                extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" } },
              },
            ],
          },
        ]),
      ),
    );

    const clips = await searchStockClips(wikimedia, "", "monsoon street", "9:16");
    expect(clips).toHaveLength(1);
  });

  it("skips a file with no licence metadata at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        commonsResponse([{ ...page("cc0"), videoinfo: [{ ...page("cc0").videoinfo[0], extmetadata: undefined }] }]),
      ),
    );

    expect(await searchStockClips(wikimedia, "", "monsoon street", "9:16")).toEqual([]);
  });

  it("drops clips that are too short or too small to use", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        commonsResponse([
          page("cc0", { duration: 1 }),
          page("cc0", {
            derivatives: [
              { src: "https://upload.wikimedia.org/tiny.webm", width: 640, height: 360 },
            ],
            width: 640,
            height: 360,
          }),
        ]),
      ),
    );

    expect(await searchStockClips(wikimedia, "", "monsoon street", "9:16")).toEqual([]);
  });

  it("retries without the derivatives prop and falls back to the original file", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "unknown_viprop", info: "no derivatives" } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        commonsResponse([{ ...page("cc0"), videoinfo: [{ ...page("cc0").videoinfo[0], derivatives: undefined }] }]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const clips = await searchStockClips(wikimedia, "", "monsoon street", "9:16");
    expect(clips).toHaveLength(1);
    expect(clips[0]!.url).toBe("https://upload.wikimedia.org/example.webm");

    const first = new URL(fetchMock.mock.calls[0]![0] as string).searchParams;
    const second = new URL(fetchMock.mock.calls[1]![0] as string).searchParams;
    expect(first.get("viprop")).toContain("derivatives");
    expect(second.get("viprop")).not.toContain("derivatives");
  });

  it("identifies itself and asks only for videos", async () => {
    const fetchMock = vi.fn(async () => commonsResponse([page("cc0")]));
    vi.stubGlobal("fetch", fetchMock);

    await searchStockClips(wikimedia, "", "monsoon street", "9:16");

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const params = new URL(url).searchParams;
    expect(params.get("gsrsearch")).toBe("filetype:video monsoon street");
    expect(params.get("gsrnamespace")).toBe("6");
    expect((init.headers as Record<string, string>)["User-Agent"]).toMatch(/^KOKAO\//);
  });

  it("surfaces an API-level error the retry could not fix", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "badvalue", info: "bad parameter" } }), {
          status: 200,
        }),
      ),
    );

    await expect(searchStockClips(wikimedia, "", "monsoon street", "9:16")).rejects.toThrow(
      /bad parameter/,
    );
  });

  it("surfaces an HTTP failure with its status so failover can classify it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));

    await expect(searchStockClips(wikimedia, "", "monsoon street", "9:16")).rejects.toMatchObject({
      name: "VideoGenProviderError",
      status: 429,
    });
  });
});

// ---------------------------------------------------------------------------
// Walking the sources

const PEXELS_HIT = {
  videos: [
    {
      duration: 9,
      image: "https://cdn.example/thumb.jpg",
      video_files: [{ link: "https://cdn.example/hd.mp4", width: 1080, height: 1920 }],
    },
  ],
};

describe("collectStockCandidates", () => {
  const pexels = STOCK_SOURCES.find((s) => s.id === "pexels")!;
  const pixabay = STOCK_SOURCES.find((s) => s.id === "pixabay")!;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stops at the first source that has footage", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(PEXELS_HIT), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await collectStockCandidates(
      [
        { def: pexels, apiKey: "k" },
        { def: wikimedia, apiKey: "" },
      ],
      ["sunrise", "coffee"],
      "9:16",
    );

    expect(out.def.id).toBe("pexels");
    expect(out.clips).toHaveLength(1); // both terms returned the same URL
    expect(fetchMock).toHaveBeenCalledTimes(2); // Commons was never asked
  });

  it("falls through to the archive when the library is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("https://api.pexels.com")
          ? new Response("upstream unavailable", { status: 503 })
          : commonsResponse([page("cc0")]),
      ),
    );

    const out = await collectStockCandidates(
      [
        { def: pexels, apiKey: "k" },
        { def: wikimedia, apiKey: "" },
      ],
      ["monsoon street"],
      "9:16",
    );

    expect(out.def.id).toBe("wikimedia");
    expect(out.clips).toHaveLength(1);
  });

  it("falls through when a library simply has nothing for the topic", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("https://api.pexels.com")
          ? new Response(JSON.stringify({ videos: [] }), { status: 200 })
          : commonsResponse([page("cc0")]),
      ),
    );

    const out = await collectStockCandidates(
      [
        { def: pexels, apiKey: "k" },
        { def: wikimedia, apiKey: "" },
      ],
      ["a topic the big libraries have never heard of"],
      "9:16",
    );

    expect(out.def.id).toBe("wikimedia");
    expect(out.clips).toHaveLength(1);
  });

  it("reports the last source tried when nothing anywhere has footage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ videos: [], hits: [] }), { status: 200 })),
    );

    const out = await collectStockCandidates(
      [
        { def: pexels, apiKey: "k" },
        { def: pixabay, apiKey: "k" },
      ],
      ["nothing"],
      "9:16",
    );

    expect(out.clips).toEqual([]);
    expect(out.def.id).toBe("pixabay");
  });

  it("does not substitute anything for an explicit one-source choice", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ hits: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await collectStockCandidates([{ def: pixabay, apiKey: "k" }], ["sunrise"], "9:16");

    expect(out.clips).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("enforces the job deadline before every search", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ videos: [] }), { status: 200 })));
    const onTick = vi.fn(() => {
      throw new Error("deadline exceeded");
    });

    await expect(
      collectStockCandidates([{ def: pexels, apiKey: "k" }], ["sunrise"], "9:16", onTick),
    ).rejects.toThrow("deadline exceeded");
  });
});
