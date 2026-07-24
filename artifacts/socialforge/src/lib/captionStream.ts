import { getStreamCaptionUrl, type CaptionRequest, type CaptionResult } from "@workspace/api-client-react";

/**
 * Client for POST /ai/generate-caption/stream (SSE). The generated fetch
 * helper buffers the whole response, so this reads the stream manually and
 * surfaces caption text incrementally via onDelta. Resolves with the final
 * CaptionResult-shaped payload; rejects with an Error carrying `status` so
 * the studio's shared handleError treats 402s the same as the JSON route.
 */
export async function streamCaptionRequest(
  data: CaptionRequest,
  onDelta: (textSoFar: string) => void,
  signal?: AbortSignal,
): Promise<CaptionResult> {
  const res = await fetch(getStreamCaptionUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(data),
    credentials: "include",
    signal,
  });

  if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
    let message = "Failed to generate caption.";
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the generic message
    }
    const err = new Error(message) as Error & { status: number };
    err.status = res.status;
    throw err;
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("Streaming is not supported in this browser.");

  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  let final: CaptionResult | null = null;

  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    let event: { type?: string; text?: string; message?: string } & Partial<CaptionResult>;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      return;
    }
    if (event.type === "delta" && typeof event.text === "string") {
      accumulated += event.text;
      onDelta(accumulated);
    } else if (event.type === "result") {
      final = {
        caption: event.caption ?? "",
        hashtags: event.hashtags ?? [],
        ...(event.title ? { title: event.title } : {}),
        ...(event.clarifyingQuestions
          ? { clarifyingQuestions: event.clarifyingQuestions }
          : {}),
      };
    } else if (event.type === "error") {
      throw new Error(event.message || "Failed to generate caption.");
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split("\n")) handleLine(line);
    }
  }

  if (!final) throw new Error("The caption stream ended unexpectedly. Please try again.");
  return final;
}
