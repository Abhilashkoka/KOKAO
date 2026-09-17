import type { VideoJobOptions } from "@workspace/db";
import {
  isAtlasReferenceModel,
  isAtlasWanReferenceModel,
} from "./videoGen/providers/atlascloud";

/** Versioned electronic-attestation text, frozen into every grant event. */
export const LIKENESS_CONSENT_POLICY_VERSION = "2026-09-17";
export function likenessConsentStatement(imageProcessorScope: readonly string[]): string {
  const processors = imageProcessorScope.length
    ? imageProcessorScope.join(", ")
    : "no image processor is currently configured";
  return (
  "I confirm that this is an adult person's likeness, that I have the necessary image rights, " +
  "and that I may authorize the selected Atlas Cloud Wan reference-to-video use. " +
  "If I select self, I provide my written electronic consent. If I select authorized_person, " +
  "I attest that I hold that person's written permission; this is not third-party identity proof. " +
  `If I enable outfit edits, I authorize only these disclosed image processors: ${processors}. ` +
  "This attestation is not provider verification or legal certification."
  );
}

/** Uploaded canonical references are the only personal-source class. */
export function isPersonalLikenessSource(
  character: Pick<import("@workspace/db").Character, "referenceSource">,
): boolean {
  return character.referenceSource === "uploaded";
}

/**
 * Personal likeness grants are intentionally narrow: only documented exact
 * Wan reference-to-video model ids qualify. A provider name, model substring,
 * custom model, or Seedance id is never an equivalent policy target.
 */
export function isWanPersonalLikenessModel(
  provider: string | null | undefined,
  model: string | null | undefined,
): boolean {
  return provider === "atlascloud" && typeof model === "string" &&
    isAtlasWanReferenceModel(model);
}

/**
 * Only the fictional-only multi-reference contracts require the complete
 * generated-character proof contract. Ordinary providers keep their existing
 * approved/consented uploaded and legacy behavior.
 */
export function requiresStrictFictionalProvenance(
  options:
    | Pick<VideoJobOptions, "resolvedVideoModel">
    | null
    | undefined,
): boolean {
  const model = options?.resolvedVideoModel?.model ?? "";
  return isAtlasReferenceModel(model) || isAtlasWanReferenceModel(model);
}