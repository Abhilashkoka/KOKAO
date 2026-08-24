import { createHmac } from "node:crypto";
import { db, voiceCloneSettingsTable, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptJson, decryptJson } from "../secretCrypto";
import { platformFetch, PlatformTimeoutError } from "../platformFetch";

/**
 * Voice cloning / brand-voice TTS provider framework.
 *
 * Same shape as the ASR and image-gen provider frameworks: a small catalog of
 * cloud providers, a singleton settings row selecting one, and an encrypted
 * admin-entered API key (app_credentials, provider `voice_clone_<id>`) that
 * wins over the env secret. Clients only ever see whether a key exists and
 * where it came from — never the key itself.
 *
 * The Brand Voice feature (clone creation, previews, and brand-voice
 * narration) is additionally gated by the `brandVoiceClone` kill switch; the
 * gate lives at each execution path, not here.
 */

export const DEFAULT_VOICE_CLONE_PROVIDER = "elevenlabs";

/** Cloning uploads a sample and creating previews speaks a paragraph; both
 * can legitimately take longer than the default platform fetch budget. */
export const VOICE_CLONE_TIMEOUT_MS = 60_000;

export class VoiceCloneError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "VoiceCloneError";
    this.status = status;
  }
}

export class VoiceCloneNotConfiguredError extends VoiceCloneError {
  constructor(message = "Voice cloning is not configured.") {
    super(message);
    this.name = "VoiceCloneNotConfiguredError";
  }
}

/** Whether a brand-voice failure is transient (429/5xx/timeout/network) — the
 * narration path fails over to stock voices on these, and also on
 * NotConfigured; a permanent 4xx (bad sample, deleted voice) still fails over
 * for narration because a spoken track in ANY voice beats a dead job. */
export function isTransientVoiceCloneError(error: unknown): boolean {
  if (error instanceof PlatformTimeoutError) return true;
  if (error instanceof VoiceCloneError) {
    if (error.status === undefined) return true;
    return (
      error.status === 429 ||
      (error.status >= 500 && error.status <= 599)
    );
  }
  return error instanceof Error;
}

/** Only an authoritative provider rejection proves that no clone was created. */
export function isConfirmedVoiceCloneFailure(error: unknown): boolean {
  if (error instanceof VoiceCloneNotConfiguredError) return true;
  if (!(error instanceof VoiceCloneError) || error.status === undefined) return false;
  return (
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 409, 425, 429].includes(error.status)
  );
}
export interface ClonedVoiceRef {
  provider: string;
  voiceId: string;
}

export interface VoiceSpeechReceipt {
  /** Exact `character-cost` response header, or null when absent/malformed. */
  providerCredits: string | null;
  requestId: string | null;
  traceId: string | null;
}

export interface VoiceSpeechResult {
  audio: Buffer;
  receipt: VoiceSpeechReceipt;
}

export type VoiceSpeechReceiptHandler = (receipt: VoiceSpeechReceipt) => Promise<void>;

export interface VoiceCloneProviderDef {
  id: string;
  label: string;
  /** Env secret used when no admin-entered key is stored. */
  envKey: string;
  /** Create a voice clone from a reference sample; returns the provider's voice id. */
  clone: (args: {
    apiKey: string;
    name: string;
    audio: Buffer;
    mimeType: string;
  }) => Promise<string>;
  /** Speak text in a cloned voice; returns a complete WAV buffer. */
  speak: (args: { apiKey: string; voiceId: string; text: string; modelId?: string }) => Promise<Buffer>;
  /** Receipt-preserving variant for exact provider billing. */
  speakWithReceipt?: (args: {
    apiKey: string;
    voiceId: string;
    text: string;
    modelId?: string;
    onReceipt?: VoiceSpeechReceiptHandler;
  }) => Promise<VoiceSpeechResult>;
  /** Best-effort delete of a cloned voice at the provider. */
  remove: (args: { apiKey: string; voiceId: string }) => Promise<void>;
  /** Find an existing clone by its exact provider-side name. */
  findByExactName?: (args: { apiKey: string; name: string }) => Promise<string | null>;
  /** Cheap authenticated call proving the key works. */
  test: (apiKey: string) => Promise<void>;
}

/* ------------------------------ ElevenLabs ------------------------------ */

