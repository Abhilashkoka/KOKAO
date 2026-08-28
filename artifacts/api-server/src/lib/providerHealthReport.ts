/**
 * Read-only provider health report for the admin dashboard: every known
 * provider key (textgen:*, imagegen:*, videogen:*) with its breaker state and
 * observed stats, plus whether text requests are currently being diverted to
 * the failover provider.
 *
 * Pure read: no network calls, no breaker mutation. Everything comes from the
 * in-memory providerHealth state and the stored selections, so this endpoint
 * is safe to poll.
 */

import { TEXT_GEN_PROVIDERS, getTextGenSelection } from "./textGen";
import { resolveTextGenFailoverCandidate, textGenHealthKey } from "./textGenFailover";
import { IMAGE_GEN_PROVIDERS, getImageGenSelection, imageGenHealthKey } from "./imageGen";
import { VIDEO_GEN_PROVIDERS, getVideoGenSelection, videoGenHealthKey } from "./videoGen";
import { listCustomAiProviders, customProviderRef } from "./customAiProviders";
import { getProviderHealth, getProviderStats } from "./providerHealth";

export type ProviderHealthFamily = "textgen" | "imagegen" | "videogen";

export interface ProviderHealthEntry {
  /** Breaker key, e.g. "textgen:builtin". */
  key: string;
  family: ProviderHealthFamily;
  providerId: string;
  label: string;
  /** Whether this provider is the current admin selection for its family. */
  selected: boolean;
  /** False only while the breaker is open. */
  healthy: boolean;
  /** ISO timestamp the open breaker cools down at, or null when closed. */
  breakerOpenUntil: string | null;
  consecutiveFailures: number;
  lastFailureMessage: string | null;
  /** Recent calls the success rate is based on (0 = never called). */
  samples: number;
  successes: number;
  typicalLatencyMs: number | null;
}

export interface TextFailoverStatus {
  /** The admin-selected text provider. */
  selectedProvider: string;
  /**
   * True when text requests are being diverted RIGHT NOW: the selected
   * provider's breaker is open AND a healthy, priced substitute exists.
   */
  active: boolean;
  /** Where diverted requests go ("builtin"), or null when not diverting. */
  divertedTo: string | null;
}

export interface ProviderHealthReport {
  textFailover: TextFailoverStatus;
  providers: ProviderHealthEntry[];
  generatedAt: string;
}

const BUILTIN_TEXT_LABELS: Record<string, string> = {
  builtin: "Built-in (OpenAI)",
  openrouter: "OpenRouter",
  replicate: "Replicate",
  nvidia: "NVIDIA",
};

function entryFor(
  family: ProviderHealthFamily,
  key: string,
  providerId: string,
  label: string,
  selected: boolean,
): ProviderHealthEntry {
  const stats = getProviderStats(key);
  const breaker = getProviderHealth(key);
  const openUntil = breaker && breaker.openUntil > Date.now() ? breaker.openUntil : 0;
  return {
    key,
    family,
    providerId,
    label,
    selected,
    healthy: stats.healthy,
    breakerOpenUntil: openUntil > 0 ? new Date(openUntil).toISOString() : null,
    consecutiveFailures: breaker?.consecutiveFailures ?? 0,
    lastFailureMessage: breaker?.lastFailureMessage ?? null,
    samples: stats.samples,
    successes: stats.successes,
    typicalLatencyMs: stats.typicalLatencyMs,
  };
}

export async function buildProviderHealthReport(): Promise<ProviderHealthReport> {
  const [textSelection, imageSelection, videoSelection, customRows] = await Promise.all([
    getTextGenSelection(),
    getImageGenSelection(),
    getVideoGenSelection(),
    listCustomAiProviders().catch(() => []),
  ]);

  const providers: ProviderHealthEntry[] = [];

  for (const id of TEXT_GEN_PROVIDERS) {
    if (id === "nvidia") {
      providers.push(
        entryFor(
          "textgen",
          textGenHealthKey(id, "text"),
          id,
          "NVIDIA text",
          textSelection.provider === id,
        ),
        entryFor(
          "textgen",
          textGenHealthKey(id, "multimodal"),
          id,
          "NVIDIA multimodal (image_url)",
          false,
        ),
      );
    } else {
      providers.push(
        entryFor(
          "textgen",
          textGenHealthKey(id),
          id,
          BUILTIN_TEXT_LABELS[id] ?? id,
          textSelection.provider === id,
        ),
      );
    }
  }
  for (const def of IMAGE_GEN_PROVIDERS) {
    providers.push(
      entryFor(
        "imagegen",
        imageGenHealthKey(def.id),
        def.id,
        def.label,
        imageSelection.provider === def.id,
      ),
    );
  }
  for (const def of VIDEO_GEN_PROVIDERS) {
    providers.push(
      entryFor(
        "videogen",
        videoGenHealthKey(def.id),
        def.id,
        def.label,
        videoSelection.provider === def.id,
      ),
    );
  }
  // Admin-added OpenAI-compatible providers ride "custom:<id>" refs in every
  // family they are enabled for.
  for (const row of customRows) {
    const ref = customProviderRef(row.id);
    if (row.textEnabled) {
      providers.push(
        entryFor("textgen", textGenHealthKey(ref), ref, row.name, textSelection.provider === ref),
      );
    }
    if (row.imageEnabled) {
      providers.push(
        entryFor("imagegen", imageGenHealthKey(ref), ref, row.name, imageSelection.provider === ref),
      );
    }
    if (row.videoEnabled) {
      providers.push(
        entryFor("videogen", videoGenHealthKey(ref), ref, row.name, videoSelection.provider === ref),
      );
    }
  }

  // "Currently diverting" mirrors the exact pre-flight check the failover
  // wrapper makes: selected breaker open AND a healthy, priced substitute.
  // Runtime's ordinary text calls use NVIDIA's text deployment. Multimodal
  // calls have their own breaker and are never covered by text failover.
  const selectedKey = textGenHealthKey(textSelection.provider, "text");
  const selectedEntry = providers.find((p) => p.key === selectedKey);
  let divertedTo: string | null = null;
  if (selectedEntry && !selectedEntry.healthy) {
    const candidate = await resolveTextGenFailoverCandidate(
      textSelection.provider,
      textSelection.defaultModel ?? "",
    ).catch(() => null);
    divertedTo = candidate?.provider ?? null;
  }

  return {
    textFailover: {
      selectedProvider: textSelection.provider,
      active: divertedTo !== null,
      divertedTo,
    },
    providers,
    generatedAt: new Date().toISOString(),
  };
}
