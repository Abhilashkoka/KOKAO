import { boundedProviderFetch } from "../aiProviderFetch";

/** Input to a transcription provider. */
export interface TranscribeInput {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  /**
   * Ask the provider for per-segment timestamps as well as text.
   *
   * Off by default: the original caller is a voice-note dictation button that
   * only wants a string, and verbose responses cost latency and payload for
   * nothing. The localization pipeline turns it on, because a dub needs to
   * know where each line sits before it can be re-timed.
   */
  timestamps?: boolean;
}

/** A timed span of speech. Milliseconds from the start of the audio. */
export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

/** Result returned by every provider. */
export interface TranscriptionResult {
  text: string;
  provider: string;
  model: string;
  /**
   * Present only when `timestamps` was requested and the provider returned
   * usable spans. Granularity differs by provider — Whisper returns
   * sentence-ish segments, Deepgram returns utterances — so treat these as a
   * starting spine to be reviewed, not as frame-accurate truth.
   */
  segments?: TranscriptSegment[];
}

/** Thrown when the selected provider is missing its API key. */
export class AsrNotConfiguredError extends Error {
  constructor(providerLabel: string, envKey: string) {
    super(
      `${providerLabel} is not configured: set the ${envKey} secret or pick a different speech-to-text provider.`,
    );
    this.name = "AsrNotConfiguredError";
  }
}

/** Thrown when the provider call fails (bad audio, upstream error, timeout). */
export class AsrProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AsrProviderError";
  }
}

/** Per-request timeout for ASR provider calls. Transcription of short voice
 * notes is fast (Groq/Deepgram return in ~1-3s), but polling providers
 * (AssemblyAI) need headroom. */
export const ASR_FETCH_TIMEOUT_MS = 30_000;

/** Bounded-timeout fetch for ASR provider calls. */
export async function asrFetch(url: string, init: RequestInit): Promise<Response> {
  return boundedProviderFetch(
    url,
    init,
    ASR_FETCH_TIMEOUT_MS,
    () =>
      new AsrProviderError(
        `Transcription request timed out after ${ASR_FETCH_TIMEOUT_MS / 1000}s.`,
      ),
  );
}
