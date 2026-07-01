import {
  db,
  brandKitsTable,
  tenantBrandPreferencesTable,
  type BrandKit,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { serializeKit, serializeKitResolved } from "./service";

export interface SelectionInput {
  brandKitId?: number | null;
  brandSlug?: string | null;
  useCase?: string | null;
  channel?: string | null;
  contentType?: string | null;
}

export interface SelectionResult {
  status: "resolved" | "ambiguous" | "none";
  reason: string;
  brandKit: ReturnType<typeof serializeKit> | null;
  candidates: ReturnType<typeof serializeKit>[];
}

/**
 * Deterministic brand selection. Priority chain:
 *   1. Explicit brandKitId
 *   2. Explicit brandSlug
 *   3. Best-matching tenant preference (by specificity, then priority)
 *   4. Tenant default brand
 *   5. The tenant's only brand
 *   6. None
 * Preference ties at the same specificity + priority yield an "ambiguous"
 * result with the tied candidates so the caller can prompt the user.
 */
export async function resolveSelection(
  tenantId: number,
  input: SelectionInput,
): Promise<SelectionResult> {
  const activeKits = await db
    .select()
    .from(brandKitsTable)
    .where(
      and(eq(brandKitsTable.tenantId, tenantId), eq(brandKitsTable.isArchived, false)),
    );
  const byId = new Map(activeKits.map((k) => [k.id, k]));

  const resolved = async (
    kit: BrandKit,
    reason: string,
  ): Promise<SelectionResult> => ({
    status: "resolved",
    reason,
    brandKit: await serializeKitResolved(tenantId, kit),
    candidates: [],
  });

  const serializeAll = (kits: BrandKit[]) =>
    Promise.all(kits.map((k) => serializeKitResolved(tenantId, k)));

  // 1. Explicit id
  if (input.brandKitId != null) {
    const kit = byId.get(input.brandKitId);
    if (kit) return resolved(kit, "Explicit brand id.");
    return {
      status: "none",
      reason: "The requested brand id does not exist for this tenant.",
      brandKit: null,
      candidates: [],
    };
  }

  // 2. Explicit slug
  if (input.brandSlug) {
    const kit = activeKits.find((k) => k.slug === input.brandSlug);
    if (kit) return resolved(kit, "Explicit brand slug.");
    return {
      status: "none",
      reason: "The requested brand slug does not exist for this tenant.",
      brandKit: null,
      candidates: [],
    };
  }

  // 3. Preferences (specificity, then priority)
  const prefs = await db
    .select()
    .from(tenantBrandPreferencesTable)
    .where(eq(tenantBrandPreferencesTable.tenantId, tenantId));

  const matches = prefs
    .map((p) => {
      let score = 0;
      if (p.useCase != null) {
        if (p.useCase !== (input.useCase ?? null)) return null;
        score += 1;
      }
      if (p.channel != null) {
        if (p.channel !== (input.channel ?? null)) return null;
        score += 1;
      }
      if (p.contentType != null) {
        if (p.contentType !== (input.contentType ?? null)) return null;
        score += 1;
      }
      return { pref: p, score };
    })
    .filter((m): m is { pref: (typeof prefs)[number]; score: number } => m !== null)
    .filter((m) => byId.has(m.pref.brandKitId));

  if (matches.length > 0) {
    const bestScore = Math.max(...matches.map((m) => m.score));
    const topScore = matches.filter((m) => m.score === bestScore);
    const bestPriority = Math.max(...topScore.map((m) => m.pref.priority));
    const winners = topScore.filter((m) => m.pref.priority === bestPriority);
    const uniqueKitIds = Array.from(new Set(winners.map((w) => w.pref.brandKitId)));
    if (uniqueKitIds.length === 1) {
      const kit = byId.get(uniqueKitIds[0]!)!;
      return resolved(kit, "Matched a tenant brand preference.");
    }
    return {
      status: "ambiguous",
      reason:
        "Multiple brand preferences match this request equally. Choose a brand explicitly.",
      brandKit: null,
      candidates: await serializeAll(uniqueKitIds.map((id) => byId.get(id)!)),
    };
  }

  // 4. Default brand
  const def = activeKits.find((k) => k.isDefault);
  if (def) return resolved(def, "Tenant default brand.");

  // 5. Only brand
  if (activeKits.length === 1) {
    return resolved(activeKits[0]!, "The tenant's only brand.");
  }

  // 6. None / ambiguous
  return {
    status: activeKits.length === 0 ? "none" : "ambiguous",
    reason:
      activeKits.length === 0
        ? "This tenant has no brands yet."
        : "No default brand is set and the request did not name one.",
    brandKit: null,
    candidates: activeKits.length === 0 ? [] : await serializeAll(activeKits),
  };
}