const ELEVENLABS_BASE = "https://api.elevenlabs.io";
/** Raw 24kHz 16-bit mono PCM — wrapped in a WAV header below so the bytes
 * parse with the same RIFF reader as every other narration provider. */
const ELEVENLABS_PCM_RATE = 24_000;
const BRAND_VOICE_TTS_OPERATION_PREFIX = "brand-voice-tts-v1";
const ELEVENLABS_HISTORY_MAX_PAGES = 20;
const ELEVENLABS_HISTORY_CLOCK_SKEW_SECONDS = 5;

async function elevenLabsError(res: Response, fallback: string): Promise<VoiceCloneError> {
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    /* body unreadable — status alone will have to do */
  }
  return new VoiceCloneError(`${fallback} (${res.status})${detail ? `: ${detail}` : ""}`, res.status);
}

/** Wrap raw 16-bit mono PCM in a standard 44-byte WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function elevenLabsClone(args: {
  apiKey: string;
  name: string;
  audio: Buffer;
  mimeType: string;
}): Promise<string> {
  const form = new FormData();
  form.append("name", args.name);
  form.append(
    "files",
    new Blob([new Uint8Array(args.audio)], { type: args.mimeType }),
    "sample.audio",
  );
  const res = await platformFetch(
    `${ELEVENLABS_BASE}/v1/voices/add`,
    { method: "POST", headers: { "xi-api-key": args.apiKey }, body: form },
    VOICE_CLONE_TIMEOUT_MS,
  );
  if (!res.ok) throw await elevenLabsError(res, "Voice cloning failed");
  const body = (await res.json()) as { voice_id?: string };
  if (!body.voice_id) {
    throw new VoiceCloneError("The voice provider returned no voice id.");
  }
  return body.voice_id;
}

export function parseElevenLabsCharacterCost(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match || (match[2]?.length ?? 0) > 8) return null;
  return trimmed;
}

async function elevenLabsSpeakWithReceipt(args: {
  apiKey: string;
  voiceId: string;
  text: string;
  modelId?: string;
  onReceipt?: VoiceSpeechReceiptHandler;
}): Promise<VoiceSpeechResult> {
  const res = await platformFetch(
    `${ELEVENLABS_BASE}/v1/text-to-speech/${encodeURIComponent(args.voiceId)}?output_format=pcm_${ELEVENLABS_PCM_RATE}`,
    {
      method: "POST",
      headers: { "xi-api-key": args.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ text: args.text, model_id: args.modelId ?? "eleven_multilingual_v2" }),
    },
    VOICE_CLONE_TIMEOUT_MS,
  );
  if (!res.ok) throw await elevenLabsError(res, "Brand-voice speech failed");
  const receipt: VoiceSpeechReceipt = {
    providerCredits: parseElevenLabsCharacterCost(res.headers.get("character-cost")),
    requestId: res.headers.get("request-id"),
    traceId: res.headers.get("x-trace-id"),
  };
  await args.onReceipt?.(receipt);
  const pcm = Buffer.from(await res.arrayBuffer());
  if (pcm.length === 0) {
    throw new VoiceCloneError("The voice provider returned no audio.");
  }
  return { audio: pcmToWav(pcm, ELEVENLABS_PCM_RATE), receipt };
}

async function elevenLabsSpeak(args: {
  apiKey: string;
  voiceId: string;
  text: string;
  modelId?: string;
}): Promise<Buffer> {
  return (await elevenLabsSpeakWithReceipt(args)).audio;
}

function brandVoiceTtsDigest(voiceId: string, model: string, text: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new VoiceCloneError("SESSION_SECRET is required for voice-operation recovery.");
  }
  return createHmac("sha256", secret)
    .update("kokao-brand-voice-tts\0", "utf8")
    .update(voiceId, "utf8")
    .update("\0", "utf8")
    .update(model, "utf8")
    .update("\0", "utf8")
    .update(text, "utf8")
    .digest("hex");
}

/** Privacy-safe fingerprint used to reconcile paid TTS after response loss. */
export function buildBrandVoiceTtsOperationKey(
  voiceId: string,
  model: string,
  text: string,
  scope?: { jobId: number; cueIndex: number },
): string {
  const key = [
    BRAND_VOICE_TTS_OPERATION_PREFIX,
    Buffer.from(voiceId, "utf8").toString("base64url"),
    Buffer.from(model, "utf8").toString("base64url"),
    brandVoiceTtsDigest(voiceId, model, text),
  ].join(":");
  // Provider history contains the voice/model/text fingerprint but not our job
  // id. Keep that recoverable base intact and append the local idempotency
  // scope used by job runners to distinguish repeated cue text.
  return scope ? `${key}:job:${scope.jobId}:cue:${scope.cueIndex}` : key;
}

