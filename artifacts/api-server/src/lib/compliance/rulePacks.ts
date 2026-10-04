import type { ComplianceProfession } from "@workspace/db";

/**
 * Profession advertising rule packs (NMC for doctors, ICAI for chartered
 * accountants).
 *
 * Each rule does three jobs:
 *   1. `instruction` — injected into every script / caption / visual prompt so
 *      the model is told the rule up front;
 *   2. `patterns`   — a deterministic negative list run over the generated
 *      script, dialogue, on-screen text AND visual prompts before anything is
 *      approved or rendered;
 *   3. `severity`   — "block" findings must be edited out; "review" findings
 *      need a human to tick "I have reviewed these" before approval.
 *
 * Patterns run on normalised text (lower-case, straight quotes, collapsed
 * whitespace) and are deliberately broad so common paraphrases are caught.
 * They are a floor, not a guarantee: a model can still phrase a prohibited
 * claim in a way no list anticipates, which is why storyboard review stays
 * mandatory for regulated kits.
 *
 * LEGAL REVIEW: these packs are an engineering translation of the sources
 * listed on each pack. Bump `version` whenever a rule changes — every video
 * job freezes the pack id + version it was planned under.
 */

export type ComplianceField = "spoken" | "on_screen" | "visual" | "caption";
export type ComplianceSeverity = "block" | "review";

export interface ComplianceRule {
  id: string;
  title: string;
  /** Regulation / clause the rule is derived from. */
  source: string;
  severity: ComplianceSeverity;
  /** Prompt instruction; phrased as a direct rule for the model. */
  instruction: string;
  patterns: RegExp[];
  /** Which content the patterns run over. */
  fields: ComplianceField[];
  /** Skip the rule when the kit's verified facts make the claim legitimate. */
  waivedBy?: "qualifications";
}

export interface ComplianceSource {
  title: string;
  url: string | null;
  note?: string;
}

export interface ComplianceRulePack {
  id: string;
  version: string;
  profession: ComplianceProfession;
  label: string;
  regulator: string;
  summary: string;
  sources: ComplianceSource[];
  rules: ComplianceRule[];
  /** Appended to every visual / image / B-roll prompt. */
  visualNegatives: string[];
}

const ALL_TEXT: ComplianceField[] = ["spoken", "on_screen", "caption"];
const EVERYWHERE: ComplianceField[] = ["spoken", "on_screen", "caption", "visual"];

// Shared phrase fragments (used by both packs).
const GUARANTEE = [
  /\bguarantee(d|s)?\b/,
  /\b100\s*%\s*(success|safe|results?|cure|effective|guaranteed|accurate|refund|approval)\b/,
  /\b(assured|sure[- ]?shot|certain|definite|promised?)\s+(results?|outcomes?|success|cure|refund|savings?|approval)\b/,
  /\b(risk[- ]free|zero[- ]risk|no[- ]risk)\b/,
  /\b(results?|success|cure)\s+(is|are)\s+(assured|certain|guaranteed)\b/,
  /\bnever\s+fails?\b/,
  /\bwork(s)?\s+every\s+time\b/,
];

