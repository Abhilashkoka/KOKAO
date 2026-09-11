import { afterEach, describe, expect, it, vi } from "vitest";

const meterMock = vi.hoisted(() =>
  vi.fn(async <T>(_ctx: unknown, _key: string, _quantity: number, fn: () => Promise<T>) => fn()),
);

vi.mock("../meter", () => ({ meter: meterMock }));

import { generateLipSyncWithReplicate } from "./providers/replicate";
import { LATENT_SYNC } from "./lipSyncModels";

function stubSuccessfulReplicate(): void {
  let upload = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value === "https://api.replicate.com/v1/files") {
        upload += 1;
        return Response.json({ urls: { get: `https://replicate.test/input-${upload}` } });
      }
      if (value === "https://api.replicate.com/v1/predictions") {
        return Response.json({
          id: "paid-lipsync",
          status: "succeeded",
          output: "https://replicate.test/output.mp4",
        });
      }
      if (value === "https://replicate.test/output.mp4") {
        return new Response(Buffer.from("synced"));
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

afterEach(() => {
  meterMock.mockClear();
  vi.unstubAllGlobals();
});

describe("Replicate lip-sync metering boundary", () => {
  it("meters the paid prediction with workspace, model, seconds, and stable operation key", async () => {
    stubSuccessfulReplicate();
    await generateLipSyncWithReplicate(
      {
        source: { buffer: Buffer.from("video"), mimeType: "video/mp4" },
        audio: { buffer: Buffer.from("audio"), mimeType: "audio/wav" },
        def: LATENT_SYNC,
        durationSec: 7.25,
        meterCtx: {
          tenantId: 42,
          refKind: "videoJob",
          refId: "1180",
          operationKey: "videoJob:1180:lip_sync",
        },
      },
      "token",
    );

    expect(meterMock).toHaveBeenCalledOnce();
    expect(meterMock.mock.calls[0]?.slice(0, 3)).toEqual([
      {
        tenantId: 42,
        refKind: "videoJob",
        refId: "1180",
        operationFamilyKey: "videoJob:1180:lip_sync",
        operationKey: "videoJob:1180:lip_sync:submit:0",
        provider: "replicate",
        model: "bytedance/latentsync",
      },
      "lipsync",
      7.25,
    ]);
  });

  it("meters each retried prediction POST as a distinct lip-sync attempt", async () => {
    vi.useFakeTimers();
    let upload = 0;
    let submits = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value === "https://api.replicate.com/v1/files") {
        upload += 1;
        return Response.json({ urls: { get: `https://replicate.test/input-${upload}` } });
      }
      if (value === "https://api.replicate.com/v1/predictions") {
        submits += 1;
        if (submits < 3) return new Response("busy", { status: 503 });
        return Response.json({
          id: "paid-lipsync-retry",
          status: "succeeded",
          output: "https://replicate.test/output.mp4",
        });
      }
      if (value === "https://replicate.test/output.mp4") {
        return new Response(Buffer.from("synced"));
      }
      return new Response("not found", { status: 404 });
    }));
    try {
      const pending = generateLipSyncWithReplicate({
        source: { buffer: Buffer.from("video"), mimeType: "video/mp4" },
        audio: { buffer: Buffer.from("audio"), mimeType: "audio/wav" },
        def: LATENT_SYNC,
        durationSec: 4,
        meterCtx: {
          tenantId: 42,
          refKind: "videoJob",
          refId: "1180",
          operationKey: "videoJob:1180:lip_sync",
        },
      }, "token");
      await vi.advanceTimersByTimeAsync(4_500);
      await pending;
      expect(meterMock.mock.calls.map(
        (call) => (call[0] as { operationKey?: string } | null)?.operationKey,
      )).toEqual([
        "videoJob:1180:lip_sync:submit:0",
        "videoJob:1180:lip_sync:submit:1",
        "videoJob:1180:lip_sync:submit:2",
      ]);
      expect(meterMock.mock.calls.map((call) => call.slice(1, 3))).toEqual([
        ["lipsync", 4], ["lipsync", 4], ["lipsync", 4],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes an explicit null meter context for an unbillable probe", async () => {
    stubSuccessfulReplicate();
    await generateLipSyncWithReplicate(
      {
        source: { buffer: Buffer.from("video"), mimeType: "video/mp4" },
        audio: { buffer: Buffer.from("audio"), mimeType: "audio/wav" },
        def: LATENT_SYNC,
        durationSec: 1,
        meterCtx: null,
      },
      "token",
    );

    expect(meterMock.mock.calls[0]?.slice(0, 3)).toEqual([null, "lipsync", 1]);
  });
});