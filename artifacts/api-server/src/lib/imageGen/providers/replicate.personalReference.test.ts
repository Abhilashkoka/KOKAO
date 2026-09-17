import { describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../types")>()),
  imageGenFetch: fetchMock,
}));

import { generateWithReplicate } from "./replicate";

describe("Replicate Nano Banana personal-reference adapter", () => {
  it("passes the canonical bytes only in the selected prediction POST", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "succeeded",
        output: "https://replicate.example/result.png",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(Buffer.from("result"), { status: 200 }));

    await generateWithReplicate({
      prompt: "same adult in a winter coat",
      size: "1024x1536",
      model: "google/nano-banana-pro",
      referenceImage: { buffer: Buffer.from("canonical-image"), mimeType: "image/png" },
    }, "test-token");

    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.input.image_input).toEqual([
      `data:image/png;base64,${Buffer.from("canonical-image").toString("base64")}`,
    ]);
    expect(fetchMock.mock.calls[1]![0]).toBe("https://replicate.example/result.png");
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: "GET" });
  });
});