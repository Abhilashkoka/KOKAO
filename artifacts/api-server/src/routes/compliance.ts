import { Router, type IRouter, type Request, type Response } from "express";
import type { BrandKitPayload } from "@workspace/db";
import {
  CheckComplianceTextBody,
  DetectComplianceProfessionBody,
} from "@workspace/api-zod";
import { loadActivePayload } from "../lib/brandKit/service";
import {
  RULE_PACKS,
  checkCompliance,
  detectProfession,
  resolveCompliance,
  type ComplianceRulePack,
} from "../lib/compliance";

/**
 * Profession compliance (NMC / ICAI) for the Brand Kit editor:
 *   GET  /brand-kits/compliance/rule-packs  — what each pack enforces
 *   POST /brand-kits/compliance/detect      — Business/Industry → profession
 *   POST /brand-kits/compliance/check       — run the negative list on text
 * Mounted before the brand-kit router so "compliance" never parses as :id.
 */
const router: IRouter = Router();

export function publicRulePack(pack: ComplianceRulePack) {
  return {
    id: pack.id,
    version: pack.version,
    profession: pack.profession,
    label: pack.label,
    regulator: pack.regulator,
    summary: pack.summary,
    sources: pack.sources.map((s) => ({ title: s.title, url: s.url, note: s.note ?? null })),
    rules: pack.rules.map((r) => ({
      id: r.id,
      title: r.title,
      source: r.source,
      severity: r.severity,
      instruction: r.instruction,
      fields: r.fields,
    })),
    visualNegatives: pack.visualNegatives,
  };
}

router.get("/brand-kits/compliance/rule-packs", (_req: Request, res: Response) => {
  res.json(Object.values(RULE_PACKS).map(publicRulePack));
});

router.post("/brand-kits/compliance/detect", (req: Request, res: Response) => {
  const parsed = DetectComplianceProfessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  res.json({
    profession: detectProfession(parsed.data.industry, parsed.data.description ?? null),
  });
});

router.post("/brand-kits/compliance/check", async (req: Request, res: Response) => {
  const parsed = CheckComplianceTextBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  const body = parsed.data;
  // Start from the saved kit (tenant-scoped), then overlay unsaved editor
  // state so the user can test a profile before saving it.
  const saved = body.brandKitId != null ? await loadActivePayload(req.tenantId, body.brandKitId) : null;
  if (body.brandKitId != null && !saved) {
    res.status(404).json({ error: "Brand kit not found." });
    return;
  }
  const payload = {
    ...(saved?.payload ?? {}),
    identity: {
      ...(saved?.payload.identity ?? {}),
      industry: body.industry ?? saved?.payload.identity.industry ?? "",
      description: saved?.payload.identity.description ?? "",
    },
    brand_controls: {
      ...(saved?.payload.brand_controls ?? {}),
      restricted_terms: body.restrictedTerms ?? saved?.payload.brand_controls.restricted_terms ?? [],
    },
    compliance: body.compliance !== undefined ? body.compliance : (saved?.payload.compliance ?? null),
  } as BrandKitPayload;
  const field = body.field ?? "caption";
  res.json(checkCompliance([{ field, location: "Text", text: body.text }], resolveCompliance(payload)));
});

export default router;
