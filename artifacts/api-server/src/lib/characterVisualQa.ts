import { openai } from "@workspace/integrations-openai-ai-server";
import { buildTextCostMeta, type CompletionUsageLike } from "./aiCost";
import { logger } from "./logger";
import { recordUsage } from "./usage";
import type { MeterContext } from "./meter";
import type { ImageGenResult, ReferenceImage } from "./imageGen/types";

/**
 * The visual gate is intentionally separate from real-person moderation. It
 * checks only fictional design composition and consistency: one subject,
 * full-body framing, and (where supplied) consistency with the approved
 * fictional design reference.
 */
export type CharacterVisualQaMode = "primary" | "sheet" | "outfit";

export const CHARACTER_VISUAL_QA_MODEL = "gpt-5.6-luna";
export const CHARACTER_VISUAL_QA_TIMEOUT_MS = 30_000;

export interface CharacterVisualQaOptions {
  mode: CharacterVisualQaMode;
  approvedPrimary?: ReferenceImage;
  /** Owning character operation; QA telemetry is unmetered for the customer. */
  meterContext?: MeterContext | null;
  /** Test-only override; production callers use the bounded default. */
  timeoutMs?: number;
}

export interface CharacterVisualQaObservation {
  decision: "accept" | "reject" | "uncertain";
  personCount?: number;
  fullBodyVisible?: boolean;
  panelCount?: number;
  allPanelsSingleSubject?: boolean;
  sameIdentity?: boolean;
  designConsistent?: boolean;
}

export type CharacterVisualQaFailureKind =
  | "invalid"
  | "uncertain"
  | "malformed"
  | "unavailable"
  | "timeout";

export class CharacterVisualQaError extends Error {
  constructor(
    message: string,
    public readonly kind: CharacterVisualQaFailureKind,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CharacterVisualQaError";
  }
}

function imageMimeTypeFromBytes(buffer: Buffer): string {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  // Provider adapters normalize the built-in image path to PNG. Keeping this
  // default also lets a mocked provider exercise the callback without having
  // to manufacture a full image fixture.
  return "image/png";
}

export interface VisionCompletionClient {
  chat: {
    completions: {
      create(
        request: unknown,
        options?: { signal?: AbortSignal; maxRetries?: number },
      ): Promise<unknown>;
    };
  };
}

const QA_SYSTEM_PROMPT =
  "You are a strict machine visual-quality gate for fictional character design assets. " +
  "Assess only visible fictional visual design and composition. Never identify, name, " +
  "verify, or infer a real person, and do not use face recognition. Return one JSON object " +
  "and no markdown, prose, or code fence.";

function imageDataUrl(image: ReferenceImage, label: string): string {
  if (!image.buffer.length) {
    throw new CharacterVisualQaError(`${label} is empty.`, "invalid");
  }
  const mimeType = image.mimeType.toLowerCase().split(";")[0]?.trim();
  if (!mimeType || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
    throw new CharacterVisualQaError(`${label} has an unsupported image type.`, "invalid");
  }
  return `data:${mimeType};base64,${image.buffer.toString("base64")}`;
}

function qaUserPrompt(options: CharacterVisualQaOptions): string {
  if (options.mode === "primary") {
    return (
      "Review the candidate image. It must show exactly one fictional person, never a " +
      "group, duplicate person, reflection, mannequin, extra body, or collage; the one " +
      "person must be standing with the entire body visible head to toe. Do not count " +
      "background objects as people. Return exactly these keys: decision (accept, reject, " +
      "or uncertain), personCount (integer), fullBodyVisible (boolean), and " +
      "designConsistent (boolean). Accept only when personCount is exactly 1 and " +
      "fullBodyVisible is true."
    );
  }
  if (options.mode === "outfit") {
    return (
      "Image 1 is the approved fictional primary design. Image 2 is the candidate outfit " +
      "variant. Review Image 2: it must show exactly one fictional person, full body head " +
      "to toe, with the same fictional visual design as Image 1 (face, hair, body shape, " +
      "and identity cues); only clothing may change. Reject any group, duplicate, extra " +
      "body, reflection, collage, uncertain comparison, or missing full body. Return " +
      "exactly these keys: decision (accept, reject, or uncertain), personCount (integer), " +
      "fullBodyVisible (boolean), and designConsistent (boolean)."
    );
  }
  return (
    "Image 1 is the approved fictional primary design. Image 2 is a five-panel reference " +
    "sheet candidate. Validate the sheet as five views of ONE fictional visual identity: " +
    "exactly five photographic view panels, each panel containing one view of the same " +
    "person/design, with no alternate identities, extra people, duplicated bodies, or " +
    "collage artifacts. Do not sum panel subjects as a naive total person count: a valid " +
    "sheet naturally has five panels while still representing one identity. Compare only " +
    "fictional visual design consistency with Image 1; never identify a real person. Return " +
    "exactly these keys: decision (accept, reject, or uncertain), panelCount (integer), " +
    "allPanelsSingleSubject (boolean), sameIdentity (boolean), and " +
    "designConsistent (boolean). Accept only when panelCount is exactly 5 and all three " +
    "booleans are true."
  );
}

