import { db, asrSettingsTable } from "@workspace/db";
import { transcribeWithGroq, GROQ_MODEL } from "./providers/groq";
import { transcribeWithOpenAI, OPENAI_ASR_MODEL } from "./providers/openaiWhisper";
import { transcribeWithDeepgram, DEEPGRAM_MODEL } from "./providers/deepgram";
import { transcribeWithAssemblyAI, ASSEMBLYAI_MODEL } from "./providers/assemblyai";
import type { TranscribeInput, TranscriptionResult } from "./types";

export { AsrNotConfiguredError, AsrProviderError } from "./types";
export type { TranscribeInput, TranscriptionResult } from "./types";

export const DEFAULT_ASR_PROVIDER = "groq";

export interface AsrProviderDef {
  id: string;
  label: string;
  model: string;
  /** Secret required to use this provider; null = uses the built-in OpenAI integration. */
  envKey: string | null;
  transcribe: (input: TranscribeInput) => Promise<TranscriptionResult>;
}

/** Catalog of selectable speech-to-text providers. Add new ones here only. */
export const ASR_PROVIDERS: readonly AsrProviderDef[] = [
  {
    id: "groq",
    label: "Groq (Whisper large-v3-turbo)",
    model: GROQ_MODEL,
    envKey: "GROQ_API_KEY",
    transcribe: transcribeWithGroq,
  },
  {
    id: "openai",
    label: "OpenAI (Whisper)",
    model: OPENAI_ASR_MODEL,
    envKey: null,
    transcribe: transcribeWithOpenAI,
  },
  {
    id: "deepgram",
    label: "Deepgram (Nova-2)",
    model: DEEPGRAM_MODEL,
    envKey: "DEEPGRAM_API_KEY",
    transcribe: transcribeWithDeepgram,
  },
  {
    id: "assemblyai",
    label: "AssemblyAI",
    model: ASSEMBLYAI_MODEL,
    envKey: "ASSEMBLYAI_API_KEY",
    transcribe: transcribeWithAssemblyAI,
  },
] as const;

export function getProviderDef(id: string): AsrProviderDef | undefined {
  return ASR_PROVIDERS.find((p) => p.id === id);
}

export function isProviderConfigured(def: AsrProviderDef): boolean {
  return def.envKey === null || Boolean(process.env[def.envKey]);
}

/** The currently selected provider id (falls back to the default when the
 * settings row is missing or names a provider no longer in the catalog). */
export async function getSelectedAsrProviderId(): Promise<string> {
  const row = (await db.select().from(asrSettingsTable).limit(1))[0];
  const id = row?.provider ?? DEFAULT_ASR_PROVIDER;
  return getProviderDef(id) ? id : DEFAULT_ASR_PROVIDER;
}

/** Persist the platform-wide provider selection (superadmin only, id must be
 * validated against the catalog by the caller's route). */
export async function setSelectedAsrProviderId(id: string): Promise<void> {
  await db
    .insert(asrSettingsTable)
    .values({ id: 1, provider: id })
    .onConflictDoUpdate({
      target: asrSettingsTable.id,
      set: { provider: id, updatedAt: new Date() },
    });
}

/** Transcribe a voice note using the currently selected provider. */
export async function transcribeAudio(input: TranscribeInput): Promise<TranscriptionResult> {
  const id = await getSelectedAsrProviderId();
  const def = getProviderDef(id) ?? getProviderDef(DEFAULT_ASR_PROVIDER)!;
  return def.transcribe(input);
}
