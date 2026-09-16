import type { VideoJobOptions } from "@workspace/db";
import {
  isAtlasReferenceModel,
  isAtlasWanReferenceModel,
} from "./videoGen/providers/atlascloud";

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