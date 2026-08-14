import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  messagesToReplicateInput,
  createReplicateChatClient,
  clearModelInputFieldsCache,
} from "./replicateTextGen";

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

  it("folds system text into the prompt when system_prompt is unsupported", () => {
    const input = messagesToReplicateInput(
      [
        { role: "system", content: "You are terse." },
        { role: "user", content: "Write a caption" },
      ],
      false,
      false,
    );
    expect(input.system_prompt).toBeUndefined();
    expect(input.prompt).toBe("You are terse.\n\n---\n\nWrite a caption");
  });

  it("keeps the JSON-only instruction when folding into the prompt", () => {
    const input = messagesToReplicateInput(
      [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Give JSON" },
      ],
      true,
      false,
    );
    expect(input.system_prompt).toBeUndefined();
    expect(input.prompt).toMatch(/valid JSON object only/);
    expect(input.prompt).toContain("Give JSON");
  });

  it("flattens array content parts", () => {
    const input = messagesToReplicateInput(
      [{ role: "user", content: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }] }],
      false,
    );
    expect(input.prompt).toBe("part one part two");
  });
});

describe("schema-aware input construction", () => {
  beforeEach(() => clearModelInputFieldsCache());
  afterEach(() => vi.unstubAllGlobals());

  function schemaBody(fields: string[]) {
    const properties = Object.fromEntries(fields.map((f) => [f, { type: "string" }]));
    return JSON.stringify({
      latest_version: { openapi_schema: { components: { schemas: { Input: { properties } } } } },
    });
  }

  /** Stub Replicate: model schema endpoint + prediction create; capture inputs. */
  function stub(fields: string[] | "unreadable") {
    const captured: { inputs: Record<string, unknown>[]; schemaCalls: number } = { inputs: [], schemaCalls: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const target = String(url);
        if (target.endsWith("/models/owner/model") ) {
          captured.schemaCalls++;
          if (fields === "unreadable") return new Response("nope", { status: 500 });
          return new Response(schemaBody(fields), { status: 200 });
        }
        if (target.includes("/predictions")) {
          captured.inputs.push(JSON.parse(String(init?.body ?? "{}")).input);
          return new Response(
            JSON.stringify({ id: "p1", status: "succeeded", output: '{"ok":true}' }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );
    return captured;
  }

  const messages = [
    { role: "system" as const, content: "Be terse." },
    { role: "user" as const, content: "Give JSON" },
  ];

  it("uses system_prompt and max_tokens when the schema declares them", async () => {
    const cap = stub(["prompt", "system_prompt", "max_tokens"]);
    const client = createReplicateChatClient("k");
    await client.chat.completions.create({ model: "owner/model", messages, max_completion_tokens: 8192 } as any);
    expect(cap.inputs[0]).toEqual({ prompt: "Give JSON", system_prompt: "Be terse.", max_tokens: 8192 });
  });

  it("folds system text into prompt and omits max_tokens when undeclared", async () => {
    const cap = stub(["prompt", "temperature"]);
    const client = createReplicateChatClient("k");
    await client.chat.completions.create({ model: "owner/model", messages, max_completion_tokens: 8192 } as any);
    expect(cap.inputs[0]).toEqual({ prompt: "Be terse.\n\n---\n\nGive JSON" });
  });

  it("fails closed (fold + omit optionals) when the schema is unreadable", async () => {
    const cap = stub("unreadable");
    const client = createReplicateChatClient("k");
    await client.chat.completions.create({ model: "owner/model", messages, max_completion_tokens: 8192 } as any);
    expect(cap.inputs[0]).toEqual({ prompt: "Be terse.\n\n---\n\nGive JSON" });
  });

  it("looks the schema up once per model across requests", async () => {
    const cap = stub(["prompt", "system_prompt"]);
    const client = createReplicateChatClient("k");
    await client.chat.completions.create({ model: "owner/model", messages } as any);
    await client.chat.completions.create({ model: "owner/model", messages } as any);
    expect(cap.schemaCalls).toBe(1);
    expect(cap.inputs).toHaveLength(2);
  });
});

describe("streaming termination", () => {
  beforeEach(() => clearModelInputFieldsCache());
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