function parseBrandVoiceTtsOperationKey(
  operationKey: string,
): { voiceId: string; model: string; baseKey: string } | null {
  const [prefix, voiceId, model, digest, ...extra] = operationKey.split(":");
  if (
    prefix !== BRAND_VOICE_TTS_OPERATION_PREFIX ||
    !voiceId ||
    !model ||
    !/^[a-f0-9]{64}$/.test(digest ?? "") ||
    !(
      extra.length === 0 ||
      (extra.length === 4 &&
        extra[0] === "job" &&
        /^\d+$/.test(extra[1] ?? "") &&
        extra[2] === "cue" &&
        /^\d+$/.test(extra[3] ?? ""))
    )
  ) {
    return null;
  }
  try {
    return {
      voiceId: Buffer.from(voiceId, "base64url").toString("utf8"),
      model: Buffer.from(model, "base64url").toString("utf8"),
      baseKey: [prefix, voiceId, model, digest].join(":"),
    };
  } catch {
    return null;
  }
}

export interface BrandVoiceTtsHistoryMatch {
  providerResultId: string;
  requestId: string | null;
  createdAt: Date;
  /** History does not document an authoritative credit receipt. */
  providerCredits: null;
}

/**
 * Search ElevenLabs' authoritative TTS history for exact fingerprint matches.
 * Text is hashed only in memory and never persisted or logged.
 */
export async function findBrandVoiceTtsHistoryMatches(
  provider: string,
  operationKey: string,
  operationCreatedAt: Date,
): Promise<BrandVoiceTtsHistoryMatch[]> {
  if (provider !== "elevenlabs") {
    throw new VoiceCloneError(`Provider ${provider} cannot reconcile voice speech.`);
  }
  const parsed = parseBrandVoiceTtsOperationKey(operationKey);
  if (!parsed) throw new VoiceCloneError("Invalid Brand Voice TTS recovery key.");
  const { def, apiKey } = await requireVoiceCloneProviderById(provider);
  const matches: BrandVoiceTtsHistoryMatch[] = [];
  let startAfter: string | null = null;
  const earliestUnix =
    Math.floor(operationCreatedAt.getTime() / 1000) - ELEVENLABS_HISTORY_CLOCK_SKEW_SECONDS;
  const latestExclusiveUnix =
    Math.ceil((operationCreatedAt.getTime() + VOICE_CLONE_TIMEOUT_MS) / 1000) +
    ELEVENLABS_HISTORY_CLOCK_SKEW_SECONDS;
  for (let page = 0; page < ELEVENLABS_HISTORY_MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      page_size: "1000",
      voice_id: parsed.voiceId,
      model_id: parsed.model,
      date_after_unix: String(Math.max(0, earliestUnix)),
      date_before_unix: String(latestExclusiveUnix),
      sort_direction: "asc",
      source: "TTS",
    });
    if (startAfter) query.set("start_after_history_item_id", startAfter);
    const res = await platformFetch(`${ELEVENLABS_BASE}/v1/history?${query}`, {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) throw await elevenLabsError(res, "Voice history lookup failed");
    const body = (await res.json()) as {
      history?: Array<{
        history_item_id?: string;
        request_id?: string | null;
        date_unix?: number;
        voice_id?: string | null;
        model_id?: string | null;
        text?: string | null;
        source?: string | null;
      }>;
      has_more?: boolean;
      last_history_item_id?: string | null;
    };
    for (const item of body.history ?? []) {
      if (
        item.history_item_id &&
        item.voice_id === parsed.voiceId &&
        item.model_id === parsed.model &&
        item.source === "TTS" &&
        typeof item.text === "string" &&
        typeof item.date_unix === "number" &&
        item.date_unix >= earliestUnix &&
        item.date_unix < latestExclusiveUnix &&
        buildBrandVoiceTtsOperationKey(parsed.voiceId, parsed.model, item.text) === parsed.baseKey
      ) {
        matches.push({
          providerResultId: item.history_item_id,
          requestId: item.request_id ?? null,
          createdAt: new Date(item.date_unix * 1000),
          providerCredits: null,
        });
      }
    }
    if (!body.has_more) return matches;
    if (!body.last_history_item_id || body.last_history_item_id === startAfter) {
      throw new VoiceCloneError("Voice history pagination could not be completed.");
    }
    startAfter = body.last_history_item_id;
  }
  throw new VoiceCloneError("Voice history window was too large to reconcile safely.");
}