function textFromCompletion(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const choices = (response as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length !== 1) return null;
  const message = (choices[0] as { message?: unknown } | undefined)?.message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(
      (part): part is { type?: unknown; text?: unknown } =>
        Boolean(part) && typeof part === "object",
    )
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
  return text || null;
}

function asStrictBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function firstField(value: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in value) return value[key];
  }
  return undefined;
}

/** Parse the model's contract without accepting prose or partial responses. */
export function parseCharacterVisualQaResponse(
  raw: string,
): CharacterVisualQaObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CharacterVisualQaError("Visual QA returned unparseable JSON.", "malformed", error);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CharacterVisualQaError("Visual QA returned an invalid JSON object.", "malformed");
  }
  const value = parsed as Record<string, unknown>;
  const rawDecision = firstField(value, "decision", "verdict");
  const decision =
    rawDecision === "pass"
      ? "accept"
      : rawDecision === "fail"
        ? "reject"
        : rawDecision;
  if (decision !== "accept" && decision !== "reject" && decision !== "uncertain") {
    throw new CharacterVisualQaError("Visual QA returned no valid decision.", "malformed");
  }
  return {
    decision,
    personCount: asCount(firstField(value, "personCount", "person_count", "subjectCount")),
    fullBodyVisible: asStrictBoolean(
      firstField(value, "fullBodyVisible", "full_body_visible", "fullBody", "full_body"),
    ),
    panelCount: asCount(firstField(value, "panelCount", "panel_count", "viewCount", "view_count")),
    allPanelsSingleSubject: asStrictBoolean(
      firstField(value, "allPanelsSingleSubject", "all_panels_single_subject"),
    ),
    sameIdentity: asStrictBoolean(
      firstField(value, "sameIdentity", "same_identity", "singleIdentity", "single_identity"),
    ),
    designConsistent: asStrictBoolean(
      firstField(value, "designConsistent", "design_consistent", "identityConsistent"),
    ),
  };
}

function assertAccepted(
  observation: CharacterVisualQaObservation,
  mode: CharacterVisualQaMode,
): void {
  if (observation.decision === "uncertain") {
    throw new CharacterVisualQaError("Visual QA was uncertain; the image was not accepted.", "uncertain");
  }
  if (observation.decision !== "accept") {
    throw new CharacterVisualQaError("Visual QA rejected the generated character image.", "invalid");
  }
  if (mode === "sheet") {
    if (
      observation.panelCount !== 5 ||
      observation.allPanelsSingleSubject !== true ||
      observation.sameIdentity !== true ||
      observation.designConsistent !== true
    ) {
      throw new CharacterVisualQaError(
        "Visual QA did not confirm five views of the same fictional identity.",
        "invalid",
      );
    }
    return;
  }
  if (
    observation.personCount !== 1 ||
    observation.fullBodyVisible !== true ||
    observation.designConsistent !== true
  ) {
    throw new CharacterVisualQaError(
      mode === "outfit"
        ? "Visual QA did not confirm one full-body person matching the approved design."
        : "Visual QA did not confirm exactly one full-body person.",
      "invalid",
    );
  }
}

async function createVisionCompletion(
  client: VisionCompletionClient,
  request: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const requestPromise = Promise.resolve().then(() =>
    client.chat.completions.create(request, {
      signal: controller.signal,
      // The QA gate must never add implicit SDK retries after the image provider
      // has already returned. The caller's character operation owns retries.
      maxRetries: 0,
    }),
  );
  // Consume a late SDK rejection after the bounded race has returned. In
  // production the abort signal terminates the request; this also keeps an
  // injectable test client that ignores abort from becoming an unhandled
  // rejection.
  requestPromise.catch(() => undefined);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(
        new CharacterVisualQaError(
          `Visual QA timed out after ${timeoutMs / 1000}s.`,
          "timeout",
        ),
      );
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut) throw error;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Cost telemetry is intentionally outside customer metering. The owner
 * context supplies tenant and idempotency identity, while `buildTextCostMeta`
 * is the existing authoritative/unknown-preserving cost helper.
 */
