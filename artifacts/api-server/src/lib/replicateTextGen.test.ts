import { describe, it, expect, afterEach, vi } from "vitest";
import { messagesToReplicateInput, createReplicateChatClient } from "./replicateTextGen";

describe("messagesToReplicateInput", () => {
  it("maps a single user message straight to prompt", () => {
    const input = messagesToReplicateInput(
      [{ role: "user", content: "Write a caption" }],
      false,
    );
    expect(input).toEqual({ prompt: "Write a caption" });
  });

  it("moves system messages into system_prompt", () => {
    const input = messagesToReplicateInput(
      [
        { role: "system", content: "You are a social media expert." },
        { role: "user", content: "Write a caption" },
      ],
      false,
    );
    expect(input.system_prompt).toBe("You are a social media expert.");
    expect(input.prompt).toBe("Write a caption");
  });

  it("labels turns when there is a multi-message conversation", () => {
    const input = messagesToReplicateInput(
      [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Caption please" },
      ],
      false,
    );
    expect(input.prompt).toBe("User: Hi\n\nAssistant: Hello\n\nUser: Caption please");
  });

  it("adds a JSON-only instruction in json mode", () => {
    const input = messagesToReplicateInput(
      [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Give JSON" },
      ],
      true,
    );
    expect(input.system_prompt).toContain("Be terse.");
    expect(input.system_prompt).toMatch(/valid JSON object only/);
  });

  it("flattens array content parts", () => {
    const input = messagesToReplicateInput(
      [{ role: "user", content: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }] }],
      false,
    );
    expect(input.prompt).toBe("part one part two");
  });
});

describe("streaming termination", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sse(events: string): Response {
    return new Response(events, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  function stubReplicate(streamBody: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        const target = String(url);
        if (target.includes("/predictions")) {
          return new Response(
            JSON.stringify({
              id: "p1",
              status: "starting",
              urls: { stream: "https://stream.replicate.com/v1/p1", get: "https://api.replicate.com/v1/predictions/p1" },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        return sse(streamBody);
      }),
    );
  }

  async function collect(streamBody: string): Promise<string> {
    stubReplicate(streamBody);
    const client = createReplicateChatClient("k");
    const stream = await client.chat.completions.create({
      model: "owner/model",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    let text = "";
    for await (const chunk of stream) text += chunk.choices?.[0]?.delta?.content ?? "";
    return text;
  }

  it("completes normally when the stream ends with a done event", async () => {
    await expect(
      collect("event: output\ndata: hello\n\nevent: done\ndata: {}\n\n"),
    ).resolves.toBe("hello");
  });

  it("rejects when the connection closes before the done event", async () => {
    await expect(collect("event: output\ndata: partial\n\n")).rejects.toThrow(
      /ended before completion/,
    );
  });

  it("rejects on an explicit error event", async () => {
    await expect(
      collect("event: output\ndata: x\n\nevent: error\ndata: boom\n\n"),
    ).rejects.toThrow(/boom/);
  });
});
