import type {
  LikenessRecipientOperation,
  LikenessSubjectClass,
} from "@workspace/db";

/**
 * This module is deliberately a LEAF: type-only imports, no provider adapters,
 * no database. Every enforcement path in the codebase consults it, so it has to
 * be importable and unit-testable without booting provider clients or a DB.
 *
 * The two Atlas model ids below are therefore literals rather than imports from
 * the Atlas adapter. likenessProviderPolicy.test.ts asserts they stay identical
 * to ATLASCLOUD_WAN_30_REFERENCE_MODEL / ATLASCLOUD_WAN_30_PRIME_REFERENCE_MODEL,
 * so the duplication cannot silently drift.
 */
const ATLASCLOUD_WAN_30_REFERENCE_MODEL = "alibaba/wan-3.0/reference-to-video";
const ATLASCLOUD_WAN_30_PRIME_REFERENCE_MODEL =
  "alibaba/wan-3.0-prime/reference-to-video";

/**
 * Whether a provider will accept a human likeness of a given kind.
 *
 * "undeclared" fails closed. A provider nobody has checked is not a provider a
 * real person's face gets sent to, and an unchecked provider must never become
 * eligible by accident merely because someone added an adapter for it.
 */
export type LikenessAcceptance = "accepted" | "refused" | "undeclared";

export type LikenessSurface = "image" | "video";

export interface ProviderLikenessDeclaration {
  providerId: string;
  surface: LikenessSurface;
  /** A real, identifiable person's likeness (uploaded_self / authorized_person). */
  realLikeness: LikenessAcceptance;
  /**
   * A photorealistic human face that is AI-generated and depicts nobody real.
   * Separate axis on purpose: several providers' input classifiers reject a
   * generated face precisely because they cannot tell it from a real one, so
   * "fictional" is not automatically safer than "real" at the API boundary.
   */
  generatedPhotorealistic: LikenessAcceptance;
  /** Exact model ids the real-likeness acceptance is limited to. null = all catalogued models. */
  realLikenessModelAllowlist: readonly string[] | null;
  /** Operations this provider must never receive ANY likeness for. */
  refusedOperations: readonly LikenessRecipientOperation[];
  /**
   * Operations refused for a REAL person only. A provider may happily register
   * a generated fictional character as a reusable asset while never being an
   * acceptable home for an identifiable person's face.
   */
  realLikenessRefusedOperations: readonly LikenessRecipientOperation[];
  /** A provider-side identity verification that the attestation does not replace. */
  requiresVerifiedIdentity: boolean;
  /** Why this declaration reads the way it does, and what would change it. */
  basis: string;
}

/**
 * Reviewed declarations, one reviewable file rather than a field scattered
 * across sixteen adapters. Exhaustiveness against both provider registries is
 * asserted by likenessProviderPolicy.test.ts, so a newly added provider fails
 * the suite until somebody decides what it is allowed to receive.
 *
 * None of this certifies legal compliance or guarantees that a particular
 * submission passes provider moderation. Recheck the applicable terms and the
 * exact model contract before moving any entry to "accepted".
 */