async function recordVisualQaUsage(
  response: unknown,
  meterContext: MeterContext | null | undefined,
): Promise<void> {
  if (!meterContext) return;
  try {
    const costMeta = await buildTextCostMeta(response as CompletionUsageLike, {
      provider: "openai",
      model: CHARACTER_VISUAL_QA_MODEL,
    });
    // The helper returns {} when cost tracking is disabled. Do not create a
    // misleading zero/unknown event in that mode.
    if (Object.keys(costMeta).length === 0) return;
    await recordUsage(meterContext.tenantId, "image", {
      ...costMeta,
      model: CHARACTER_VISUAL_QA_MODEL,
      funding: "unmetered",
      idempotencyKey: meterContext.operationKey
        ? `${meterContext.operationKey}:character-visual-qa`
        : undefined,
    });
  } catch (error) {
    // Cost telemetry must not turn a legitimate provider response into a
    // quality failure. Unknown/missing usage remains NULL in the telemetry row.
    try {
      logger.warn({ err: error }, "character visual QA cost telemetry failed");
    } catch {
      // Logging itself is best-effort and must not alter the QA verdict.
    }
  }
}

/**
 * Run visual QA against a generated image. No result is returned on failure,
 * and every response/transport failure is fail-closed.
 */
export async function validateCharacterImageOutput(
  image: ReferenceImage,
  optionsOrClient: CharacterVisualQaOptions | VisionCompletionClient,
  clientOrOptions?: VisionCompletionClient | CharacterVisualQaOptions,
): Promise<void> {
  // Keep both test-friendly call forms: (image, options, client) and the
  // original injectable-client form (image, client, options).
  const hasOptions = (value: unknown): value is CharacterVisualQaOptions =>
    Boolean(value && typeof value === "object" && "mode" in value);
  const options = hasOptions(optionsOrClient)
    ? optionsOrClient
    : hasOptions(clientOrOptions)
      ? clientOrOptions
      : { mode: "primary" as const };
  const client = (
    hasOptions(optionsOrClient)
      ? clientOrOptions
      : optionsOrClient
  ) as VisionCompletionClient | undefined;
  const visionClient = client ?? (openai as unknown as VisionCompletionClient);
  const candidateUrl = imageDataUrl(image, "Generated image");
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: qaUserPrompt(options) },
  ];
  if (options.approvedPrimary) {
    content.push({
      type: "image_url",
      image_url: { url: imageDataUrl(options.approvedPrimary, "Approved primary image"), detail: "high" },
    });
  }
  content.push({
    type: "image_url",
    image_url: { url: candidateUrl, detail: "high" },
  });
  let response: unknown;
  try {
    response = await createVisionCompletion(
      visionClient,
      {
        model: CHARACTER_VISUAL_QA_MODEL,
        messages: [
          { role: "system", content: QA_SYSTEM_PROMPT },
          { role: "user", content },
        ],
        max_completion_tokens: 300,
        response_format: { type: "json_object" },
      },
      options.timeoutMs ?? CHARACTER_VISUAL_QA_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof CharacterVisualQaError) throw error;
    throw new CharacterVisualQaError(
      "Visual QA was unavailable; the generated image was not accepted.",
      "unavailable",
      error,
    );
  }
  const raw = textFromCompletion(response);
  if (!raw) {
    throw new CharacterVisualQaError(
      "Visual QA returned no machine-readable response.",
      "malformed",
    );
  }
  await recordVisualQaUsage(response, options.meterContext);
  const observation = parseCharacterVisualQaResponse(raw);
  assertAccepted(observation, options.mode);
}

/** Adapter used by the image generation router's pre-persistence boundary. */
export function characterImageOutputValidator(
  options: CharacterVisualQaOptions,
): (result: ImageGenResult) => Promise<void> {
  return (result) =>
    validateCharacterImageOutput(
      { buffer: result.buffer, mimeType: imageMimeTypeFromBytes(result.buffer) },
      options,
    );
}