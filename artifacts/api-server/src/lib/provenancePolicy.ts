import type {
  Character,
  LikenessRecipientOperation,
  LikenessSubjectClass,
  VideoJobOptions,
} from "@workspace/db";
import {
  isAtlasReferenceModel,
  isAtlasWanReferenceModel,
} from "./videoGen/providers/atlascloud";
import { resolveLikenessRouting } from "./likenessProviderPolicy";

/**
 * Versioned electronic-attestation text, frozen into every grant event.
 *
 * This is deliberately a bare date. The previous implementation appended a
 * hash of the currently selected image-processor scope, which meant an admin
 * changing the global image provider marked every attestation in the system
 * stale — a statement about who is in a photograph invalidated by a routing
 * change that does not alter who is in the photograph. Recipients now live in
 * their own append-only ledger instead.
 */
export const LIKENESS_CONSENT_POLICY_VERSION = "2026-09-18";

/**
 * Provider-independent, but NOT use-independent. The statement names the three
 * separable uses because permission to depict someone is not permission to put
 * words in their mouth. Recipients are disclosed and acknowledged separately,
 * per provider, so this text stays true when the routing changes.
 */
export function likenessConsentStatement(subjectClass: LikenessSubjectClass): string {
  if (subjectClass === "generated_fictional") {
    return (
      "I confirm this character is AI-generated, depicts no real or identifiable person, and is " +
      "presented as an adult. I understand a photorealistic generated face may still be refused by " +
      "a provider's automated review, and that KOKAO will only submit it to recipients I have been " +
      "shown. This attestation is not provider verification or legal certification."
    );
  }
  const authorized = subjectClass === "uploaded_authorized_person";
  return (
    "I confirm that this is an adult person's likeness and that I hold the necessary image rights. " +
    (authorized
      ? "I attest that I hold that person's written permission covering the uses I select below; " +
        "this records my declaration and is not third-party identity proof. "
      : "I provide my own written electronic consent for the uses I select below. ") +
    "I authorize only the uses I have selected — wardrobe and image editing, video depiction, and " +
    "scripted speech are separate permissions. I will be shown every provider that receives this " +
    "likeness and may withdraw any of them individually. Withdrawal stops future submissions; it " +
    "cannot recall a request already sent. This attestation is not provider verification or legal " +
    "certification."
  );
}

/**
 * Standing declaration covering server-created generated cast, which has no
 * real subject and no user present at creation time.
 */
export function tenantStandingDeclarationStatement(): string {
  return (
    "I confirm that AI-generated characters created automatically in this workspace depict no real " +
    "or identifiable person, are presented as adults, and that I will not upload a real person's " +
    "photograph through the generated-character path. Uploaded likenesses of real people require " +
    "their own per-character attestation. This declaration is not provider verification or legal " +
    "certification."
  );
}

/** Uploaded canonical references are the only personal-source class. */
export function isPersonalLikenessSource(
  character: Pick<Character, "referenceSource">,
): boolean {
  return character.referenceSource === "uploaded";
}

/**
 * The routing class for a character: whether a recipient is being asked to
 * accept a real person or a generated photorealistic face. Both uploaded
 * subject classes route identically — the self / authorized-person distinction
 * matters to the attestation, not to the provider — so the precise class is
 * read from the grant row and this returns the coarse one.
 */
export function routingSubjectClassFor(
  character: Pick<Character, "referenceSource">,
): LikenessSubjectClass {
  return character.referenceSource === "uploaded"
    ? "uploaded_self"
    : "generated_fictional";
}

/**
 * An uploaded likeness of a real person needs its own attestation before any
 * recipient may receive it. This is a hard gate.
 */
export function requiresPerCharacterAttestation(
  character: Pick<Character, "referenceSource">,
): boolean {
  return character.referenceSource === "uploaded";
}

/**
 * A generated photorealistic character is covered by the tenant's standing
 * declaration rather than a per-character signature, because the server
 * creates generated cast with no user in the loop.
 */
export function requiresStandingDeclaration(
  character: Pick<Character, "referenceSource">,
): boolean {
  return character.referenceSource === "generated";
}

/**
 * Whether a missing standing declaration BLOCKS generated work or is merely
 * recorded and surfaced.
 *
 * Defaults to record-only so that deploying this does not brick every existing
 * workspace mid-generation. Set LIKENESS_STANDING_DECLARATION_ENFORCED=true
 * once workspaces have been prompted; the status is reported either way, so the
 * UI can ask for it before the flag is flipped.
 */
export function standingDeclarationEnforced(): boolean {
  return process.env.LIKENESS_STANDING_DECLARATION_ENFORCED === "true";
}

/**
 * Registry-backed replacement for the old atlascloud+Wan-only hard check. The
 * allowlist that used to be inlined here now lives in the reviewed per-provider
 * declarations, so adding a provider is a policy decision in one file rather
 * than an edit spread across the enforcement path.
 */
export function likenessVideoRoutingVerdict(input: {
  provider: string | null | undefined;
  model: string | null | undefined;
  subjectClass: LikenessSubjectClass;
  operation?: LikenessRecipientOperation;
}) {
  return resolveLikenessRouting({
    surface: "video",
    provider: input.provider,
    model: input.model,
    operation: input.operation ?? "video",
    subjectClass: input.subjectClass,
  });
}

/** Convenience boolean for routing fences that only need eligibility. */
export function isLikenessEligibleVideoTarget(
  provider: string | null | undefined,
  model: string | null | undefined,
  subjectClass: LikenessSubjectClass,
): boolean {
  return likenessVideoRoutingVerdict({ provider, model, subjectClass }).allowed;
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