export const PROVIDER_LIKENESS_DECLARATIONS: readonly ProviderLikenessDeclaration[] = [
  // ---------------------------------------------------------------- image ---
  {
    providerId: "openai",
    surface: "image",
    realLikeness: "accepted",
    generatedPhotorealistic: "accepted",
    realLikenessModelAllowlist: null,
    refusedOperations: ["asset_registration"],
    realLikenessRefusedOperations: [],
    requiresVerifiedIdentity: false,
    basis:
      "Already the disclosed wardrobe/sheet processor for consented adult sources in this codebase; " +
      "exact protected-region masked edits keep the identity region untouched.",
  },
  {
    providerId: "replicate",
    surface: "image",
    realLikeness: "refused",
    generatedPhotorealistic: "refused",
    realLikenessModelAllowlist: null,
    refusedOperations: ["reference_sheet", "outfit", "video", "asset_registration"],
    realLikenessRefusedOperations: ["reference_sheet", "outfit", "video", "asset_registration"],
    requiresVerifiedIdentity: false,
    basis:
      "Observed to reject photorealistic human reference images as possibly-real people, including " +
      "AI-generated character sheets. Routing one here burns credits on a certain rejection.",
  },
  {
    providerId: "openrouter",
    surface: "image",
    realLikeness: "refused",
    generatedPhotorealistic: "refused",
    realLikenessModelAllowlist: null,
    refusedOperations: ["reference_sheet", "outfit", "video", "asset_registration"],
    realLikenessRefusedOperations: ["reference_sheet", "outfit", "video", "asset_registration"],
    requiresVerifiedIdentity: false,
    basis:
      "Same observed rejection as Replicate on photorealistic human references, generated ones included.",
  },
  {
    providerId: "gemini",
    surface: "image",
    realLikeness: "undeclared",
    generatedPhotorealistic: "undeclared",
    realLikenessModelAllowlist: null,
    refusedOperations: [],
    realLikenessRefusedOperations: ["asset_registration"],
    requiresVerifiedIdentity: false,
    basis:
      "Person-generation and person-editing permissions vary by Google API tier and were not verified " +
      "for this workflow. Confirm the tier's people policy before accepting.",
  },
  {
    providerId: "bfl",
    surface: "image",
    realLikeness: "undeclared",
    generatedPhotorealistic: "undeclared",
    realLikenessModelAllowlist: null,
    refusedOperations: [],
    realLikenessRefusedOperations: ["asset_registration"],
    requiresVerifiedIdentity: false,
    basis: "Not reviewed for personal-likeness input.",
  },
  {
    providerId: "seedream",
    surface: "image",
    realLikeness: "undeclared",
    generatedPhotorealistic: "undeclared",
    realLikenessModelAllowlist: null,
    refusedOperations: [],
    realLikenessRefusedOperations: ["asset_registration"],
    requiresVerifiedIdentity: false,
    basis:
      "ModelArk-family image endpoint. Review alongside the direct BytePlus account terms; the video " +
      "entry's verified-identity requirement most likely applies here too.",
  },
  {
    providerId: "stability",
    surface: "image",
    realLikeness: "undeclared",
    generatedPhotorealistic: "undeclared",
    realLikenessModelAllowlist: null,
    refusedOperations: [],
    realLikenessRefusedOperations: ["asset_registration"],
    requiresVerifiedIdentity: false,
    basis: "Not reviewed for personal-likeness input.",
  },
  {
    providerId: "higgsfield",
    surface: "image",
    realLikeness: "undeclared",
    generatedPhotorealistic: "undeclared",
    realLikenessModelAllowlist: null,
    refusedOperations: [],
    realLikenessRefusedOperations: ["asset_registration"],
    requiresVerifiedIdentity: false,
    basis:
      "Higgsfield's consumer Soul ID product takes a rights declaration for uploaded faces, but the API " +
      "contract for passing a likeness was not verified. Confirm the API terms before accepting.",
  },
  {
    providerId: "nvidia",
    surface: "image",
    realLikeness: "undeclared",
    generatedPhotorealistic: "undeclared",
    realLikenessModelAllowlist: null,
    refusedOperations: [],
    realLikenessRefusedOperations: ["asset_registration"],
    requiresVerifiedIdentity: false,
    basis: "Self-hosted NIM. Acceptance depends on the operator's own deployment terms.",
  },
  {
    providerId: "custom",
    surface: "image",
    realLikeness: "refused",
    generatedPhotorealistic: "refused",
    realLikenessModelAllowlist: null,
    refusedOperations: ["reference_sheet", "outfit", "video", "asset_registration"],
    realLikenessRefusedOperations: ["reference_sheet", "outfit", "video", "asset_registration"],
    requiresVerifiedIdentity: false,
    basis:
      "An admin-entered base URL is an undisclosed recipient by construction. A likeness is never sent " +
      "to an endpoint the attestation could not name.",
  },

  // ---------------------------------------------------------------- video ---
  {
    providerId: "atlascloud",
    surface: "video",
    realLikeness: "accepted",
    generatedPhotorealistic: "accepted",
    realLikenessModelAllowlist: [
      ATLASCLOUD_WAN_30_REFERENCE_MODEL,
      ATLASCLOUD_WAN_30_PRIME_REFERENCE_MODEL,
    ],
    // Generated fictional characters DO belong in the Atlas Asset Library —
    // that is the working path. Only a real person is excluded from it.
    refusedOperations: [],
    realLikenessRefusedOperations: ["asset_registration"],
    requiresVerifiedIdentity: false,
    basis:
      "docs/personal-likeness-provider-policy.md: Atlas terms require image rights and written consent " +
      "for identifiable people, and only the exact Wan reference-to-video contracts document reference " +
      "media input. The Asset Library is fictional-only and never receives a real likeness.",
  },
  {
    providerId: "byteplus",
    surface: "video",
    realLikeness: "accepted",
    generatedPhotorealistic: "accepted",
    realLikenessModelAllowlist: null,
    refusedOperations: [],
    realLikenessRefusedOperations: [],
    requiresVerifiedIdentity: true,
    basis:
      "ModelArk/BytePlus accepts a real likeness through its own identity verification, which the KOKAO " +
      "attestation records alongside but never replaces. Asset ids are scoped to the account that owns them.",
  },
  {
    providerId: "replicate",
    surface: "video",
    realLikeness: "refused",
    generatedPhotorealistic: "refused",
    realLikenessModelAllowlist: null,
    refusedOperations: ["reference_sheet", "outfit", "video", "asset_registration"],
    realLikenessRefusedOperations: ["reference_sheet", "outfit", "video", "asset_registration"],
    requiresVerifiedIdentity: false,
    basis: "Same observed photorealistic-human rejection as the image surface.",
  },
  {
    providerId: "openrouter",
    surface: "video",
    realLikeness: "refused",
    generatedPhotorealistic: "refused",
    realLikenessModelAllowlist: null,
    refusedOperations: ["reference_sheet", "outfit", "video", "asset_registration"],
    realLikenessRefusedOperations: ["reference_sheet", "outfit", "video", "asset_registration"],
    requiresVerifiedIdentity: false,
    basis: "Same observed photorealistic-human rejection as the image surface.",
  },
  {
    providerId: "higgsfield",
    surface: "video",
    realLikeness: "undeclared",
    generatedPhotorealistic: "undeclared",
    realLikenessModelAllowlist: null,
    refusedOperations: [],
    realLikenessRefusedOperations: ["asset_registration"],
    requiresVerifiedIdentity: false,
    basis:
      "Seedance via Higgsfield is a reseller path; whether a likeness may be passed under their API terms " +
      "was not verified, and their asset namespace is not KOKAO's.",
  },
  {
    providerId: "nvidia",
    surface: "video",
    realLikeness: "undeclared",
    generatedPhotorealistic: "undeclared",
    realLikenessModelAllowlist: null,
    refusedOperations: [],
    realLikenessRefusedOperations: ["asset_registration"],
    requiresVerifiedIdentity: false,
    basis: "Self-hosted NIM. Acceptance depends on the operator's own deployment terms.",
  },
] as const;

