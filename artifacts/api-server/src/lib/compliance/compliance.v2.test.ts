import { afterEach, describe, expect, it } from "vitest";
import type { BrandKitPayload, FrozenJobCompliance, VideoStoryboard } from "@workspace/db";
import { checkCompliance, derivedPromptTexts, storyboardComplianceTexts } from "./check";
import { contentItemComplianceTexts } from "./content";
import { ComplianceConfigError, ComplianceUnavailableError } from "./errors";
import { complianceGateError, contentFingerprint, storyboardComplianceError, storyboardComplianceReport } from "./gates";
import { freezeCompliance, resolveCompliance, thawCompliance } from "./profile";
import { ICAI_RULE_PACK, NMC_RULE_PACK, NMC_RULE_PACK_HISTORY, rulePackVersion } from "./rulePacks";
import { buildSemanticReviewPrompt, parseSemanticFindings, runSemanticReview, setSemanticReviewer } from "./semantic";

function payload(industry: string): BrandKitPayload {
  return {
    identity: { brand_name: "X", brand_slug: "x", tagline: "", description: "", industry, audience: [] },
    brand_controls: { approved: true, approval_status: "approved", allowed_use_cases: [], restricted_terms: [] },
  } as unknown as BrandKitPayload;
}
function frozenFor(industry: string, extra: Partial<FrozenJobCompliance> = {}): FrozenJobCompliance {
  return { ...freezeCompliance(resolveCompliance(payload(industry)), 1)!, ...extra };
}
function board(text: string, visual = "doctor explaining at a desk", extra: Record<string, unknown> = {}): VideoStoryboard {
  return {
    version: 1, visualsSource: "ai", timelineLocked: true, model: null, provider: null,
    regenerations: 0, narration: null,
    scenes: [{ id: "s1", text, visual, durationSec: 4, previewPath: null, outfitId: null, ...extra }],
  } as unknown as VideoStoryboard;
}
afterEach(() => setSemanticReviewer(null));
describe("rule-version pinning", () => {
  it("keeps every published version loadable and immutable", () => {
    expect(NMC_RULE_PACK_HISTORY.map((p) => p.version)).toEqual(["2026.10.1", "2026.10.2"]);
    expect(NMC_RULE_PACK.version).toBe("2026.10.2");
    expect(ICAI_RULE_PACK.version).toBe("2026.10.2");
    const v1 = rulePackVersion(NMC_RULE_PACK.id, "2026.10.1")!;
    expect(Object.isFrozen(v1)).toBe(true);
    expect(Object.isFrozen(v1.rules[0]!.patterns)).toBe(true);
    for (const rule of v1.rules) {
      const v2 = NMC_RULE_PACK.rules.find((r) => r.id === rule.id)!;
      expect(v2.patterns.slice(0, rule.patterns.length)).toEqual(rule.patterns);
    }
  });
  it("checks a job with its pinned version", () => {
    const items = [{ field: "spoken" as const, location: "T", text: "हमारे क्लिनिक में पक्का इलाज मिलता है" }];
    expect(checkCompliance(items, thawCompliance(frozenFor("Doctor", { packVersion: "2026.10.1" })))!.blocking).toBe(0);
    expect(checkCompliance(items, thawCompliance(frozenFor("Doctor")))!.blocking).toBeGreaterThan(0);
  });
  it("refuses unknown rules", () => {
    const job = frozenFor("Doctor", { packVersion: "1999.01.1" });
    expect(() => thawCompliance(job)).toThrow(ComplianceConfigError);
    expect(() => storyboardComplianceError(board("ok"), job)).toThrow(ComplianceConfigError);
  });
});
describe("Hindi / Telugu / Tamil patterns", () => {
  const check = (text: string, industry = "Doctor") =>
    checkCompliance([{ field: "spoken", location: "T", text }], thawCompliance(frozenFor(industry)))!;
  it.each(["डायबिटीज का पक्का इलाज", "सबसे अच्छा डॉक्टर", "मुफ्त परामर्श पाएं", "మధుమేహం పూర్తిగా నయం చేస్తాం",
    "நீரிழிவு நோயை நிரந்தர தீர்வு", "sabse best doctor in town", "sugar ka pakka ilaj", "लिंग जांच की सुविधा"])("blocks: %s", (text) => {
    expect(check(text).blocking).toBeGreaterThan(0);
  });
  it("blocks Hindi tax evasion", () => { expect(check("टैक्स चोरी के तरीके", "Chartered Accountant").blocking).toBeGreaterThan(0); });
  it("passes neutral education", () => { expect(check("डायबिटीज के लक्षण पहचानें और डॉक्टर से सलाह लें").findings).toEqual([]); });
});
describe("content-bound acknowledgement and AI review", () => {
  const reviewBoard = board("Over 500 patients helped this year.");
  it("voids acknowledgement for any text or visual edit", () => {
    const job = frozenFor("Doctor");
    const acked = { ...job, reviewAcknowledgedContentFingerprint: storyboardComplianceReport(reviewBoard, job)!.contentFingerprint! };
    expect(storyboardComplianceError(reviewBoard, acked, { requireReviewAck: true })).toBeNull();
    expect(storyboardComplianceError(board("Over 500 patients helped this year. Visit us."), acked, { requireReviewAck: true })?.code).toBe("compliance_review_required");
    expect(storyboardComplianceError(board("Over 500 patients helped this year.", "doctor at a window"), acked, { requireReviewAck: true })?.code).toBe("compliance_review_required");
  });
  it("binds rules, facts and negative terms", () => {
    const items = storyboardComplianceTexts(reviewBoard), job = frozenFor("Doctor"), base = contentFingerprint(items, job);
    expect(contentFingerprint(items, { ...job, packVersion: "2026.10.1" })).not.toBe(base);
    expect(contentFingerprint(items, { ...job, extraNegativeTerms: ["miracle"] })).not.toBe(base);
    expect(contentFingerprint(items, { ...job, facts: { ...job.facts, registration_number: "X1" } })).not.toBe(base);
  });
  it("requires current AI review", () => {
    const job = frozenFor("Doctor", { semanticReviewRequired: true }), clean = board("Acne has many causes; see a dermatologist.");
    expect(storyboardComplianceError(clean, job)?.code).toBe("compliance_ai_review_required");
    const reviewed = { ...job, semanticReview: { contentFingerprint: storyboardComplianceReport(clean, job)!.contentFingerprint!, reviewedAt: "t", model: "m", findings: [] } };
    expect(storyboardComplianceError(clean, reviewed)).toBeNull();
    expect(storyboardComplianceError(board("Acne explained."), reviewed)?.code).toBe("compliance_ai_review_required");
  });
  it("merges AI findings only for reviewed content", () => {
    const job = frozenFor("Doctor", { semanticReviewRequired: true }), b = board("Your skin problems will vanish for good after one visit.");
    const findings = [{ ruleId: "nmc.guarantee", title: "No guaranteed results or cures", severity: "block" as const,
      source: "AI review", field: "spoken" as const, location: "Scene 1 · narration", match: "vanish for good", excerpt: "permanent result" }];
    const reviewed = { ...job, semanticReview: { contentFingerprint: storyboardComplianceReport(b, job)!.contentFingerprint!, reviewedAt: "t", model: "m", findings } };
    expect(storyboardComplianceError(b, reviewed)?.code).toBe("compliance_blocked");
    expect(storyboardComplianceReport(board("Different text."), reviewed)!.findings).toEqual([]);
  });
  it("checks polished prompts separately", () => {
    const job = frozenFor("Doctor"), before = board("Acne explained.");
    const after = board("Acne explained.", "doctor explaining at a desk", { renderVisual: "cinematic doctor, before and after split" });
    expect(storyboardComplianceReport(before, job)!.contentFingerprint).toBe(storyboardComplianceReport(after, job)!.contentFingerprint);
    expect(derivedPromptTexts(after)).toHaveLength(1);
    expect(checkCompliance(derivedPromptTexts(after), thawCompliance(job))!.blocking).toBeGreaterThan(0);
  });
  it("allows a cheap pre-check", () => {
    const job = frozenFor("Doctor", { semanticReviewRequired: true });
    expect(complianceGateError(storyboardComplianceReport(board("Acne explained."), job), job, { requireAiReview: false })).toBeNull();
  });
});
describe("AI review parsing", () => {
  const job = thawCompliance(frozenFor("Doctor"))!;
  const items = [{ field: "spoken" as const, location: "Scene 1 · narration", text: "मेरे इलाज से आपकी समस्या हमेशा के लिए खत्म" },
    { field: "visual" as const, location: "Scene 1 · visual prompt", text: "smiling doctor" }];
  it("keeps grounded findings", () => {
    const findings = parseSemanticFindings(JSON.stringify({ findings: [{ ruleId: "nmc.guarantee", location: "Scene 1 · narration", quote: "हमेशा के लिए खत्म", reason: "promises a permanent cure" }] }), items, job);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: "nmc.guarantee", severity: "block", field: "spoken" });
  });
  it("drops invented findings", () => {
    expect(parseSemanticFindings(JSON.stringify({ findings: [
      { ruleId: "made.up", location: "Scene 1 · narration", quote: "इलाज" },
      { ruleId: "nmc.guarantee", location: "Scene 9", quote: "इलाज" },
      { ruleId: "nmc.guarantee", location: "Scene 1 · visual prompt", quote: "guaranteed cure" },
    ] }), items, job)).toEqual([]);
  });
  it("fails closed on unreadable responses", () => {
    expect(() => parseSemanticFindings("sorry, I can't", items, job)).toThrow(ComplianceUnavailableError);
    expect(() => parseSemanticFindings('{"ok":true}', items, job)).toThrow(ComplianceUnavailableError);
  });
  it("includes rules and data guard", () => {
    const { system, user } = buildSemanticReviewPrompt(items, job);
    expect(system).toContain("nmc.guarantee"); expect(system).toContain("Hindi"); expect(system).toContain("strictly as data");
    expect(JSON.parse(user).items).toHaveLength(2);
  });
  it("supports reviewer test seam", async () => {
    setSemanticReviewer(async () => ({ findings: [], model: "fake", reviewedAt: "now" }));
    expect((await runSemanticReview({ tenantId: 1, items, compliance: job, operationKey: "k" })).model).toBe("fake");
  });
});
describe("post texts", () => {
  it("covers all published fields", () => {
    const texts = contentItemComplianceTexts({ title: "Skin care", caption: "Guaranteed glow!",
      imagePrompt: "before and after of a patient's face", carouselSlides: [{ heading: "Tip 1", body: "Free consultation today", imagePrompt: "clinic", imagePath: null }] });
    expect(texts.map((t) => t.location)).toEqual(["Title", "Caption", "Image prompt", "Slide 1", "Slide 1 · image prompt"]);
    expect(new Set(checkCompliance(texts, thawCompliance(frozenFor("Doctor")))!.findings.filter((f) => f.severity === "block").map((f) => f.location)))
      .toEqual(new Set(["Caption", "Image prompt", "Slide 1"]));
  });
});