async function elevenLabsRemove(args: { apiKey: string; voiceId: string }): Promise<void> {
  const res = await platformFetch(
    `${ELEVENLABS_BASE}/v1/voices/${encodeURIComponent(args.voiceId)}`,
    { method: "DELETE", headers: { "xi-api-key": args.apiKey } },
    VOICE_CLONE_TIMEOUT_MS,
  );
  // 404 = already gone; that is the outcome the caller wanted.
  if (!res.ok && res.status !== 404) {
    throw await elevenLabsError(res, "Removing the cloned voice failed");
  }
}

const ELEVENLABS_VOICE_LOOKUP_MAX_PAGES = 5;
async function elevenLabsTest(apiKey: string): Promise<void> {
  const res = await platformFetch(`${ELEVENLABS_BASE}/v1/user`, {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) throw await elevenLabsError(res, "The API key was rejected");
}

/* ------------------------------ ElevenLabs Dubbing API ------------------------------ */

/**
 * Timeout for the dubbing API — creating + polling a dub can take longer than
 * a single TTS call, so use a generous bound. The caller supplies an
 * AbortSignal via the options when it needs a tighter overall budget.
 */
const ELEVENLABS_DUB_TIMEOUT_MS = 180_000;
const ELEVENLABS_DUB_POLL_INTERVAL_MS = 3_000;

export class ElevenLabsDubbingError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ElevenLabsDubbingError";
    this.status = status;
  }
}

/**
 * Dub a source video through the ElevenLabs Dubbing API, returning the
 * provider-generated media. Source-voice rendering uses this as a clean
 * reference sample for a temporary ElevenLabs voice, then speaks the approved
 * localized cues through that voice. This keeps the final spoken words,
 * timing repair, subtitles, and immutable cue snapshot on the same text.
 *
 * API reference:
 *   POST /v1/dubbing          — create dub (multipart/form-data)
 *   GET  /v1/dubbing/{id}     — poll status
 *   GET  /v1/dubbing/{id}/audio/{language_code} — download dubbed audio
 *
 * Secrets are kept in the Authorization header (xi-api-key), never in the
 * body or query string.
 *
 * @param args.apiKey     ElevenLabs API key.
 * @param args.videoBytes Source video as a Buffer.
 * @param args.videoMime  MIME type of the source video (e.g. "video/mp4").
 * @param args.targetLang BCP-47-ish language code (e.g. "hi", "te", "ta").
 * @returns Buffer of the dubbed media bytes. The container follows the source
 *          and is not guaranteed; normalize it before using it as audio.
 */
