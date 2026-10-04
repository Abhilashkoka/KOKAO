import type {
  BrandCompliance,
  BrandComplianceFacts,
  BrandKitPayload,
  ComplianceProfession,
  FrozenJobCompliance,
} from "@workspace/db";
import { rulePackFor, rulePackVersion, type ComplianceRulePack } from "./rulePacks";
import { ComplianceConfigError } from "./errors";

/**
 * Business/Industry → regulated profession.
 *
 * Medical = NMC-registered modern-medicine practice. Dentistry (Dental
 * Council of India) and AYUSH systems have their own councils and are NOT
 * mapped to the NMC pack — the user can still pick "Doctor (NMC)" manually.
 */
const MEDICAL_PATTERNS: RegExp[] = [
  /\b(doctor|dr\.?|physician|surgeon|clinic|hospital|nursing\s+home|medical\s+practi\w*|medicine)\b/i,
  /\b(MBBS|M\.?B\.?B\.?S|MD|MS|DNB|MCh|DM|FRCS|MRCP)\b/,
  /\b(dermatolog\w*|cosmetolog\w*|trichology|ivf|fertility|infertility|gyn(a)?ecolog\w*|obstetric\w*|cardiolog\w*|orthop(a)?edic\w*|paediatric\w*|pediatric\w*|neurolog\w*|oncolog\w*|psychiatr\w*|radiolog\w*|patholog\w*|urolog\w*|endocrinolog\w*|gastroenterolog\w*|nephrolog\w*|pulmonolog\w*|ophthalmolog\w*|ent\s+specialist|plastic\s+surg\w*|bariatric|anaesthes\w*|anesthes\w*)\b/i,
];
const MEDICAL_EXCLUDE = /\b(dentist|dental|ayurved\w*|homeopath\w*|homoeopath\w*|unani|siddha|veterinar\w*|vet\b|pharmacy|pharma\b|medical\s+(devices?|equipment|supplies|store|shop|billing|coding|transcription|tourism))\b/i;

const CA_PATTERNS: RegExp[] = [
  /\bchartered\s+accountan(t|ts|cy)\b/i,
  /\bicai\b/i,
  /\bCA\b/, // case-sensitive so "ca" in other words / "California" style text is ignored
  /\bC\.A\.?(?=\s|$)/,
  /\bCA\s+firm\b/i,
];

export function detectProfession(...texts: Array<string | null | undefined>): ComplianceProfession | null {
  const joined = texts.filter((t): t is string => typeof t === "string" && t.trim() !== "").join(" \n ");
  if (!joined) return null;
  if (CA_PATTERNS.some((p) => p.test(joined))) return "chartered_accountant";
  if (MEDICAL_EXCLUDE.test(joined) && !/\b(doctor|physician|surgeon|mbbs)\b/i.test(joined)) return null;
  if (MEDICAL_PATTERNS.some((p) => p.test(joined))) return "medical";
  return null;
}

export function emptyFacts(): BrandComplianceFacts {
  return {
    practitioner_name: "",
    registration_number: "",
    registering_body: "",
    qualifications: [],
    services: [],
    practice_address: "",
    verified_claims: [],
  };
}

export interface EffectiveCompliance {
  profession: ComplianceProfession;
  pack: ComplianceRulePack;
  source: "auto" | "manual";
  confirmed: boolean;
  facts: BrandComplianceFacts;
  extraNegativeTerms: string[];
  /** Brand-level restricted terms, also enforced by the checker. */
  restrictedTerms: string[];
}

function cleanList(list: unknown): string[] {
  return Array.isArray(list)
    ? list.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim())
    : [];
}

function normaliseFacts(facts: Partial<BrandComplianceFacts> | null | undefined): BrandComplianceFacts {
  const base = emptyFacts();
  if (!facts) return base;
  return {
    practitioner_name: facts.practitioner_name?.trim() ?? "",
    registration_number: facts.registration_number?.trim() ?? "",
    registering_body: facts.registering_body?.trim() ?? "",
    qualifications: cleanList(facts.qualifications),
    services: cleanList(facts.services),
    practice_address: facts.practice_address?.trim() ?? "",
    verified_claims: cleanList(facts.verified_claims),
  };
}

/**
 * The compliance profile that actually applies to a brand kit.
 *
 * - Saved profile with a profession → that profession (manual or confirmed).
 * - Saved profile with "none" → only honoured when the user chose it
 *   manually; an auto "none" still re-runs detection.
 * - No saved profile → detect from Business/Industry (+ description), so
 *   kits created before this feature are covered without a re-save.
 */
export function resolveCompliance(
  payload: BrandKitPayload | null | undefined,
  fallbackIndustry?: string | null,
): EffectiveCompliance | null {
  const saved: BrandCompliance | null | undefined = payload?.compliance;
  const restrictedTerms = cleanList(payload?.brand_controls?.restricted_terms);
  if (saved && saved.profession === "none" && saved.source === "manual") return null;
  let profession: ComplianceProfession | null =
    saved && saved.profession !== "none" ? saved.profession : null;
  let source: "auto" | "manual" = saved?.source ?? "auto";
  if (!profession) {
    profession = detectProfession(
      payload?.identity?.industry,
      payload?.identity?.description,
      fallbackIndustry,
    );
    source = "auto";
  }
  if (!profession) return null;
  return {
    profession,
    pack: rulePackFor(profession),
    source,
    confirmed: Boolean(saved?.confirmed_at) && saved?.profession === profession,
    facts: normaliseFacts(saved?.facts),
    extraNegativeTerms: cleanList(saved?.extra_negative_terms),
    restrictedTerms,
  };
}

export function freezeCompliance(
  effective: EffectiveCompliance | null,
  brandKitId: number | null,
  opts: { semanticReviewRequired?: boolean } = {},
): FrozenJobCompliance | null {
  if (!effective) return null;
  return {
    version: 1,
    profession: effective.profession,
    packId: effective.pack.id,
    packVersion: effective.pack.version,
    brandKitId,
    facts: effective.facts,
    extraNegativeTerms: [...new Set([...effective.extraNegativeTerms, ...effective.restrictedTerms])],
    semanticReviewRequired: opts.semanticReviewRequired ?? false,
  };
}

/** Rehydrate a frozen job snapshot into the shape the checker uses. */
export function thawCompliance(frozen: FrozenJobCompliance | null | undefined): EffectiveCompliance | null {
  if (!frozen) return null;
  const pack = rulePackVersion(frozen.packId, frozen.packVersion);
  if (!pack || pack.profession !== frozen.profession) {
    throw new ComplianceConfigError(
      `This video was planned under compliance rules ${frozen.packId}@${frozen.packVersion}, which this server cannot load. Nothing was generated; please start a new video.`,
    );
  }
  return {
    profession: frozen.profession,
    pack,
    source: "manual",
    confirmed: true,
    facts: normaliseFacts(frozen.facts),
    extraNegativeTerms: cleanList(frozen.extraNegativeTerms),
    restrictedTerms: [],
  };
}
