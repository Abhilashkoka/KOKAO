import { describe, expect, it } from "vitest";
import type { BrandKitPayload, FrozenJobCompliance, VideoStoryboard } from "@workspace/db";
import { checkCompliance, guidedScriptComplianceTexts, storyboardComplianceTexts } from "./check";
import { detectProfession, freezeCompliance, resolveCompliance, thawCompliance } from "./profile";
import { complianceTextConstraints, complianceVisualGuidance, withComplianceVoice } from "./prompt";
import { ICAI_RULE_PACK, NMC_RULE_PACK } from "./rulePacks";
import { newBlockingFindings, reviewFingerprint, storyboardComplianceError, storyboardComplianceReport } from "./gates";

function payload(industry: string, compliance?: BrandKitPayload["compliance"]): BrandKitPayload {
  return {
    identity: { brand_name: "X", brand_slug: "x", tagline: "", description: "", industry, audience: [] },
    brand_controls: { approved: true, approval_status: "approved", allowed_use_cases: [], restricted_terms: ["cheap"] },
    compliance,
  } as unknown as BrandKitPayload;
}

const facts = {
  practitioner_name: "Dr. A. Rao",
  registration_number: "TSMC/12345",
  registering_body: "Telangana State Medical Council",
  qualifications: ["MBBS", "MD (Dermatology)"],
  services: ["Acne care"],
  practice_address: "Hyderabad",
  verified_claims: ["12 years of experience"],
};

function check(text: string, industry = "Dermatologist", field: "spoken" | "visual" | "caption" = "spoken") {
  return checkCompliance([{ field, location: "T", text }], resolveCompliance(payload(industry)))!;
}

describe("detectProfession", () => {
  it.each([
    ["Doctor", "medical"],
    ["Dermatology clinic", "medical"],
    ["IVF & fertility centre", "medical"],
    ["MBBS, MD General Medicine", "medical"],
    ["Chartered Accountant", "chartered_accountant"],
    ["CA firm", "chartered_accountant"],
    ["CA", "chartered_accountant"],
    ["Dental clinic", null],
    ["Ayurveda wellness", null],
    ["Healthcare technology", null],
    ["Bakery", null],
    ["", null],
  ])("%s → %s", (industry, expected) => {
    expect(detectProfession(industry)).toBe(expected);
  });
});

describe("resolveCompliance", () => {
  it("auto-detects legacy kits with no saved profile", () => {
    const c = resolveCompliance(payload("Doctor"));
    expect(c?.profession).toBe("medical");
    expect(c?.source).toBe("auto");
    expect(c?.confirmed).toBe(false);
    expect(c?.restrictedTerms).toEqual(["cheap"]);
  });
  it("honours an explicit manual opt-out only", () => {
    const base = { source: "manual" as const, confirmed_at: null, facts, extra_negative_terms: [] };
    expect(resolveCompliance(payload("Doctor", { ...base, profession: "none" }))).toBeNull();
    expect(
      resolveCompliance(payload("Doctor", { ...base, source: "auto", profession: "none" }))?.profession,
    ).toBe("medical");
  });
  it("manual profession wins over industry", () => {
    const c = resolveCompliance(
      payload("Bakery", { profession: "chartered_accountant", source: "manual", confirmed_at: "2026-10-01", facts, extra_negative_terms: [] }),
    );
    expect(c?.pack.id).toBe(ICAI_RULE_PACK.id);
    expect(c?.confirmed).toBe(true);
  });
  it("falls back to tenant industry", () => {
    expect(resolveCompliance(payload(""), "Chartered Accountant")?.profession).toBe("chartered_accountant");
  });
});

describe("NMC negative list", () => {
  it.each([
    "We guarantee clear skin in 30 days",
    "100% success rate with zero side effects",
    "Permanent cure for hair loss",
    "Best dermatologist in Hyderabad",
    "Hear what our happy patients say",
    "See the before and after results",
    "Flat 20% off this Diwali — free consultation!",
    "Call now, don't wait",
    "We can cure diabetes naturally",
    "Choose a baby boy with our IVF",
  ])("blocks: %s", (text) => {
    expect(check(text).blocking).toBeGreaterThan(0);
  });

  it("passes educational content", () => {
    const report = check(
      "Acne has many causes. Results vary from person to person, so consult a qualified dermatologist if it persists.",
    );
    expect(report.findings).toEqual([]);
  });

  it("flags unverified numbers for review but lets verified facts through", () => {
    const base = { profession: "medical" as const, source: "manual" as const, confirmed_at: null, extra_negative_terms: [] };
    const c = resolveCompliance(payload("Doctor", { ...base, facts }));
    const verified = checkCompliance([{ field: "spoken", location: "T", text: "Dr. Rao has 12 years of experience." }], c)!;
    expect(verified.findings).toEqual([]);
    const unverified = checkCompliance([{ field: "spoken", location: "T", text: "Over 5,000 patients treated." }], c)!;
    expect(unverified.review).toBeGreaterThan(0);
    expect(unverified.blocking).toBe(0);
  });

  it("waives specialist wording when qualifications are on file", () => {
    expect(check("Our specialist explains").review).toBe(1);
    const c = resolveCompliance(
      payload("Doctor", { profession: "medical", source: "manual", confirmed_at: null, facts, extra_negative_terms: [] }),
    );
    expect(checkCompliance([{ field: "spoken", location: "T", text: "Our specialist explains" }], c)!.findings).toEqual([]);
  });

  it("enforces brand negative terms as whole words", () => {
    expect(check("cheap tricks").findings.some((f) => f.ruleId === "brand.negative_terms")).toBe(true);
    expect(check("cheapest").findings.some((f) => f.ruleId === "brand.negative_terms")).toBe(false);
  });

  it("catches visual-prompt violations but not text-only rules", () => {
    expect(check("split screen before/after of a patient's face", "Doctor", "visual").blocking).toBeGreaterThan(0);
    expect(check("doctor smiling, banner saying book now", "Doctor", "visual").findings.filter((f) => f.ruleId === "nmc.solicitation")).toEqual([]);
  });
});