const SUPERIORITY = [
  /\b(the\s+)?(best|no\.?\s*1|number\s*(one|1)|#\s*1|top[- ]?(rated|ranked|most)?|leading|finest|foremost|most\s+(trusted|experienced|successful|renowned|famous))\s+(doctor|physician|surgeon|specialist|dermatologist|gynaecologist|gynecologist|ivf|fertility|clinic|hospital|centre|center|ca|chartered\s+accountant|accountant|firm|tax\s+consultant|auditor|practice|expert)\b/,
  /\b(better|more\s+(experienced|qualified|successful))\s+than\s+(other|any|all)\b/,
  /\b(only|first)\s+(doctor|clinic|hospital|centre|center|ca|firm)\s+(in|to|that|who)\b/,
  /\bunmatched\b|\bunrivall?ed\b|\bsecond\s+to\s+none\b|\bworld[- ]class\b|\bbest[- ]in[- ](class|town|city|india)\b/,
];

const TESTIMONIAL = [
  /\btestimonials?\b/,
  /\b(patient|client|customer)s?\s+(reviews?|stories|story|feedback|says?|said|speak|ratings?)\b/,
  /\b(\d(\.\d)?\s*[- ]?stars?|five[- ]star|5[- ]star)\b/,
  /\b(happy|satisfied|thousands\s+of|lakhs?\s+of|hundreds\s+of)\s+(patients|clients|customers|families|couples)\b/,
  /\b(here'?s\s+what|hear\s+what|listen\s+to\s+what)\s+.{0,30}\b(say|said)\b/,
  /\b(endorsed|recommended)\s+by\b/,
];

const INDUCEMENT = [
  /\b\d{1,2}\s*%\s*(off|discount|cashback)\b/,
  /\b(discount|cashback|coupon|promo\s*code|offer\s+price|special\s+offer|festive\s+offer|limited[- ]period\s+offer|combo\s+offer|package\s+deal)s?\b/,
  /\bfree\s+(consultation|consult|check[- ]?up|camp|session|trial|scan|test|filing|itr|gst\s+registration|audit)\b/,
  /\b(hurry|limited\s+(slots|seats|time)|book\s+(now|today)\s+(and|to)\s+(get|save)|offer\s+(ends|valid))\b/,
  /\bbuy\s+one\b|\b(emi|no[- ]cost\s+emi)\b/,
];

const SOLICIT_URGENCY = [
  /\b(call|whatsapp|dm|message|book|visit)\s+(us\s+)?(now|today|immediately|right\s+away)\b/,
  /\bdon'?t\s+(wait|delay|miss)\b/,
  /\bbefore\s+it'?s\s+too\s+late\b/,
  /\b(act|hurry)\s+(now|fast)\b/,
];

const AWARDS = [
  /\baward[- ]?winning\b|\bawarded\b|\bawards?\b/,
  /\b(ranked|rated)\s+(#?\s*\d|number|no\.?|among|top)\b/,
  /\bas\s+(seen|featured)\s+(on|in)\b/,
];

const NUMERIC_CLAIM = [
  /\b\d[\d,]*\s*\+?\s*(patients|surgeries|procedures|deliveries|babies|cycles|transplants|clients|returns|audits|cases)\b/,
  /\b\d{1,3}(\.\d)?\s*%\s*(success|pregnancy|conception|accuracy|recovery|satisfaction|approval|refund)\b/,
  /\b(success|pregnancy|recovery|approval)\s+rates?\s+(of|is|above|over)\s+\d/,
  /\b\d{1,2}\s*\+?\s*years?\s+(of\s+)?(experience|practice|in\s+practice)\b/,
];

const NMC_PACK_2026_10_1: ComplianceRulePack = {
  id: "nmc-medical-advertising",
  version: "2026.10.1",
  profession: "medical",
  label: "Doctor (NMC)",
  regulator: "National Medical Commission",
  summary:
    "Educational, non-promotional content only: no soliciting patients, no guarantees, no testimonials or patient images, no superiority claims, no inducements, no claims beyond the doctor's verified facts.",
  sources: [
    {
      title:
        "Indian Medical Council (Professional Conduct, Etiquette and Ethics) Regulations, 2002 — Ch. 6 (Unethical acts: 6.1 advertising/soliciting), 1.4 (registration display), 7.20 (specialist claims)",
      url: "https://nmc.org.in/page/rules-regulations-rules-regulations-of-erstwhile-mci-code-of-medical-ethics-regulations-2002",
      note:
        "In force: NMC placed the RMP (Professional Conduct) Regulations, 2023 in abeyance on 23 Aug 2023 and directed that the 2002 Regulations continue. Re-check before each pack version bump.",
    },
    {
      title: "Drugs and Magic Remedies (Objectionable Advertisements) Act, 1954",
      url: null,
      note: "No advertisement claiming to cure / treat scheduled diseases and conditions.",
    },
    {
      title:
        "CCPA Guidelines for Prevention of Misleading Advertisements and Endorsements for Misleading Advertisements, 2022",
      url: null,
    },
    {
      title: "PC&PNDT Act, 1994 and ART (Regulation) Act, 2021 (IVF / fertility content)",
      url: null,
      note: "No sex selection; no outcome promises for ART services.",
    },
  ],
  rules: [
    {
      id: "nmc.guarantee",
      title: "No guaranteed results or cures",
      source: "IMC Regs 2002 §6.1; DMR Act 1954; CCPA Guidelines 2022",
      severity: "block",
      instruction:
        "Never promise, guarantee or imply certain results, cures, success rates or risk-free treatment. Describe outcomes as varying from person to person.",
      patterns: [
        ...GUARANTEE,
        /\b(permanent|complete|total|instant|overnight|miracle|magic)\s+(cure|solution|relief|results?|fix)\b/,
        /\b(no|zero)\s+side[- ]?effects?\b/,
        /\b(100\s*%|completely)\s+(painless|safe)\b/,
        /\bget\s+pregnant\s+(guaranteed|for\s+sure)\b|\bbaby\s+(guaranteed|assured)\b|\btake[- ]home[- ]baby\s+(guarantee|assured)\b/,
      ],
      fields: EVERYWHERE,
    },
    {
      id: "nmc.dmr_cure_claims",
      title: "No cure claims for scheduled diseases",
      source: "Drugs and Magic Remedies (Objectionable Advertisements) Act, 1954 — Schedule",
      severity: "block",
      instruction:
        "Do not claim to cure, reverse or permanently treat diseases such as cancer, diabetes, obesity, infertility/sterility, impotence, arthritis, asthma, heart disease, hair loss/baldness or skin-colour change. Talk about awareness, prevention and when to see a doctor instead.",
      patterns: [
        /\b(cure[sd]?|curing|reverse[sd]?|reversing|eliminate[sd]?|get\s+rid\s+of|end)\s+(your\s+|the\s+)?(cancer|diabetes|obesity|infertility|sterility|impotence|erectile\s+dysfunction|arthritis|asthma|heart\s+disease|baldness|hair\s+loss|psoriasis|vitiligo|leucoderma|thyroid|pcos|pcod|epilepsy|paralysis)\b/,
        /\b(cancer|diabetes|obesity|infertility|baldness|psoriasis|vitiligo|pcos|pcod|thyroid)\s+(cure|reversal|free\s+forever)\b/,
        /\b(fair(er)?\s+skin|skin\s+whitening|whiten(ing)?\s+your\s+skin|fairness\s+treatment)\b/,
      ],
      fields: EVERYWHERE,
    },
    {
      id: "nmc.superiority",
      title: "No superiority or self-aggrandising claims",
      source: "IMC Regs 2002 §6.1.1",
      severity: "block",
      instruction:
        "Never call the doctor or clinic the best, No.1, top, leading, only or better than others, and never compare with other doctors or clinics.",
      patterns: [...SUPERIORITY, ...AWARDS],
      fields: EVERYWHERE,
    },
    {
      id: "nmc.testimonials",
      title: "No patient testimonials, reviews or endorsements",
      source: "IMC Regs 2002 §6.1.1; CCPA Guidelines 2022 (endorsements)",
      severity: "block",
      instruction:
        "Do not include patient testimonials, reviews, star ratings, success stories, patient counts or third-party endorsements, and do not script any character as a patient praising the doctor.",
      patterns: TESTIMONIAL,
      fields: EVERYWHERE,
    },
    {
      id: "nmc.patient_identity",
      title: "No patient images, before/after or case details",
      source: "IMC Regs 2002 §§2.2, 6.1.1 (confidentiality, publicity)",
      severity: "block",
      instruction:
        "Never show or describe identifiable patients, before/after comparisons, real case photos, scans or reports. Use neutral illustrative visuals or the doctor only.",
      patterns: [
        /\bbefore\s*(and|&|\/|-|vs\.?)\s*after\b/,
        /\b(real|actual)\s+(patient|case|results?)\b/,
        /\bpatient'?s?\s+(face|photo|photograph|picture|name|report|scan|x-?ray)\b/,
        /\b(case\s+study|my\s+patient\s+\w+)\b/,
      ],
      fields: EVERYWHERE,
    },
    {
      id: "nmc.inducements",
      title: "No discounts, offers or free-service inducements",
      source: "IMC Regs 2002 §6.1 (soliciting patients); CCPA Guidelines 2022",
      severity: "block",
      instruction:
        "Do not mention discounts, offers, cashback, free consultations or camps, EMI, limited slots or any inducement to choose this doctor.",
      patterns: INDUCEMENT,
      fields: ALL_TEXT,
    },
    {
      id: "nmc.solicitation",
      title: "No pressure-selling calls to action",
      source: "IMC Regs 2002 §6.1.1 (soliciting patients directly or indirectly)",
      severity: "block",
      instruction:
        "End with a neutral, educational call to action (e.g. 'consult a qualified doctor if you have these symptoms'). No urgency or pressure ('call now', 'don't wait', 'book today').",
      patterns: SOLICIT_URGENCY,
      fields: ALL_TEXT,
    },
    {
      id: "nmc.fees",
      title: "Fees and prices need review",
      source: "IMC Regs 2002 §§6.1, 7.12",
      severity: "review",
      instruction: "Do not state fees, prices or package costs.",
      patterns: [/(₹|rs\.?|inr)\s*\d|\b\d[\d,]*\s*(rupees|\/-)|\b(fees?|price|pricing|cost|charges)\s+(of|is|are|starting|start|only|just)\b/],
      fields: ALL_TEXT,
    },
    {
      id: "nmc.specialist_claims",
      title: "Specialist titles must match recognised qualifications",
      source: "IMC Regs 2002 §§1.1.3, 7.20",
      severity: "review",
      instruction:
        "Use only the qualifications and titles listed in the verified facts. Never invent degrees, fellowships, 'specialist', 'expert' or 'super-specialist' titles.",
      patterns: [/\bsuper[- ]?speciali[sz]t\b/, /\b(speciali[sz]t|expert)\b/],
      fields: ALL_TEXT,
      waivedBy: "qualifications",
    },
    {
      id: "nmc.unverified_numbers",
      title: "Statistics and experience claims must be in verified facts",
      source: "CCPA Guidelines 2022 (substantiation); IMC Regs 2002 §6.1.1",
      severity: "review",
      instruction:
        "Do not state success rates, patient/procedure counts or years of experience unless they appear word-for-word in the verified facts.",
      patterns: NUMERIC_CLAIM,
      fields: ALL_TEXT,
    },
    {
      id: "nmc.sex_selection",
      title: "No sex selection or gender preference",
      source: "PC&PNDT Act, 1994",
      severity: "block",
      instruction: "Never mention or imply choosing, predicting or revealing the sex of a baby.",
      patterns: [
        /\b(sex|gender)\s+(selection|determination|prediction|choice)\b/,
        /\b(choose|select|guarantee)\s+(a\s+|the\s+)?(baby\s+)?(boy|girl|gender|sex)\b/,
        /\b(baby\s+boy|male\s+child)\s+(guaranteed|assured|treatment)\b/,
      ],
      fields: EVERYWHERE,
    },
    {
      id: "nmc.drug_endorsement",
      title: "No endorsing drug, device or product brands",
      source: "IMC Regs 2002 §6.8 (relationship with pharmaceutical industry)",
      severity: "review",
      instruction:
        "Do not name or endorse branded medicines, devices or commercial products; use generic names only.",
      patterns: [/\b(i|we)\s+(recommend|prescribe|endorse|swear\s+by|use\s+only)\s+(this|the|brand|[a-z]+®)\b/, /\buse\s+code\b/],
      fields: ALL_TEXT,
    },
  ],
  visualNegatives: [
    "no real or identifiable patients",
    "no before/after comparisons",
    "no patient faces, names, scans, reports or case photos",
    "no testimonials, review cards or star ratings",
    "no awards, trophies, certificates, rankings or 'No.1' signage",
    "no on-screen prices, discounts or offer banners",
    "no readable text, logos, degrees or signage generated in the image",
    "no graphic surgical gore",
    "no babies labelled by sex",
  ],
};

const ICAI_PACK_2026_10_1: ComplianceRulePack = {
  id: "icai-ca-advertising",
  version: "2026.10.1",
  profession: "chartered_accountant",
  label: "Chartered Accountant (ICAI)",
  regulator: "Institute of Chartered Accountants of India",
  summary:
    "Knowledge-sharing content only: no soliciting clients, no client names, no fees or offers, no testimonials, no superiority or awards, no guaranteed outcomes, no contingent fees.",
  sources: [
    {
      title:
        "Chartered Accountants Act, 1949 — First Schedule, Part I, Clause (6) (soliciting clients) and Clause (7) (advertising), Clause (10) (contingent fees)",
      url: "https://www.icai.org/",
    },
    {
      title:
        "ICAI Guidelines for Advertisement for Members in Practice, No.1-CA(7)/Council Guidelines/01/2008 (14 May 2008)",
      url: "https://taxguru.in/chartered-accountant/guidelines-for-advertisement-for-the-members-in-practice.html",
      note:
        "Permits name, designation, membership/firm reg. no., qualifications, contact details, CA logo and services; prohibits testimonials, superiority claims, client names and achievements/awards.",
    },
    {
      title: "ICAI Code of Ethics and Guidelines for Website of Members/Firms",
      url: null,
    },
  ],
  rules: [
    {
      id: "icai.solicitation",
      title: "No soliciting clients or pressure calls to action",
      source: "CA Act 1949, Sch. I Pt. I Cl. (6)",
      severity: "block",
      instruction:
        "Do not solicit work. No 'hire us', 'call now', 'contact us to get your ITR/GST done' or urgency. A neutral sign-off with the member's name and designation is allowed.",
      patterns: [
        ...SOLICIT_URGENCY,
        /\b(hire|choose|appoint|engage)\s+(us|me|our\s+firm)\b/,
        /\b(contact|call|whatsapp|dm|message)\s+(us|me)\s+(for|to\s+get|to\s+file|today)\b/,
        /\b(get|file)\s+your\s+(itr|returns?|gst|audit|taxes)\s+(filed|done)\s+(by|with|at)\s+(us|me)\b/,
      ],
      fields: ALL_TEXT,
    },
    {
      id: "icai.client_names",
      title: "No client names (past or present)",
      source: "ICAI Advertisement Guidelines 2008",
      severity: "block",
      instruction: "Never name, hint at or show logos of clients, past or present.",
      patterns: [
        /\b(our|my)\s+(clients?|portfolio)\s+(include|includes|like|such\s+as|are)\b/,
        /\b(trusted|used|chosen)\s+by\s+(leading|top|\d|many|hundreds|thousands)\b/,
        /\bclient\s+logos?\b/,
      ],
      fields: EVERYWHERE,
    },
    {
      id: "icai.testimonials",
      title: "No testimonials or endorsements",
      source: "ICAI Advertisement Guidelines 2008",
      severity: "block",
      instruction:
        "Do not include testimonials, reviews, ratings, client stories or endorsements, and do not script a character praising the CA.",
      patterns: TESTIMONIAL,
      fields: EVERYWHERE,
    },
    {
      id: "icai.superiority",
      title: "No superiority claims, awards or achievements",
      source: "ICAI Advertisement Guidelines 2008; CA Act Cl. (7)",
      severity: "block",
      instruction:
        "Never claim to be the best, top, leading or better than other CAs/firms, and do not mention awards, rankings, achievements or positions held.",
      patterns: [...SUPERIORITY, ...AWARDS],
      fields: EVERYWHERE,
    },
    {
      id: "icai.fees_offers",
      title: "No fees, prices, discounts or free services",
      source: "ICAI Advertisement Guidelines 2008 (permitted particulars only); CA Act Cl. (6)/(7)",
      severity: "block",
      instruction: "Do not mention fees, prices, discounts, offers, packages or free services.",
      patterns: [
        ...INDUCEMENT,
        /(₹|rs\.?|inr)\s*\d|\b\d[\d,]*\s*(rupees|\/-)/,
        /\b(fees?|price|pricing|charges)\s+(of|is|are|starting|start|only|just|from)\b|\bstarting\s+(at|from)\b/,
        /\b(lowest|cheapest|affordable)\s+(fees?|price|charges|rates?)\b/,
      ],
      fields: ALL_TEXT,
    },
    {
      id: "icai.contingent_fees",
      title: "No contingent / percentage-of-result fees",
      source: "CA Act 1949, Sch. I Pt. I Cl. (10)",
      severity: "block",
      instruction: "Never offer fees contingent on results or based on a percentage of refunds, savings or profits.",
      patterns: [
        /\bno\s+(win|result|refund|saving)s?,?\s+no\s+(fee|pay|charge)\b/,
        /\b\d{1,2}\s*%\s+of\s+(your\s+)?(refund|savings?|profits?|recovery)\b/,
        /\bpay\s+only\s+(if|when|after)\b/,
      ],
      fields: ALL_TEXT,
    },
    {
      id: "icai.guarantee",
      title: "No guaranteed outcomes",
      source: "CA Act Cl. (7); CCPA Guidelines 2022",
      severity: "block",
      instruction:
        "Never guarantee refunds, savings, approvals, notice-free assessments or any tax/audit outcome.",
      patterns: [
        ...GUARANTEE,
        /\b(zero|no)\s+(tax|income\s+tax)\s+(liability|payable|to\s+pay)\b/,
        /\b(never|no)\s+(get\s+)?(a\s+)?(tax\s+)?notices?\s+(again|ever|guaranteed)\b/,
        /\bmaximum\s+refund\b/,
      ],
      fields: EVERYWHERE,
    },
    {
      id: "icai.tax_evasion",
      title: "No advice framed as evading tax",
      source: "ICAI Code of Ethics (professional behaviour, integrity)",
      severity: "block",
      instruction:
        "Frame tax content as lawful planning and compliance. Never suggest hiding income, evading tax or escaping scrutiny.",
      patterns: [
        /\b(evade|evading|dodge|dodging|escape|beat)\s+(the\s+)?(tax|taxes|income\s+tax|gst|it\s+department|scrutiny)\b/,
        /\bhide\s+(your\s+)?(income|money|cash)\b|\bblack\s+money\b|\bcash\s+without\s+(bill|invoice)\b/,
      ],
      fields: ALL_TEXT,
    },
    {
      id: "icai.unverified_numbers",
      title: "Statistics and experience claims must be in verified facts",
      source: "ICAI Advertisement Guidelines 2008; CCPA Guidelines 2022",
      severity: "review",
      instruction:
        "Do not state client counts, returns filed, refund amounts or years of experience unless they appear word-for-word in the verified facts.",
      patterns: NUMERIC_CLAIM,
      fields: ALL_TEXT,
    },
  ],
  visualNegatives: [
    "no client names or client logos",
    "no testimonials, review cards or star ratings",
    "no awards, trophies, rankings or 'No.1' signage",
    "no on-screen fees, prices, discounts or offer banners",
    "no readable financial documents, tax returns, PAN/Aadhaar cards or account numbers",
    "no readable text, logos or signage generated in the image",
    "no piles of cash",
  ],
};

// Published rule versions remain immutable and loadable for in-flight jobs.
function freezePack(pack: ComplianceRulePack): ComplianceRulePack {
  for (const rule of pack.rules) {
    Object.freeze(rule.patterns);
    Object.freeze(rule.fields);
    Object.freeze(rule);
  }
  Object.freeze(pack.rules);
  Object.freeze(pack.sources);
  Object.freeze(pack.visualNegatives);
  return Object.freeze(pack);
}

function extendPack(
  base: ComplianceRulePack,
  version: string,
  extraPatterns: Record<string, RegExp[]>,
): ComplianceRulePack {
  for (const id of Object.keys(extraPatterns)) {
    if (!base.rules.some((rule) => rule.id === id)) throw new Error(`Unknown rule ${id} in ${base.id}@${version}`);
  }
  return freezePack({
    ...base,
    version,
    sources: [...base.sources],
    visualNegatives: [...base.visualNegatives],
    rules: base.rules.map((rule) => ({
      ...rule,
      fields: [...rule.fields],
      patterns: [...rule.patterns, ...(extraPatterns[rule.id] ?? [])],
    })),
  });
}

// Native-script patterns intentionally avoid ASCII-only word boundaries.
const INDIC_GUARANTEE = [
  /गारंटी|गैरंटी|पक्का\s*इलाज|100\s*%\s*(इलाज|सफलता|रिज़ल्ट|रिजल्ट)|గ్యారంటీ|గ్యారెంటీ|హామీ\s*ఇస్తా|உத்தரவாதம்|கியாரண்டி|கேரண்டி/u,
  /\bpakk?a\s+ilaa?j\b|\b100\s*%\s*ilaa?j\b|\bguarantee\s+(ke\s+saath|hai|denge)\b/,
];
const INDIC_CURE = [
  /(कैंसर|डायबिटीज|डायबिटीज़|मधुमेह|मोटापा|मोटापे|बांझपन|निःसंतानता|गंजापन|गंजेपन|सफेद\s*दाग|सोरायसिस|थायराइड|पीसीओडी|पीसीओएस)\s*(का|की|के)?\s*(पक्का|स्थायी|पूरा|जड़\s*से)?\s*(इलाज|खात्मा)/u,
  /(క్యాన్సర్|మధుమేహం|డయాబెటిస్|షుగర్|ఊబకాయం|సంతానలేమి|బట్టతల|సొరియాసిస్).{0,15}(నయం|శాశ్వత\s*పరిష్కారం)/u,
  /(புற்றுநோய்|நீரிழிவு|சர்க்கரை\s*நோய்|உடல்\s*பருமன்|மலட்டுத்தன்மை|வழுக்கை|சொரியாசிஸ்).{0,20}(குணப்படுத்த|குணமாக்க|நிரந்தர\s*தீர்வு)/u,
  /\b(sugar|diabetes|cancer|motapa|baanjhpan)\s+(ka|ki|ke)\s+(pakka\s+|permanent\s+)?ilaa?j\b/,
];
const INDIC_SUPERIORITY = [
  /सबसे\s*(अच्छा|अच्छे|अच्छी|बेहतरीन|बढ़िया|बड़ा|बड़े)\s*(डॉक्टर|डाक्टर|क्लिनिक|अस्पताल|हॉस्पिटल|सीए|चार्टर्ड)|नंबर\s*(1|१|वन)\s*(डॉक्टर|क्लिनिक|अस्पताल|हॉस्पिटल|सीए)/u,
  /(ఉత్తమ|నంబర్\s*1|నెంబర్\s*1)\s*(డాక్టర్|వైద్యుడు|వైద్యురాలు|క్లినిక్|ఆసుపత్రి|హాస్పిటల్|సీఏ)/u,
  /(சிறந்த|நம்பர்\s*1|நம்பர்\s*ஒன்)\s*(மருத்துவர்|டாக்டர்|மருத்துவமனை|கிளினிக்|ஆடிட்டர்)/u,
  /\bsabse\s+(best|accha|achha|badhiya)\s+(doctor|clinic|hospital|ca)\b/,
];
const INDIC_TESTIMONIAL = [
  /(मरीज़ों|मरीजों|ग्राहकों|क्लाइंट्स)\s*(की|के)\s*(राय|अनुभव|रिव्यू|कहानी)/u,
  /(రోగుల|క్లయింట్ల)\s*(అభిప్రాయ|అనుభవ|రివ్యూ)/u,
  /(நோயாளிகளின்|வாடிக்கையாளர்களின்)\s*(கருத்து|அனுபவ|விமர்சன)/u,
];
const INDIC_INDUCEMENT = [
  /छूट|डिस्काउंट|मुफ़्त|मुफ्त|फ्री\s*(जांच|जाँच|परामर्श|कंसल्टेशन|चेकअप)|ఉచిత|డిస్కౌంట్|తగ్గింపు|இலவச|தள்ளுபடி|டிஸ்கவுண்ட்/u,
  /\b(muft|chhoot|chhut)\b/,
];
const INDIC_SEX_SELECTION = [
  /लड़का\s*(होने|पैदा|पाने)|बेटा\s*(होने|पाने|पैदा)|लिंग\s*(जांच|जाँच|चयन|परीक्षण|निर्धारण)/u,
  /మగ\s*బిడ్డ|లింగ\s*నిర్ధారణ|ஆண்\s*குழந்தை|பாலின\s*(தேர்வு|கண்டறி)/u,
];
const INDIC_TAX_EVASION = [/टैक्स\s*चोरी|कर\s*चोरी|काला\s*धन|బ్లాక్\s*మనీ|పన్ను\s*ఎగవేత|வரி\s*ஏய்ப்பு|கருப்பு\s*பணம்/u];

export const NMC_RULE_PACK_HISTORY: readonly ComplianceRulePack[] = (() => {
  const v1 = freezePack(NMC_PACK_2026_10_1);
  const v2 = extendPack(v1, "2026.10.2", {
    "nmc.guarantee": INDIC_GUARANTEE,
    "nmc.dmr_cure_claims": INDIC_CURE,
    "nmc.superiority": INDIC_SUPERIORITY,
    "nmc.testimonials": INDIC_TESTIMONIAL,
    "nmc.inducements": INDIC_INDUCEMENT,
    "nmc.sex_selection": INDIC_SEX_SELECTION,
  });
  return Object.freeze([v1, v2]);
})();

export const ICAI_RULE_PACK_HISTORY: readonly ComplianceRulePack[] = (() => {
  const v1 = freezePack(ICAI_PACK_2026_10_1);
  const v2 = extendPack(v1, "2026.10.2", {
    "icai.guarantee": INDIC_GUARANTEE,
    "icai.superiority": INDIC_SUPERIORITY,
    "icai.testimonials": INDIC_TESTIMONIAL,
    "icai.fees_offers": INDIC_INDUCEMENT,
    "icai.tax_evasion": INDIC_TAX_EVASION,
  });
  return Object.freeze([v1, v2]);
})();

export const NMC_RULE_PACK = NMC_RULE_PACK_HISTORY[NMC_RULE_PACK_HISTORY.length - 1]!;
export const ICAI_RULE_PACK = ICAI_RULE_PACK_HISTORY[ICAI_RULE_PACK_HISTORY.length - 1]!;
const HISTORY: readonly ComplianceRulePack[] = [...NMC_RULE_PACK_HISTORY, ...ICAI_RULE_PACK_HISTORY];

export function rulePackVersion(id: string, version: string): ComplianceRulePack | null {
  return HISTORY.find((pack) => pack.id === id && pack.version === version) ?? null;
}

export const RULE_PACKS: Record<ComplianceProfession, ComplianceRulePack> = {
  medical: NMC_RULE_PACK,
  chartered_accountant: ICAI_RULE_PACK,
};

export function rulePackFor(profession: ComplianceProfession): ComplianceRulePack {
  return RULE_PACKS[profession];
}

export function rulePackById(id: string): ComplianceRulePack | null {
  return Object.values(RULE_PACKS).find((pack) => pack.id === id) ?? null;
}
