import { openai } from "@workspace/integrations-openai-ai-server";
import { createHash } from "node:crypto";
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
// Includes reasoning tokens as well as the small JSON verdict.
export const CHARACTER_VISUAL_QA_MAX_COMPLETION_TOKENS = 4096;
const MAX_VERDICT_LENGTH = 4096;

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
  | "truncated"
  | "refused"
  | "empty"
  | "unavailable"
  | "timeout";

export type CharacterVisualQaFailureCategory = "invalid" | "uncertain" | "unavailable";

export class CharacterVisualQaError extends Error {
  constructor(
    message: string,
    public readonly kind: CharacterVisualQaFailureKind,
    public readonly cause?: unknown,
    public readonly mode?: CharacterVisualQaMode,
    public readonly observation?: CharacterVisualQaObservation,
  ) {
    super(message);
    this.name = "CharacterVisualQaError";
  }
}

export function characterVisualQaFailureCategory(
  kind: CharacterVisualQaFailureKind,
): CharacterVisualQaFailureCategory {
  if (kind === "invalid") return "invalid";
  if (kind === "uncertain") return "uncertain";
  return "unavailable";
}

function failureSubject(mode: CharacterVisualQaMode): string {
  return mode === "sheet" ? "reference sheet" : mode === "outfit" ? "outfit" : "portrait";
}

/**
 * Return bounded, machine-authored customer copy for a QA failure. This is
 * deliberately based only on the QA contract and observed booleans/counts;
 * provider responses and model prose must never cross this boundary.
 */
export function describeCharacterVisualQaFailure(
  error: unknown,
  mode: CharacterVisualQaMode = "primary",
): { category: CharacterVisualQaFailureCategory; reason: string } | null {
  let current: unknown = error;
  let qaError: CharacterVisualQaError | undefined;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof CharacterVisualQaError) {
      qaError = current;
      break;
    }
    if (typeof current !== "object" || !("cause" in current)) break;
    current = (current as { cause?: unknown }).cause;
  }
  if (!qaError) return null;

  const effectiveMode = qaError.mode ?? mode;
  const category = characterVisualQaFailureCategory(qaError.kind);
  if (category === "invalid" && effectiveMode === "sheet") {
    const observation = qaError.observation;
    const failedChecks: string[] = [];
    if (observation?.panelCount !== 5) {
      failedChecks.push(
        observation?.panelCount == null
          ? "panel count must be 5"
          : `panel count was ${observation.panelCount}, expected 5`,
      );
    }
    if (observation?.allPanelsSingleSubject !== true) {
      failedChecks.push("each panel must contain one subject");
    }
    if (observation?.sameIdentity !== true) {
      failedChecks.push("all panels must show the same identity");
    }
    if (observation?.designConsistent !== true) {
      failedChecks.push("the design must match the approved primary");
    }
    const checks = failedChecks.length
      ? failedChecks.join("; ")
      : "the five-panel identity and design checks did not pass";
    return {
      category,
      reason: `Reference sheet visual QA (invalid): ${checks}. No reference sheet was saved.`,
    };
  }
  if (category === "uncertain") {
    return {
      category,
      reason: `${failureSubject(effectiveMode)} visual QA (uncertain): the required visual checks could not be confirmed. No ${failureSubject(effectiveMode)} was saved. Try again later.`,
    };
  }
  if (category === "unavailable") {
    const detail = qaError.kind === "timeout"
      ? "the quality-check service timed out"
      : qaError.kind === "truncated" || qaError.kind === "empty"
        ? "the quality-check service returned an incomplete response"
      : qaError.kind === "refused"
        ? "the quality-check service could not assess this image"
      : qaError.kind === "malformed"
        ? "the quality-check service returned an invalid response"
        : "the quality-check service was unavailable";
    return {
      category,
      reason: `${failureSubject(effectiveMode)} visual QA (unavailable): ${detail}. No ${failureSubject(effectiveMode)} was saved. Try again later.`,
    };
  }
  // Portrait/outfit invalid copy intentionally does not include provider text.
  return {
    category,
    reason:
      effectiveMode === "outfit"
        ? "Generated outfit visual QA (invalid): exactly one full-body subject matching the approved design is required. No outfit was saved."
        : "Generated portrait visual QA (invalid): exactly one full-body subject is required. No portrait was saved.",
  };
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

