import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  asrFetch: vi.fn(),
}));

vi.mock("../types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../types")>()),
  asrFetch: mocks.asrFetch,
}));

import { transcribeWithGroq } from "./groq";

describe("Groq ASR", () => {
  beforeEach(() => {
    mocks.asrFetch.mockReset();
    mocks.asrFetch.mockResolvedValue(
      new Response(JSON.stringify({ text: "తెలుగు మాట", language: "te" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("passes a frozen locale hint without sending expected dialogue", async () => {
    await transcribeWithGroq(
      {
        buffer: Buffer.from("audio"),
        mimeType: "audio/wav",
        filename: "clip.wav",
        detectLanguage: true,
        language: "te",
      },
      "test-key",
    );

    const init = mocks.asrFetch.mock.calls[0]![1] as RequestInit;
    const form = init.body as FormData;
    expect(form.get("language")).toBe("te");
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect([...form.keys()]).toEqual([
      "file",
      "model",
      "language",
      "response_format",
    ]);
  });
});