/**
 * Ark Asset Library identities accepted by Seedance. These are deliberately
 * narrower than generic Atlas console ids: only ark_asset_id is usable in an
 * asset:// generation reference.
 */
export function isAtlasGenerationReferenceId(value: unknown): value is string {
  return typeof value === "string" &&
    /^asset-[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/.test(value);
}

/** Prefer a valid canonical id, otherwise accept only a valid legacy alias. */
export function selectAtlasGenerationReferenceId(
  canonical: unknown,
  compatibility: unknown,
): string | null {
  if (isAtlasGenerationReferenceId(canonical)) return canonical;
  return isAtlasGenerationReferenceId(compatibility) ? compatibility : null;
}