export async function elevenLabsDubSourceVoice(args: {
  apiKey: string;
  videoBytes: Buffer;
  videoMime: string;
  targetLang: string;
}): Promise<Buffer> {
  // Step 1: Create dubbing job.
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(args.videoBytes)], { type: args.videoMime }),
    "source-video",
  );
  form.append("target_lang", args.targetLang);
  // The source-voice flow is intentionally single-speaker. Dropping the
  // background gives the temporary clone a clean provider-generated sample.
  form.append("num_speakers", "1");
  form.append("drop_background_audio", "true");
  form.append("mode", "automatic");

  const createRes = await platformFetch(
    `${ELEVENLABS_BASE}/v1/dubbing`,
    { method: "POST", headers: { "xi-api-key": args.apiKey }, body: form },
    ELEVENLABS_DUB_TIMEOUT_MS,
  );
  if (!createRes.ok) {
    throw new ElevenLabsDubbingError(
      `ElevenLabs dubbing create failed (${createRes.status})`,
      createRes.status,
    );
  }
  const createBody = (await createRes.json()) as { dubbing_id?: string };
  const dubbingId = createBody.dubbing_id;
  if (!dubbingId) {
    throw new ElevenLabsDubbingError("ElevenLabs dubbing returned no dubbing_id.");
  }

  // Step 2: Poll until done (dubbed / failed).
  const deadline = Date.now() + ELEVENLABS_DUB_TIMEOUT_MS;
  let status = "pending";
  while (status !== "dubbed" && status !== "failed" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, ELEVENLABS_DUB_POLL_INTERVAL_MS));
    const pollRes = await platformFetch(
      `${ELEVENLABS_BASE}/v1/dubbing/${encodeURIComponent(dubbingId)}`,
      { method: "GET", headers: { "xi-api-key": args.apiKey } },
      ELEVENLABS_DUB_TIMEOUT_MS,
    );
    if (!pollRes.ok) {
      // Transient poll failure — keep waiting unless we're past the deadline.
      continue;
    }
    const pollBody = (await pollRes.json()) as { status?: string; error?: string };
    status = pollBody.status ?? "pending";
    if (status === "failed") {
      throw new ElevenLabsDubbingError(
        `ElevenLabs dubbing failed: ${pollBody.error ?? "unknown error"}`,
      );
    }
  }

  if (status !== "dubbed") {
    throw new ElevenLabsDubbingError(
      `ElevenLabs dubbing timed out after ${ELEVENLABS_DUB_TIMEOUT_MS / 1000}s.`,
    );
  }

  // Step 3: Download the dubbed audio.
  const audioRes = await platformFetch(
    `${ELEVENLABS_BASE}/v1/dubbing/${encodeURIComponent(dubbingId)}/audio/${encodeURIComponent(args.targetLang)}`,
    { method: "GET", headers: { "xi-api-key": args.apiKey } },
    ELEVENLABS_DUB_TIMEOUT_MS,
  );
  if (!audioRes.ok) {
    throw new ElevenLabsDubbingError(
      `ElevenLabs dubbing audio download failed (${audioRes.status})`,
      audioRes.status,
    );
  }
  const audioBytes = Buffer.from(await audioRes.arrayBuffer());
  if (audioBytes.length === 0) {
    throw new ElevenLabsDubbingError("ElevenLabs dubbing returned empty audio.");
  }
  return audioBytes;
}

/** Catalog of selectable voice-cloning providers. Add new ones here only. */
export const VOICE_CLONE_PROVIDERS: readonly VoiceCloneProviderDef[] = [
  {
    id: "elevenlabs",
    label: "ElevenLabs (instant voice clone)",
    envKey: "ELEVENLABS_API_KEY",
    clone: elevenLabsClone,
    speak: elevenLabsSpeak,
    speakWithReceipt: elevenLabsSpeakWithReceipt,
    remove: elevenLabsRemove,
    findByExactName: elevenLabsFindByExactName,
    test: elevenLabsTest,
  },
] as const;

export function getVoiceCloneProviderDef(id: string): VoiceCloneProviderDef | undefined {
  return VOICE_CLONE_PROVIDERS.find((p) => p.id === id);
}

/* ---------------------------- keys & selection --------------------------- */

function voiceCloneCredentialProvider(providerId: string): string {
  return `voice_clone_${providerId}`;
}

interface StoredVoiceCloneKey {
  apiKey: string;
}

/** The API key saved by a superadmin (encrypted at rest), or null. */
export async function getStoredVoiceCloneKey(providerId: string): Promise<string | null> {
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, voiceCloneCredentialProvider(providerId)))
      .limit(1)
  )[0];
  if (!row) return null;
  try {
    const creds = decryptJson<StoredVoiceCloneKey>(row.encryptedCredentials);
    return creds.apiKey || null;
  } catch {
    return null;
  }
}

export async function setStoredVoiceCloneKey(providerId: string, apiKey: string): Promise<void> {
  const encrypted = encryptJson({ apiKey } satisfies StoredVoiceCloneKey);
  await db
    .insert(appCredentialsTable)
    .values({
      provider: voiceCloneCredentialProvider(providerId),
      encryptedCredentials: encrypted,
    })
    .onConflictDoUpdate({
      target: appCredentialsTable.provider,
      set: { encryptedCredentials: encrypted, updatedAt: new Date() },
    });
}

export async function clearStoredVoiceCloneKey(providerId: string): Promise<void> {
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, voiceCloneCredentialProvider(providerId)));
}

