import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BytePlusAssetsError,
  deleteAssetGroup,
} from "./assets";

const credentials = {
  accessKeyId: "test-access",
  secretAccessKey: "test-secret",
  region: "ap-southeast-1",
  service: "ark" as const,
};
const originalFetch = globalThis.fetch;
const originalTimeout = process.env.ARK_ASSETS_FETCH_TIMEOUT_MS;

beforeEach(() => {
  process.env.ARK_ASSETS_FETCH_TIMEOUT_MS = "25";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalTimeout === undefined) delete process.env.ARK_ASSETS_FETCH_TIMEOUT_MS;
  else process.env.ARK_ASSETS_FETCH_TIMEOUT_MS = originalTimeout;
  vi.restoreAllMocks();
});

describe("BytePlus Asset Library response handling", () => {
  it.each([
    ["UnsupportedAction", "This action is unsupported"],
    ["ResourceNotFound", "The group does not exist"],
  ])("preserves structured non-2xx code %s", async (code, message) => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      ResponseMetadata: { Error: { Code: code, Message: message } },
    }), { status: 400 }));

    const error = await deleteAssetGroup("group-1", credentials).catch((caught) => caught);

    expect(error).toBeInstanceOf(BytePlusAssetsError);
    expect(error).toMatchObject({ status: 400, code });
  });

  it("keeps a generic HTTP 400 distinguishable from explicit unsupported errors", async () => {
    globalThis.fetch = vi.fn(async () => new Response("bad request", { status: 400 }));

    const error = await deleteAssetGroup("group-1", credentials).catch((caught) => caught);

    expect(error).toBeInstanceOf(BytePlusAssetsError);
    expect(error).toMatchObject({ status: 400, code: undefined });
  });

  it("times out when headers arrive but the response body stalls", async () => {
    globalThis.fetch = vi.fn(async (_url, init) => ({
      ok: true,
      status: 200,
      text: () => new Promise<string>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      }),
    } as Response));

    await expect(deleteAssetGroup("group-1", credentials))
      .rejects.toThrow(/timed out/i);
  });
});