import OpenAI from "openai";

/**
 * OpenAI-compatible chat client backed by Replicate's native predictions API.
 *
 * Replicate has no /chat/completions endpoint (verified live), so this module
 * gives the rest of the codebase an ordinary `OpenAI` client whose transport
 * translates chat-completions requests into
 * POST https://api.replicate.com/v1/models/{owner}/{name}/predictions and
 * translates the prediction back into an OpenAI-shaped response — including
 * SSE streaming (prediction stream URL → chat.completion.chunk events) and
 * usage from prediction metrics (token_input_count / token_output_count).
 *
 * Supported request features (all the app uses):
 *   messages, stream, stream_options.include_usage, max_tokens,
 *   response_format json_object (emulated via a system instruction).
 * Everything else is intentionally dropped — Replicate models reject unknown
 * inputs with 422, so only universally supported fields are forwarded.
 */

const REPLICATE_API = "https://api.replicate.com/v1";
/** Overall budget for one completion (create + polling). */
const COMPLETION_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

interface ChatMessage {
  role: string;
  content: unknown;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
      .join("");
  }
  return "";
}

/**
 * Collapse OpenAI messages into Replicate's prompt + system_prompt inputs.
 *
 * `supportsSystemPrompt: false` folds the system text into the prompt itself.
 * This matters: Replicate silently DROPS input fields a model's schema does
 * not declare (verified live — deepseek-ai/deepseek-v3.1 has no system_prompt
 * input, so every instruction we sent that way was thrown away and the model
 * answered the bare user prompt in free-form markdown).
 */
export function messagesToReplicateInput(
  messages: ChatMessage[],
  jsonMode: boolean,
  supportsSystemPrompt = true,
): { prompt: string; system_prompt?: string } {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => contentToText(m.content));
  if (jsonMode) {
    systemParts.push(
      "Respond with a single valid JSON object only — no markdown fences, no commentary.",
    );
  }
  const rest = messages.filter((m) => m.role !== "system");
  const prompt =
    rest.length === 1
      ? contentToText(rest[0].content)
      : rest.map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${contentToText(m.content)}`).join("\n\n");
  const system = systemParts.filter(Boolean).join("\n\n");
  if (!system) return { prompt };
  if (supportsSystemPrompt) return { prompt, system_prompt: system };
  return { prompt: `${system}\n\n---\n\n${prompt}` };
}

/**
 * Which input fields a Replicate model accepts, from its OpenAPI schema.
 * Cached per model for the process lifetime (schemas change only on new
 * model versions, which require a restart-worthy config change anyway).
 * Returns null when the schema cannot be read — callers must then choose
 * the universally-safe encoding (system folded into prompt).
 */
const inputFieldsCache = new Map<string, { fields: Set<string> | null; expiresAt: number }>();
/** Successful lookups live for the process; failures retry after a minute. */
const SCHEMA_FAILURE_TTL_MS = 60_000;

export async function getModelInputFields(apiKey: string, model: string): Promise<Set<string> | null> {
  const cached = inputFieldsCache.get(model);
  if (cached && (cached.fields !== null || Date.now() < cached.expiresAt)) return cached.fields;
  let fields: Set<string> | null = null;
  try {
    const res = await fetch(`${REPLICATE_API}/models/${model}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const body = (await res.json()) as {
        latest_version?: { openapi_schema?: { components?: { schemas?: { Input?: { properties?: Record<string, unknown> } } } } };
      };
      const props = body.latest_version?.openapi_schema?.components?.schemas?.Input?.properties;
      if (props && typeof props === "object") fields = new Set(Object.keys(props));
    }
  } catch {
    // fields stays null — caller falls back to the safe encoding
  }
  inputFieldsCache.set(model, {
    fields,
    expiresAt: fields === null ? Date.now() + SCHEMA_FAILURE_TTL_MS : Number.POSITIVE_INFINITY,
  });
  return fields;
}

/** Test hook: clear the per-model schema cache. */
export function clearModelInputFieldsCache(): void {
  inputFieldsCache.clear();
}

interface Prediction {
  id: string;
  status: string;
  output?: unknown;
  error?: unknown;
  metrics?: { token_input_count?: number; token_output_count?: number };
  urls?: { get?: string; stream?: string };
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((p) => (typeof p === "string" ? p : "")).join("");
  return "";
}