export function providerLikenessDeclaration(
  surface: LikenessSurface,
  provider: string | null | undefined,
): ProviderLikenessDeclaration | null {
  if (!provider) return null;
  return (
    PROVIDER_LIKENESS_DECLARATIONS.find(
      (entry) => entry.surface === surface && entry.providerId === provider,
    ) ?? null
  );
}

/**
 * Compare the declarations against the live provider registries. The caller
 * passes the registry ids so this module stays a leaf; the test suite feeds it
 * IMAGE_GEN_PROVIDERS and VIDEO_GEN_PROVIDERS and fails when a newly added
 * provider has no reviewed position yet.
 */
export function declaredProviderCoverage(
  registry: readonly { surface: LikenessSurface; providerId: string }[],
): {
  missing: { surface: LikenessSurface; providerId: string }[];
  extra: { surface: LikenessSurface; providerId: string }[];
} {
  const key = (entry: { surface: string; providerId: string }) =>
    `${entry.surface}:${entry.providerId}`;
  const declared = new Set(PROVIDER_LIKENESS_DECLARATIONS.map(key));
  const known = new Set(registry.map(key));
  return {
    missing: registry.filter((entry) => !declared.has(key(entry))),
    extra: PROVIDER_LIKENESS_DECLARATIONS.filter((entry) => !known.has(key(entry))).map(
      (entry) => ({ surface: entry.surface, providerId: entry.providerId }),
    ),
  };
}

