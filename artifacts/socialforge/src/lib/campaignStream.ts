import {
  getStreamCampaignUrl,
  type CampaignRequest,
  type CampaignResult,
} from "@workspace/api-client-react";

/**
 * Client for POST /ai/generate-campaign/stream (SSE). Reads the stream
 * manually and surfaces each platform's caption text incrementally via
 * onDelta(platform, textSoFar). Resolves with the final CampaignResult-shaped
 * payload; rejects with an Error carrying `status` so the studio's shared
 * handleError treats 402s the same as the JSON route, and 403/404 can drive
 * the fallback to the JSON endpoint when the switch is off.
 */
export async function streamCampaignRequest(
  data: CampaignRequest,
  onDelta: (platform: string, textSoFar: string) => void,
  signal?: AbortSignal,
): Promise<CampaignResult> {
  const res = await fetch(getStreamCampaignUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(data),
    credentials: "include",
    signal,
  });

  if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
    let message = "Failed to generate campaign.";
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
  const accumulated = new Map<string, string>();
  let final: CampaignResult | null = null;

  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    let event: { type?: string; platform?: string; text?: string; message?: string } & Partial<CampaignResult>;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      return;
    }
    if (
      event.type === "delta" &&
      typeof event.platform === "string" &&
      typeof event.text === "string"
    ) {
      const next = (accumulated.get(event.platform) ?? "") + event.text;
      accumulated.set(event.platform, next);
      onDelta(event.platform, next);
    } else if (event.type === "result") {
      final = {
        posts: event.posts ?? [],
        ...(event.campaignId ? { campaignId: event.campaignId } : {}),
        ...(event.title ? { title: event.title } : {}),
        ...(event.spendPaise != null ? { spendPaise: event.spendPaise } : {}),
        ...(event.clarifyingQuestions
          ? { clarifyingQuestions: event.clarifyingQuestions }
          : {}),
      };
    } else if (event.type === "error") {
      throw new Error(event.message || "Failed to generate campaign.");
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

  if (!final) throw new Error("The campaign stream ended unexpectedly. Please try again.");
  return final;
}