function textFromCompletion(response: unknown): string {
  const malformed = () => new CharacterVisualQaError("Visual QA returned an invalid completion structure.", "malformed");
  if (!response || typeof response !== "object") throw malformed();
  const choices = (response as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length !== 1) throw malformed();
  const choice = choices[0];
  if (!choice || typeof choice !== "object") throw malformed();
  const message = choice.message;
  if (choice.finish_reason === "length") {
    throw new CharacterVisualQaError("Visual QA exhausted its completion budget.", "truncated");
  }
  if (choice.finish_reason === "content_filter" ||
      (message && typeof message === "object" && message.refusal != null && message.refusal !== "") ||
      (Array.isArray(message?.content) && message.content.some((part: { type?: unknown } | null) => part?.type === "refusal"))) {
    throw new CharacterVisualQaError("Visual QA refused the assessment.", "refused");
  }
  // Missing/unknown finish reasons, tool calls, and multiple parts are not a
  // complete, unambiguous chat verdict. Never salvage a passing fragment.
  if (choice.finish_reason !== "stop" || !message || typeof message !== "object" ||
      message.tool_calls != null || message.function_call != null) throw malformed();
  let content = message.content;
  if (Array.isArray(content)) {
    if (content.length !== 1 || content[0]?.type !== "text" || typeof content[0]?.text !== "string") throw malformed();
    content = content[0].text;
  }
  if (content == null || (typeof content === "string" && !content.trim())) {
    throw new CharacterVisualQaError("Visual QA returned empty output.", "empty");
  }
  if (typeof content !== "string" || content.length > MAX_VERDICT_LENGTH) throw malformed();
  return content;
}

/** Parse the model's contract without accepting prose or partial responses. */
export function parseCharacterVisualQaResponse(
  raw: string,
  mode?: CharacterVisualQaMode,
): CharacterVisualQaObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // SyntaxError messages may contain provider text; do not retain the cause.
    throw new CharacterVisualQaError("Visual QA returned unparseable JSON.", "malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CharacterVisualQaError("Visual QA returned an invalid JSON object.", "malformed");
  }
  const value = parsed as Record<string, unknown>;
  const decision = value.decision;
  if (decision !== "accept" && decision !== "reject" && decision !== "uncertain") {
    throw new CharacterVisualQaError("Visual QA returned no valid decision.", "malformed");
  }
  const sheet = mode === "sheet" || (mode == null && "panelCount" in value);
  const countKey = sheet ? "panelCount" : "personCount";
  const booleanKeys = sheet
    ? ["allPanelsSingleSubject", "sameIdentity", "designConsistent"]
    : ["fullBodyVisible", "designConsistent"];
  const keys = ["decision", countKey, ...booleanKeys];
  // JSON.parse silently accepts duplicate keys. Tokenize strings (including
  // escapes) and count object keys so a later accept cannot override reject.
  const suppliedKeys = [...raw.matchAll(/"(?:\\.|[^"\\])*"\s*(?=:)/g)]
    .map((match) => JSON.parse(match[0].trim()) as string);
  if (raw.length > MAX_VERDICT_LENGTH ||
      suppliedKeys.length !== keys.length || new Set(suppliedKeys).size !== keys.length ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
      !Number.isSafeInteger(value[countKey]) || (value[countKey] as number) < 0 ||
      booleanKeys.some((key) => typeof value[key] !== "boolean")) {
    throw new CharacterVisualQaError("Visual QA returned invalid or ambiguous required fields.", "malformed");
  }
  return value as unknown as CharacterVisualQaObservation;
}

