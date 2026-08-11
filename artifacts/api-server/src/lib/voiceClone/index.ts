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

export interface ClonedVoiceRef {
  provider: string;
  voiceId: string;
}

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
  speak: (args: { apiKey: string; voiceId: string; text: string }) => Promise<Buffer>;
  /** Best-effort delete of a cloned voice at the provider. */
  remove: (args: { apiKey: string; voiceId: string }) => Promise<void>;
  /** Cheap authenticated call proving the key works. */
  test: (apiKey: string) => Promise<void>;
}

/* ------------------------------ ElevenLabs ------------------------------ */

const ELEVENLABS_BASE = "https://api.elevenlabs.io";
/** Raw 24kHz 16-bit mono PCM — wrapped in a WAV header below so the bytes
 * parse with the same RIFF reader as every other narration provider. */
const ELEVENLABS_PCM_RATE = 24_000;

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

async function elevenLabsSpeak(args: {
  apiKey: string;
  voiceId: string;
  text: string;
}): Promise<Buffer> {
  const res = await platformFetch(
    `${ELEVENLABS_BASE}/v1/text-to-speech/${encodeURIComponent(args.voiceId)}?output_format=pcm_${ELEVENLABS_PCM_RATE}`,
    {
      method: "POST",
      headers: { "xi-api-key": args.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ text: args.text, model_id: "eleven_multilingual_v2" }),
    },
    VOICE_CLONE_TIMEOUT_MS,
  );
  if (!res.ok) throw await elevenLabsError(res, "Brand-voice speech failed");
  const pcm = Buffer.from(await res.arrayBuffer());
  if (pcm.length === 0) {
    throw new VoiceCloneError("The voice provider returned no audio.");
  }
  return pcmToWav(pcm, ELEVENLABS_PCM_RATE);
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

async function elevenLabsTest(apiKey: string): Promise<void> {
  const res = await platformFetch(`${ELEVENLABS_BASE}/v1/user`, {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) throw await elevenLabsError(res, "The API key was rejected");
}

/** Catalog of selectable voice-cloning providers. Add new ones here only. */
export const VOICE_CLONE_PROVIDERS: readonly VoiceCloneProviderDef[] = [
  {
    id: "elevenlabs",
    label: "ElevenLabs (instant voice clone)",
    envKey: "ELEVENLABS_API_KEY",
    clone: elevenLabsClone,
    speak: elevenLabsSpeak,
    remove: elevenLabsRemove,
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
}): Promise<ClonedVoiceRef> {
  const { def, apiKey } = await requireVoiceCloneProvider();
  const voiceId = await def.clone({ apiKey, name: args.name, audio: args.audio, mimeType: args.mimeType });
  return { provider: def.id, voiceId };
}

/** Speak text in a cloned voice; returns a complete WAV buffer. The voice's
 * provider must be the currently selected one — a clone made at a provider
 * the admin has since switched away from reads as unconfigured. */
export async function speakWithClonedVoice(voice: ClonedVoiceRef, text: string): Promise<Buffer> {
  const { def, apiKey } = await requireVoiceCloneProvider();
  if (def.id !== voice.provider) {
    throw new VoiceCloneNotConfiguredError(
      "This brand voice was cloned at a different provider than the one currently configured.",
    );
  }
  return def.speak({ apiKey, voiceId: voice.voiceId, text });
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