export type LikenessRoutingVerdict =
  | { allowed: true; requiresVerifiedIdentity: boolean }
  | { allowed: false; reason: string };

/**
 * Decide whether this exact recipient may receive this class of likeness for
 * this operation, BEFORE any funding is reserved or bytes leave the process.
 *
 * This is the half of the design that turns a consent record into something
 * operationally useful: the attestation says the paperwork is in order, this
 * says the provider will actually take it. A refusal here is a fast, explained
 * failure instead of a paid provider rejection.
 */
export function resolveLikenessRouting(input: {
  surface: LikenessSurface;
  provider: string | null | undefined;
  model: string | null | undefined;
  operation: LikenessRecipientOperation;
  subjectClass: LikenessSubjectClass;
}): LikenessRoutingVerdict {
  const declaration = providerLikenessDeclaration(input.surface, input.provider);
  if (!declaration) {
    return {
      allowed: false,
      reason:
        `No reviewed likeness declaration exists for ${input.surface} provider ` +
        `"${input.provider ?? "unknown"}". A human likeness is never sent to an undeclared recipient.`,
    };
  }
  if (declaration.refusedOperations.includes(input.operation)) {
    return {
      allowed: false,
      reason:
        `${declaration.providerId} must never receive a likeness for ${input.operation}. ${declaration.basis}`,
    };
  }
  const real = input.subjectClass !== "generated_fictional";
  if (real && declaration.realLikenessRefusedOperations.includes(input.operation)) {
    return {
      allowed: false,
      reason:
        `${declaration.providerId} must never receive a real person's likeness for ` +
        `${input.operation}, even with a valid attestation. ${declaration.basis}`,
    };
  }
  const acceptance = real
    ? declaration.realLikeness
    : declaration.generatedPhotorealistic;
  if (acceptance === "refused") {
    return {
      allowed: false,
      reason:
        `${declaration.providerId} refuses ${real ? "real" : "AI-generated photorealistic"} human ` +
        `likenesses. ${declaration.basis}`,
    };
  }
  if (acceptance === "undeclared") {
    return {
      allowed: false,
      reason:
        `${declaration.providerId} has no reviewed position on ${real ? "real" : "AI-generated photorealistic"} ` +
        `human likenesses, so it fails closed. ${declaration.basis}`,
    };
  }
  if (
    real &&
    declaration.realLikenessModelAllowlist &&
    !(input.model && declaration.realLikenessModelAllowlist.includes(input.model))
  ) {
    return {
      allowed: false,
      reason:
        `${declaration.providerId} accepts a real likeness only on these exact models: ` +
        `${declaration.realLikenessModelAllowlist.join(", ")}. ${declaration.basis}`,
    };
  }
  return { allowed: true, requiresVerifiedIdentity: declaration.requiresVerifiedIdentity };
}

/** Stable label a user is shown when they acknowledge a recipient. */
export function recipientScopeLabel(input: {
  operation: LikenessRecipientOperation;
  providerLabel: string;
  model: string;
}): string {
  return `${input.operation}|${input.providerLabel} / ${input.model}`;
}