export type VoiceCloneKeySource = "database" | "env" | null;

/** Where the effective key comes from: admin-entered DB key wins, env is fallback. */
export async function getVoiceCloneKeySource(
  def: VoiceCloneProviderDef,
): Promise<VoiceCloneKeySource> {
  if (await getStoredVoiceCloneKey(def.id)) return "database";
  if (process.env[def.envKey]) return "env";
  return null;
}

export async function resolveVoiceCloneApiKey(
  def: VoiceCloneProviderDef,
): Promise<string | null> {
  const stored = await getStoredVoiceCloneKey(def.id);
  if (stored) return stored;
  return process.env[def.envKey] ?? null;
}

export async function isVoiceCloneProviderConfigured(
  def: VoiceCloneProviderDef,
): Promise<boolean> {
  return (await resolveVoiceCloneApiKey(def)) !== null;
}

/** The currently selected provider id (default when the row is missing or
 * names a provider no longer in the catalog). */
export async function getSelectedVoiceCloneProviderId(): Promise<string> {
  const row = (await db.select().from(voiceCloneSettingsTable).limit(1))[0];
  const id = row?.provider ?? DEFAULT_VOICE_CLONE_PROVIDER;
  return getVoiceCloneProviderDef(id) ? id : DEFAULT_VOICE_CLONE_PROVIDER;
}

export async function setSelectedVoiceCloneProviderId(id: string): Promise<void> {
  await db
    .insert(voiceCloneSettingsTable)
    .values({ id: 1, provider: id })
    .onConflictDoUpdate({
      target: voiceCloneSettingsTable.id,
      set: { provider: id, updatedAt: new Date() },
    });
}

/* ------------------------------ operations ------------------------------- */

/** The selected provider def + key, or throws NotConfigured. */
export async function requireVoiceCloneProvider(): Promise<{
  def: VoiceCloneProviderDef;
  apiKey: string;
}> {
  const id = await getSelectedVoiceCloneProviderId();
  const def = getVoiceCloneProviderDef(id) ?? getVoiceCloneProviderDef(DEFAULT_VOICE_CLONE_PROVIDER)!;
  const apiKey = await resolveVoiceCloneApiKey(def);
  if (!apiKey) {
    throw new VoiceCloneNotConfiguredError(
      "No voice-cloning provider is configured. Ask an administrator to add an API key.",
    );
  }
  return { def, apiKey };
}

/** Resolve one explicit provider so selection cannot change mid-operation. */
export async function requireVoiceCloneProviderById(
  providerId: string,
): Promise<{ def: VoiceCloneProviderDef; apiKey: string }> {
  const def = getVoiceCloneProviderDef(providerId);
  if (!def) {
    throw new VoiceCloneNotConfiguredError(
      `Voice-cloning provider ${providerId} is not available.`,
    );
  }
  const apiKey = await resolveVoiceCloneApiKey(def);
  if (!apiKey) {
    throw new VoiceCloneNotConfiguredError(
      "No voice-cloning provider is configured. Ask an administrator to add an API key.",
    );
  }
  return { def, apiKey };
}
/** Whether brand-voice synthesis could run right now (selected provider has a key). */
export async function isVoiceCloningConfigured(): Promise<boolean> {
  const id = await getSelectedVoiceCloneProviderId();
  const def = getVoiceCloneProviderDef(id);
  return !!def && (await isVoiceCloneProviderConfigured(def));
}

/** Create a cloned voice from a reference sample. Returns the provider ref. */
export async function cloneBrandVoice(args: {
  name: string;
  audio: Buffer;
  mimeType: string;
  /** Pin wallet-funded work to the provider persisted in its durable intent. */
  provider?: string;
}): Promise<ClonedVoiceRef> {
  const { def, apiKey } = args.provider
    ? await requireVoiceCloneProviderById(args.provider)
    : await requireVoiceCloneProvider();
  const voiceId = await def.clone({ apiKey, name: args.name, audio: args.audio, mimeType: args.mimeType });
  return { provider: def.id, voiceId };
}

/**
 * Locate a clone by its deterministic provider-side name. A null return is an
 * authoritative absence; transport/auth failures deliberately throw so the
 * recovery receipt remains pending for a later attempt.
 */
