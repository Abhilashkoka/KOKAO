import { and, eq } from "drizzle-orm";
import { contentItemsTable, db, type ContentItem } from "@workspace/db";
import type { ComplianceText } from "./check";
import { ComplianceConfigError, ComplianceUnavailableError } from "./errors";
import { checkTextsWithAiReview, resolveJobCompliance } from "./index";
import { describeFindings, type ComplianceReport } from "./check";

/** Every piece of a post that reaches a platform. */
export function contentItemComplianceTexts(
  item: Pick<ContentItem, "title" | "caption" | "imagePrompt" | "carouselSlides">,
): ComplianceText[] {
  const items: ComplianceText[] = [];
  if (item.title?.trim()) items.push({ field: "caption", location: "Title", text: item.title });
  if (item.caption?.trim()) items.push({ field: "caption", location: "Caption", text: item.caption });
  if (item.imagePrompt?.trim()) items.push({ field: "visual", location: "Image prompt", text: item.imagePrompt });
  for (const [i, slide] of (item.carouselSlides ?? []).entries()) {
    const text = [slide.heading, slide.body].filter((t) => typeof t === "string" && t.trim()).join("\n");
    if (text) items.push({ field: "caption", location: `Slide ${i + 1}`, text });
    if (slide.imagePrompt?.trim()) items.push({ field: "visual", location: `Slide ${i + 1} · image prompt`, text: slide.imagePrompt });
  }
  return items;
}

export type ContentComplianceResult =
  | { ok: true; report: ComplianceReport | null }
  | { ok: false; errorStatus: number; error: string; report: ComplianceReport | null };

/** Refuse blocked posts and report unavailable checks as transient failures. */
export async function checkContentItemCompliance(
  tenantId: number,
  contentItemId: number,
): Promise<ContentComplianceResult> {
  const item = (
    await db.select().from(contentItemsTable)
      .where(and(eq(contentItemsTable.id, contentItemId), eq(contentItemsTable.tenantId, tenantId)))
      .limit(1)
  )[0];
  if (!item) return { ok: true, report: null }; // the caller answers 404
  try {
    const frozen = await resolveJobCompliance(tenantId, item.brandKitId ?? null);
    const report = await checkTextsWithAiReview({
      tenantId,
      items: contentItemComplianceTexts(item),
      frozen,
      operationKey: `content:${item.id}:${item.updatedAt?.getTime?.() ?? 0}`,
    });
    const blocking = report?.findings.filter((f) => f.severity === "block") ?? [];
    if (report && blocking.length > 0) {
      return {
        ok: false,
        errorStatus: 422,
        error: `This post breaks ${report.profession === "medical" ? "NMC" : "ICAI"} advertising rules and was not published — ${describeFindings(blocking)}. Edit it in the Content Library and try again.`,
        report,
      };
    }
    return { ok: true, report };
  } catch (error) {
    if (error instanceof ComplianceUnavailableError || error instanceof ComplianceConfigError) {
      return { ok: false, errorStatus: 503, error: error.message, report: null };
    }
    throw error;
  }
}

export async function contentPublishBlock(
  tenantId: number,
  contentItemId: number,
): Promise<{ ok: false; errorStatus: number; error: string } | null> {
  const result = await checkContentItemCompliance(tenantId, contentItemId);
  return result.ok ? null : { ok: false, errorStatus: result.errorStatus, error: result.error };
}