describe("ICAI negative list", () => {
  it.each([
    "Hire us for your GST filing",
    "Our clients include Tata and Infosys",
    "ITR filing starting at ₹999",
    "No refund, no fee",
    "Guaranteed maximum refund",
    "Award-winning CA firm",
    "Learn how to evade tax legally",
  ])("blocks: %s", (text) => {
    expect(check(text, "Chartered Accountant").blocking).toBeGreaterThan(0);
  });

  it("passes knowledge-sharing content", () => {
    expect(
      check("Section 80C lets you claim deductions on eligible investments. Keep proofs ready before you file.", "Chartered Accountant").findings,
    ).toEqual([]);
  });
});

describe("storyboard + guided texts", () => {
  const board = {
    version: 1,
    visualsSource: "ai",
    timelineLocked: true,
    model: null,
    provider: null,
    regenerations: 0,
    narration: { audioPath: "x", totalDurationSec: 4, cues: [{ text: "ignored when scenes speak", startSec: 0, endSec: 4 }] },
    scenes: [
      { id: "s1", text: "Acne explained.", visual: "testimonial video of a smiling patient", durationSec: 4, previewPath: null, outfitId: null },
    ],
  } as unknown as VideoStoryboard;

  it("collects narration and visual prompts", () => {
    const texts = storyboardComplianceTexts(board);
    expect(texts.map((t) => t.field)).toEqual(["spoken", "visual"]);
  });

  it("checks guided-story English meanings", () => {
    const texts = guidedScriptComplianceTexts({
      version: 1,
      title: "t",
      logline: "",
      runtimeSeconds: 10,
      roles: [],
      warnings: [],
      scenes: [
        {
          id: "a", startMs: 0, endMs: 1000, visualDirection: "clinic", roleIds: [],
          lines: [{ id: "l", ownerRoleId: null, kind: "narration", text: "100% गारंटी", englishTranslation: "100% guaranteed cure", startMs: 0, endMs: 1000 }],
        },
      ],
    });
    const report = checkCompliance(texts, resolveCompliance(payload("Doctor")))!;
    expect(report.findings.some((f) => f.location.includes("English meaning"))).toBe(true);
  });

  it("gates approval: block always, review needs acknowledgement", () => {
    const frozen = freezeCompliance(resolveCompliance(payload("Doctor")), 1) as FrozenJobCompliance;
    expect(storyboardComplianceError(board, frozen)?.code).toBe("compliance_blocked");

    const reviewOnly = { ...board, scenes: [{ ...board.scenes[0], visual: "doctor at desk", text: "Over 500 patients helped." }] } as VideoStoryboard;
    expect(storyboardComplianceError(reviewOnly, frozen)).toBeNull();
    expect(storyboardComplianceError(reviewOnly, frozen, { requireReviewAck: true })?.code).toBe("compliance_review_required");
    expect(storyboardComplianceError(reviewOnly, frozen, { requireReviewAck: true, acknowledged: true })).toBeNull();
    const fp = reviewFingerprint(storyboardComplianceReport(reviewOnly, frozen)!.findings);
    expect(storyboardComplianceError(reviewOnly, { ...frozen, reviewAcknowledgedFingerprint: fp }, { requireReviewAck: true })).toBeNull();
  });

  it("edit gate only rejects newly introduced violations", () => {
    const frozen = freezeCompliance(resolveCompliance(payload("Doctor")), 1);
    const edited = { ...board, scenes: [{ ...board.scenes[0], text: "Acne explained. Book now and get 10% off." }] } as VideoStoryboard;
    const introduced = newBlockingFindings(board, edited, frozen);
    expect(introduced.length).toBeGreaterThan(0);
    expect(introduced.every((f) => f.ruleId !== "nmc.testimonials")).toBe(true);
    expect(newBlockingFindings(board, board, frozen)).toEqual([]);
  });
});

describe("prompts", () => {
  it("injects rules, facts and visual negatives", () => {
    const c = resolveCompliance(payload("Doctor", { profession: "medical", source: "manual", confirmed_at: null, facts, extra_negative_terms: ["miracle"] }));
    const lines = complianceTextConstraints(c).join("\n");
    expect(lines).toContain("REGULATED PROFESSION");
    expect(lines).toContain("TSMC/12345");
    expect(lines).toContain("miracle");
    expect(complianceVisualGuidance(c)).toContain("before/after");
    expect(complianceTextConstraints(null)).toEqual([]);
  });
  it("frozen snapshot round-trips into the script hint", () => {
    const frozen = freezeCompliance(resolveCompliance(payload("CA")), null);
    expect(frozen?.packId).toBe(ICAI_RULE_PACK.id);
    expect(thawCompliance(frozen)?.extraNegativeTerms).toContain("cheap");
    expect(withComplianceVoice("Voice: warm.", frozen)).toMatch(/^Voice: warm\.\n\nREGULATED PROFESSION/);
    expect(withComplianceVoice("Voice: warm.", null)).toBe("Voice: warm.");
  });
  it("every rule pattern compiles with the g flag", () => {
    for (const pack of [NMC_RULE_PACK, ICAI_RULE_PACK]) {
      for (const rule of pack.rules) for (const p of rule.patterns) expect(() => new RegExp(p.source, `${p.flags}g`)).not.toThrow();
    }
  });
});