export async function findClonedVoiceByExactName(
  provider: string,
  name: string,
): Promise<ClonedVoiceRef | null> {
  const def = getVoiceCloneProviderDef(provider);
  if (!def?.findByExactName) {
    throw new VoiceCloneError(`Provider ${provider} cannot reconcile cloned voices.`);
  }
  const apiKey = await resolveVoiceCloneApiKey(def);
  if (!apiKey) {
    throw new VoiceCloneNotConfiguredError(
      "No voice-cloning provider is configured. Ask an administrator to add an API key.",
    );
  }
  const voiceId = await def.findByExactName({ apiKey, name });
  return voiceId ? { provider: def.id, voiceId } : null;
}
/** Speak text in a cloned voice; returns a complete WAV buffer. The voice's
 * provider must be the currently selected one — a clone made at a provider
 * the admin has since switched away from reads as unconfigured. */
export async function speakWithClonedVoice(voice: ClonedVoiceRef, text: string, modelId?: string): Promise<Buffer> {
  const { def, apiKey } = await requireVoiceCloneProvider();
  if (def.id !== voice.provider) {
    throw new VoiceCloneNotConfiguredError(
      "This brand voice was cloned at a different provider than the one currently configured.",
    );
  }
  return def.speak({ apiKey, voiceId: voice.voiceId, text, modelId });
}

/** Speak while retaining the provider's exact billing receipt. */
export async function speakWithClonedVoiceReceipt(
  voice: ClonedVoiceRef,
  text: string,
  onReceipt?: VoiceSpeechReceiptHandler,
  modelId?: string,
): Promise<VoiceSpeechResult> {
  const { def, apiKey } = await requireVoiceCloneProvider();
  if (def.id !== voice.provider) {
    throw new VoiceCloneNotConfiguredError(
      "This brand voice was cloned at a different provider than the one currently configured.",
    );
  }
  if (!def.speakWithReceipt) {
    return {
      audio: await def.speak({ apiKey, voiceId: voice.voiceId, text, modelId }),
      receipt: { providerCredits: null, requestId: null, traceId: null },
    };
  }
  return def.speakWithReceipt({ apiKey, voiceId: voice.voiceId, text, onReceipt, modelId });
}

/** Best-effort delete of a cloned voice at its provider. Never throws. */
export async function deleteClonedVoiceQuietly(voice: ClonedVoiceRef): Promise<void> {
  try {
    const def = getVoiceCloneProviderDef(voice.provider);
    if (!def) return;
    const apiKey = await resolveVoiceCloneApiKey(def);
    if (!apiKey) return;
    await def.remove({ apiKey, voiceId: voice.voiceId });
  } catch {
    // The payload reference is already gone; an orphaned provider voice is
    // a cleanup nicety, not a correctness problem.
  }
}

const ELEVENLABS_VOICE_LOOKUP_PAGE_SIZE = 100;

/** Bounded list scan used only to reconcile an acknowledged-but-unrecorded clone. */
async function elevenLabsFindByExactName(args: {
  apiKey: string;
  name: string;
}): Promise<string | null> {
  let pageToken: string | undefined;
  for (let page = 0; page < ELEVENLABS_VOICE_LOOKUP_MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      page_size: String(ELEVENLABS_VOICE_LOOKUP_PAGE_SIZE),
      search: args.name,
      include_total_count: "false",
    });
    if (pageToken) query.set("next_page_token", pageToken);
    const res = await platformFetch(
      `${ELEVENLABS_BASE}/v2/voices?${query}`,
      { headers: { "xi-api-key": args.apiKey } },
      VOICE_CLONE_TIMEOUT_MS,
    );
    if (!res.ok) throw await elevenLabsError(res, "Listing cloned voices failed");
    const body = (await res.json()) as {
      voices?: Array<{ voice_id?: string; name?: string }>;
      next_page_token?: string | null;
      has_more?: boolean;
    };
    const found = body.voices?.find((voice) => voice.name === args.name && voice.voice_id);
    if (found?.voice_id) return found.voice_id;
    if (!body.has_more) return null;
    pageToken = body.next_page_token ?? undefined;
    if (!pageToken) {
      throw new VoiceCloneError(
        "The voice provider reported more lookup results without a page token.",
      );
    }
  }
  throw new VoiceCloneError(
    "The voice lookup reached its safety page limit before exhausting the provider results.",
  );
}