function usageFrom(prediction: Prediction | null) {
  const m = prediction?.metrics;
  if (!m || (m.token_input_count == null && m.token_output_count == null)) return undefined;
  const prompt_tokens = m.token_input_count ?? 0;
  const completion_tokens = m.token_output_count ?? 0;
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

function openAiError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "replicate_error" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function completionJson(model: string, prediction: Prediction): Response {
  const body = {
    id: `repl-${prediction.id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: outputText(prediction.output) },
        finish_reason: "stop",
      },
    ],
    usage: usageFrom(prediction),
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function chunk(model: string, id: string, delta: object, finish: string | null, usage?: object) {
  return `data: ${JSON.stringify({
    id: `repl-${id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

async function createPrediction(
  apiKey: string,
  model: string,
  input: object,
  stream: boolean,
): Promise<{ status: number; prediction: Prediction | null; detail: string }> {
  const res = await fetch(`${REPLICATE_API}/models/${model}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(stream ? {} : { Prefer: "wait=60" }),
    },
    body: JSON.stringify({ input, ...(stream ? { stream: true } : {}) }),
  });
  const text = await res.text();
  try {
    return { status: res.status, prediction: JSON.parse(text) as Prediction, detail: text };
  } catch {
    return { status: res.status, prediction: null, detail: text };
  }
}

async function pollUntilDone(apiKey: string, prediction: Prediction): Promise<Prediction> {
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
  let current = prediction;
  while (
    (current.status === "starting" || current.status === "processing") &&
    Date.now() < deadline &&
    current.urls?.get
  ) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(current.urls.get, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) break;
    current = (await res.json()) as Prediction;
  }
  return current;
}

/** Translate a Replicate SSE stream into an OpenAI chat-completions SSE stream. */
function streamResponse(apiKey: string, model: string, prediction: Prediction, includeUsage: boolean): Response {
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const res = await fetch(prediction.urls!.stream!, {
          headers: { Accept: "text/event-stream", "Cache-Control": "no-store" },
        });
        if (!res.ok || !res.body) {
          throw new Error(`Replicate stream failed (${res.status})`);
        }
        controller.enqueue(encoder.encode(chunk(model, prediction.id, { role: "assistant" }, null)));
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let done = false;
        while (!done) {
          const { value, done: eof } = await reader.read();
          if (eof) {
            // Connection closed before Replicate's terminal "done" event —
            // the output may be truncated, so fail loudly instead of
            // pretending the completion finished.
            throw new Error("Replicate stream ended before completion");
          }
          buffer += decoder.decode(value, { stream: true });
          // SSE events are separated by a blank line.
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const evt of events) {
            const lines = evt.split("\n");
            const type = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "";
            // Multi-line data fields join with newlines per the SSE spec.
            const data = lines
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).replace(/^ /, ""))
              .join("\n");
            if (type === "output" && data) {
              controller.enqueue(encoder.encode(chunk(model, prediction.id, { content: data }, null)));
            } else if (type === "error") {
              throw new Error(data || "Replicate reported a generation error");
            } else if (type === "done") {
              done = true;
              break;
            }
          }
        }
        let usage: object | undefined;
        if (includeUsage && prediction.urls?.get) {
          try {
            const final = await fetch(prediction.urls.get, {
              headers: { Authorization: `Bearer ${apiKey}` },
            });
            if (final.ok) usage = usageFrom((await final.json()) as Prediction);
          } catch {
            // usage stays undefined — cost capture is best-effort by design
          }
        }
        controller.enqueue(encoder.encode(chunk(model, prediction.id, {}, "stop", usage)));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        controller.error(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
  return new Response(readable, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function handleChatCompletions(apiKey: string, rawBody: string): Promise<Response> {
  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return openAiError(400, "Invalid request body");
  }
  const model = typeof body.model === "string" ? body.model : "";
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(model)) {
    return openAiError(400, `"${model}" is not a Replicate model slug (owner/name)`);
  }
  const jsonMode = body.response_format?.type === "json_object";
  // Only pass system_prompt when the model's schema declares it — Replicate
  // silently discards undeclared inputs, which loses every instruction.
  // Unknown schema (null) also folds system text into the prompt: that
  // encoding works for every model.
  const fields = await getModelInputFields(apiKey, model);
  const supportsSystemPrompt = fields?.has("system_prompt") ?? false;
  const input: Record<string, unknown> = messagesToReplicateInput(
    body.messages ?? [],
    jsonMode,
    supportsSystemPrompt,
  );
  // Optional inputs are only sent when the schema declares them; with an
  // unreadable schema we fail closed (omit) — the model's own default cap
  // beats a possible unsupported-input rejection.
  if (fields?.has("max_tokens")) {
    if (typeof body.max_tokens === "number") input.max_tokens = body.max_tokens;
    if (typeof body.max_completion_tokens === "number") input.max_tokens = body.max_completion_tokens;
  }

  const wantStream = body.stream === true;
  const created = await createPrediction(apiKey, model, input, wantStream);
  if (!created.prediction || created.status >= 400) {
    const detail = created.detail.slice(0, 300);
    // 404 = unknown model, 401/403 = bad key, 422 = unsupported input.
    return openAiError(created.status >= 400 ? created.status : 502, `Replicate error: ${detail}`);
  }

  if (wantStream) {
    if (!created.prediction.urls?.stream) {
      return openAiError(502, "Replicate did not return a stream URL for this model");
    }
    return streamResponse(apiKey, model, created.prediction, Boolean(body.stream_options?.include_usage));
  }

  const finished = await pollUntilDone(apiKey, created.prediction);
  if (finished.status !== "succeeded") {
    return openAiError(
      502,
      `Replicate prediction ${finished.status}: ${String(finished.error ?? "no output").slice(0, 300)}`,
    );
  }
  return completionJson(model, finished);
}

/**
 * An `OpenAI` client whose transport is the Replicate predictions API.
 * Only chat.completions.create is supported (all the text routes need).
 */
export function createReplicateChatClient(apiKey: string): OpenAI {
  const replicateFetch: typeof fetch = async (url, init) => {
    const target = String(url);
    if (target.endsWith("/chat/completions") && init?.method === "POST") {
      return handleChatCompletions(apiKey, String(init.body ?? ""));
    }
    return openAiError(404, `Unsupported endpoint for the Replicate text provider: ${target}`);
  };
  return new OpenAI({
    apiKey: "replicate-shim", // never sent anywhere; auth happens in replicateFetch
    baseURL: "http://replicate-shim.invalid/v1",
    fetch: replicateFetch,
    // Polling long predictions happens inside the transport; give it room.
    timeout: COMPLETION_TIMEOUT_MS + 10_000,
    maxRetries: 0,
  });
}
