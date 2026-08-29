import { getPresetForTenant } from "./presetCharacters";

export interface StoryCastAssignmentInput {
  role: string;
  presetCharacterId: string;
  presetOutfitDerivativeId?: number | null;
  presetVoiceId?: string | null;
  language?: string | null;
}

export interface ValidatedStoryCastAssignment {
  role: string;
  presetCharacterId: string;
  presetOutfitDerivativeId: number | null;
  presetVoiceId: string;
  language: string;
}

/**
 * Shared guided-story boundary validation. Call this before enqueueing any
 * multi-role contract: it resolves every tenant-owned derivative and refuses
 * duplicate people unless the caller made the per-request confirmation.
 */
export async function validateStoryCastAssignments(
  tenantId: number,
  assignments: readonly StoryCastAssignmentInput[],
  confirmDuplicateCharacterAssignments: boolean,
): Promise<{ assignments: ValidatedStoryCastAssignment[] } | { error: string }> {
  if (assignments.length === 0 || assignments.length > 12) {
    return { error: "A story cast must contain between one and twelve roles." };
  }
  const roles = new Set<string>();
  const characters = new Set<string>();
  const validated: ValidatedStoryCastAssignment[] = [];
  for (const item of assignments) {
    const role = item.role?.trim();
    const presetId = item.presetCharacterId?.trim();
    const language = item.language?.trim() || "en";
    if (!role || role.length > 80 || !presetId || roles.has(role)) {
      return { error: "Each story cast role must be unique and named." };
    }
    const derivativeId = item.presetOutfitDerivativeId ?? null;
    if (derivativeId !== null && (!Number.isInteger(derivativeId) || derivativeId <= 0)) {
      return { error: "Invalid preset outfit derivative." };
    }
    const resolved = await getPresetForTenant(tenantId, presetId, derivativeId);
    if (!resolved) return { error: "A selected preset character or outfit is unavailable." };
    const voice =
      resolved.preset.voices.find((candidate) => candidate.id === item.presetVoiceId) ??
      (item.presetVoiceId == null ? resolved.preset.voices[0] : undefined);
    if (
      !voice ||
      !resolved.preset.supportedLanguages.includes(language) ||
      !voice.languages.includes(language)
    ) {
      return { error: "A selected preset voice does not support that character language." };
    }
    if (characters.has(resolved.preset.stableId) && !confirmDuplicateCharacterAssignments) {
      return {
        error:
          "A character cannot be assigned to multiple roles unless duplicate casting is explicitly confirmed.",
      };
    }
    roles.add(role);
    characters.add(resolved.preset.stableId);
    validated.push({
      role,
      presetCharacterId: resolved.preset.stableId,
      presetOutfitDerivativeId: derivativeId,
      presetVoiceId: voice.id,
      language,
    });
  }
  return { assignments: validated };
}