function assertAccepted(
  observation: CharacterVisualQaObservation,
  mode: CharacterVisualQaMode,
): void {
  if (observation.decision === "uncertain") {
    throw new CharacterVisualQaError(
      "Visual QA was uncertain; the image was not accepted.",
      "uncertain",
      undefined,
      mode,
      observation,
    );
  }
  if (observation.decision !== "accept") {
    throw new CharacterVisualQaError(
      "Visual QA rejected the generated character image.",
      "invalid",
      undefined,
      mode,
      observation,
    );
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
        undefined,
        mode,
        observation,
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
      undefined,
      mode,
      observation,
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
  } catch {
    // Cost telemetry must not turn a legitimate provider response into a
    // quality failure. Unknown/missing usage remains NULL in the telemetry row.
    try {
      logger.warn({
        tenantId: meterContext.tenantId,
        operationKeyHash: diagnosticHash(meterContext.operationKey),
      }, "character visual QA cost telemetry failed");
    } catch {
      // Logging itself is best-effort and must not alter the QA verdict.
    }
  }
}

function diagnosticHash(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? createHash("sha256").update(value).digest("hex")
    : undefined;
}

/** Explicit allowlist only: never log SDK errors, messages or response bodies.
 * Hash opaque IDs so even an unexpected provider value cannot leak content.
 * Operators can correlate an operation/request by hashing its known ID.
 */
function recordQaFailure(
  error: CharacterVisualQaError,
  response: unknown,
  options: CharacterVisualQaOptions,
): void {
  try {
    const envelope = response && typeof response === "object"
      ? response as Record<string, unknown> : {};
    const choices = Array.isArray(envelope.choices) ? envelope.choices : [];
    const choice = choices.length === 1 ? choices[0] : undefined;
    const reason: unknown = choice?.finish_reason;
    const content: unknown = choice?.message?.content;
    const contentLength = typeof content === "string" ? content.length
      : Array.isArray(content) ? content.reduce((sum, part) =>
        sum + (typeof part?.text === "string" ? part.text.length : 0), 0) : 0;
    logger.warn({
      event: "character_visual_qa_failed",
      kind: error.kind,
      mode: options.mode,
      model: CHARACTER_VISUAL_QA_MODEL,
      tenantId: options.meterContext?.tenantId,
      operationKeyHash: diagnosticHash(options.meterContext?.operationKey),
      requestIdHash: diagnosticHash(envelope._request_id),
      completionIdHash: diagnosticHash(envelope.id),
      finishReason: typeof reason === "string" &&
        ["stop", "length", "content_filter", "tool_calls", "function_call"].includes(reason)
        ? reason : reason == null ? "missing" : "other",
      choiceCount: Math.min(choices.length, 100),
      contentLength: Math.min(contentLength, 1_000_000),
    }, "character visual QA failed");
  } catch {
    // Diagnostics must not change failure classification or funding release.
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
        max_completion_tokens: CHARACTER_VISUAL_QA_MAX_COMPLETION_TOKENS,
        // Keep the proxy's documented JSON-object contract. Strict json_schema
        // support for this model alias is not documented; validate locally.
        response_format: { type: "json_object" },
      },
      options.timeoutMs ?? CHARACTER_VISUAL_QA_TIMEOUT_MS,
    );
  } catch (error) {
    const qaError = error instanceof CharacterVisualQaError ? error : new CharacterVisualQaError(
      "Visual QA was unavailable; the generated image was not accepted.",
      "unavailable",
      undefined,
      options.mode,
    );
    recordQaFailure(qaError, undefined, options);
    throw qaError;
  }
  // A received response can incur provider cost even with no usable verdict.
  await recordVisualQaUsage(response, options.meterContext);
  try {
    const raw = textFromCompletion(response);
    const observation = parseCharacterVisualQaResponse(raw, options.mode);
    assertAccepted(observation, options.mode);
  } catch (error) {
    const qaError = error instanceof CharacterVisualQaError ? error : new CharacterVisualQaError(
      "Visual QA returned an invalid response.", "malformed", undefined, options.mode,
    );
    recordQaFailure(qaError, response, options);
    throw qaError;
  }
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