import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  eqValues: [] as Array<[string, unknown]>,
}));

vi.mock("@workspace/db", () => {
  const column = (name: string) => ({ name });
  const table = new Proxy({}, { get: (_target, property) => column(String(property)) });
  const terminal: Record<string, unknown> = {};
  terminal.limit = async () => state.rows.shift() ?? [];
  terminal.orderBy = () => terminal;
  terminal.where = () => terminal;
  terminal.leftJoin = () => terminal;
  terminal.from = () => terminal;
  const query = () => terminal;
  return {
    db: { select: () => query() },
    assetProvenanceTable: table,
    characterLikenessConsentGrantsTable: table,
    characterLikenessConsentRevocationsTable: table,
    characterLikenessRecipientDisclosuresTable: table,
    characterLikenessRecipientRevocationsTable: table,
    tenantLikenessStandingDeclarationsTable: table,
    charactersTable: table,
    characterOutfitsTable: table,
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  desc: (value: unknown) => value,
  isNull: (value: unknown) => value,
  eq: (column: { name: string }, value: unknown) => {
    state.eqValues.push([column.name, value]);
    return [column, value];
  },
}));

vi.mock("../provenancePolicy", async () => {
  const { resolveLikenessRouting } = await import("../likenessProviderPolicy");
  type Source = { referenceSource: string };
  return {
    isPersonalLikenessSource: (c: Source) => c.referenceSource === "uploaded",
    requiresPerCharacterAttestation: (c: Source) => c.referenceSource === "uploaded",
    requiresStandingDeclaration: (c: Source) => c.referenceSource === "generated",
    routingSubjectClassFor: (c: Source) =>
      c.referenceSource === "uploaded" ? "uploaded_self" : "generated_fictional",
    standingDeclarationEnforced: () => false,
    isLikenessEligibleVideoTarget: (
      provider: string | null,
      model: string | null,
      subjectClass: "uploaded_self" | "uploaded_authorized_person" | "generated_fictional",
    ) =>
      resolveLikenessRouting({
        surface: "video",
        provider,
        model,
        operation: "video",
        subjectClass,
      }).allowed,
  };
});

import {
  assertFrozenPersonalWanVideoConsent,
  freezePersonalWanVideoConsent,
  isFrozenPersonalWanGuidedCast,
  PersonalLikenessVideoError,
} from "./personalLikenessVideo";

const TENANT = 42;
const CHARACTER_ID = 17;
const OUTFIT_ID = 91;
const CHAR_PATH = `/objects/${TENANT}/uploads/person.png`;
const OUTFIT_PATH = `/objects/${TENANT}/uploads/person-wardrobe.png`;
const SHEET_PATH = `/objects/${TENANT}/uploads/person-sheet.png`;
const CHAR_SHA = "a".repeat(64);
const OUTFIT_SHA = "b".repeat(64);
const SHEET_SHA = "c".repeat(64);
const MODEL = "alibaba/wan-3.0/reference-to-video" as const;

const ancestry = {
  parents: [{
    kind: "character_reference" as const,
    path: CHAR_PATH,
    sha256: CHAR_SHA,
    characterId: CHARACTER_ID,
  }],
  referenceSource: "uploaded" as const,
  capturedAt: "2026-01-01T00:00:00.000Z",
};

function asset(
  id: number,
  assetKind: "character_reference" | "character_outfit" | "reference_sheet",
  artifactPath: string,
  artifactSha256: string,
  sourceKind: "upload" | "imageedit",
) {
  return {
    id,
    tenantId: TENANT,
    assetKind,
    operationIdentity: `operation:${id}`,
    artifactPath,
    artifactSha256,
    sourceKind,
    provider: sourceKind === "upload" ? null : "replicate",
    model: sourceKind === "upload" ? null : "trusted-image-edit",
    parentPath: sourceKind === "upload" ? null : CHAR_PATH,
    parentSha256: sourceKind === "upload" ? null : CHAR_SHA,
    inputAncestry: sourceKind === "upload"
      ? { parents: [], referenceSource: "uploaded", capturedAt: ancestry.capturedAt }
      : ancestry,
    characterId: CHARACTER_ID,
    outfitId: assetKind === "character_outfit" ? OUTFIT_ID : null,
  };
}

const characterEvidence = asset(101, "character_reference", CHAR_PATH, CHAR_SHA, "upload");
const outfitEvidence = asset(102, "character_outfit", OUTFIT_PATH, OUTFIT_SHA, "imageedit");
const sheetEvidence = asset(103, "reference_sheet", SHEET_PATH, SHEET_SHA, "imageedit");

function proof(row: ReturnType<typeof asset>) {
  return {
    provenanceRecordId: row.id,
    assetKind: row.assetKind,
    operationIdentity: row.operationIdentity,
    artifactPath: row.artifactPath,
    artifactSha256: row.artifactSha256,
    sourceKind: row.sourceKind,
    provider: row.provider,
    model: row.model,
    parentPath: row.parentPath,
    parentSha256: row.parentSha256,
    inputAncestry: row.inputAncestry,
  };
}

const character = {
  id: CHARACTER_ID,
  tenantId: TENANT,
  referenceSource: "uploaded",
  referenceImagePath: CHAR_PATH,
  referenceSheetImagePath: SHEET_PATH,
  referenceSheetStatus: "approved",
  referenceSheetApprovedSha256: SHEET_SHA,
};
const outfit = {
  id: OUTFIT_ID,
  tenantId: TENANT,
  characterId: CHARACTER_ID,
  referenceImagePath: OUTFIT_PATH,
  status: "approved",
  identityVerified: true,
  canonicalReferenceImagePath: CHAR_PATH,
};
const approval = {
  character: { referenceImagePath: CHAR_PATH, sha256: CHAR_SHA },
  outfit: { referenceImagePath: OUTFIT_PATH, sha256: OUTFIT_SHA },
};
const grant = {
  id: 811,
  tenantId: TENANT,
  characterId: CHARACTER_ID,
  sourceReferenceSource: "uploaded",
  sourcePath: CHAR_PATH,
  sourceSha256: CHAR_SHA,
  subjectClass: "uploaded_self",
  policyVersion: "2026-09-18",
  imageRightsConfirmed: true,
  adultConfirmed: true,
  likenessConfirmed: true,
  writtenPermissionConfirmed: true,
  allowOutfitEdits: true,
  allowVideoDepiction: true,
  allowScriptedSpeech: true,
};

const disclosure = {
  id: 601,
  tenantId: TENANT,
  characterId: CHARACTER_ID,
  consentId: 811,
  provider: "atlascloud",
  model: MODEL,
  operation: "video",
};

function member(extra: Record<string, unknown> = {}) {
  return {
    roleId: "hero",
    source: "saved",
    referenceSource: "uploaded",
    characterId: CHARACTER_ID,
    outfitId: OUTFIT_ID,
    character: { referenceImagePath: CHAR_PATH },
    outfit: { referenceImagePath: OUTFIT_PATH },
    provenanceEvidenceRefs: [
      proof(characterEvidence), proof(outfitEvidence), proof(sheetEvidence),
    ],
    ...extra,
  } as any;
}

function freezeInput(extra: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT, provider: "atlascloud", model: MODEL,
    character, outfit, member: member(), approval,
    characterSha256: CHAR_SHA, outfitSha256: OUTFIT_SHA,
    referenceSheetSha256: SHEET_SHA, scriptedSpeech: false,
    ...extra,
  } as any;
}

/** currentPolicyVersion, then latestGrant + revocation + disclosure, then proofs. */
function frozenRows(overrides: { grant?: unknown; disclosure?: unknown } = {}) {
  const g = overrides.grant === undefined ? grant : overrides.grant;
  const d = overrides.disclosure === undefined ? disclosure : overrides.disclosure;
  return [
    g ? [g] : [],
    g ? [g] : [],
    [],
    d ? [{ disclosure: d }] : [],
    [characterEvidence], [outfitEvidence], [sheetEvidence],
  ];
}

function recheckRows(revocation: unknown[] = []) {
  return [
    [character],
    [grant], revocation, [{ disclosure }],
    [outfit],
    [characterEvidence], [outfitEvidence], [sheetEvidence],
  ];
}

/** Same read order as recheckRows, with the grant row swapped. */
function withRecheckGrant(replacement: unknown) {
  const rows = recheckRows();
  rows[1] = [replacement];
  return rows;
}

/** Same read order as recheckRows, with the character provenance row swapped. */
function withRecheckEvidence(replacement: unknown) {
  const rows = recheckRows();
  rows[5] = [replacement];
  return rows;
}

describe("personal likeness video authorization", () => {
  beforeEach(() => {
    state.rows = [];
    state.eqValues = [];
  });

  it("freezes a valid saved uploaded root with an approved non-alias AI wardrobe and sheet", async () => {
    state.rows = frozenRows();
    const frozen = await freezePersonalWanVideoConsent(freezeInput({ scriptedSpeech: true }));
    expect(frozen).toMatchObject({
      version: 2, provider: "atlascloud", model: MODEL, scriptedSpeech: true,
      subjectClass: "uploaded_self", recipientDisclosureId: disclosure.id,
      consent: { consentId: grant.id, sourcePath: CHAR_PATH, sourceSha256: CHAR_SHA },
      outfit: { id: OUTFIT_ID, referenceImagePath: OUTFIT_PATH, sha256: OUTFIT_SHA },
    });
    expect(state.eqValues).toContainEqual(["tenantId", TENANT]);
  });

  it("rejects missing, revoked, or replacement grants rather than silently changing consent", async () => {
    state.rows = frozenRows({ grant: null });
    await expect(freezePersonalWanVideoConsent(freezeInput()))
      .rejects.toBeInstanceOf(PersonalLikenessVideoError);

    state.rows = frozenRows();
    const frozen = await freezePersonalWanVideoConsent(freezeInput());

    state.rows = recheckRows([{ id: 1 }]);
    await expect(assertFrozenPersonalWanVideoConsent({
      tenantId: TENANT, snapshot: frozen, characterSha256: CHAR_SHA,
      outfitSha256: OUTFIT_SHA, referenceSheetSha256: SHEET_SHA,
    })).rejects.toThrow("withdrawn");

    // A newer grant must never be silently substituted for the one this job
    // was funded against.
    state.rows = withRecheckGrant({ ...grant, id: grant.id + 1 });
    await expect(assertFrozenPersonalWanVideoConsent({
      tenantId: TENANT, snapshot: frozen, characterSha256: CHAR_SHA,
      outfitSha256: OUTFIT_SHA, referenceSheetSha256: SHEET_SHA,
    })).rejects.toThrow("no longer current");
  });

  it("denies source, parent/proof, tenant, model, and missing scope mismatches", async () => {
    state.rows = frozenRows({ grant: { ...grant, sourceSha256: "d".repeat(64) } });
    await expect(freezePersonalWanVideoConsent(freezeInput()))
      .rejects.toBeInstanceOf(PersonalLikenessVideoError);

    state.rows = frozenRows();
    await expect(freezePersonalWanVideoConsent(freezeInput({
      member: member({
        provenanceEvidenceRefs: [
          proof(characterEvidence),
          { ...proof(outfitEvidence), parentSha256: "e".repeat(64) },
          proof(sheetEvidence),
        ],
      }),
    }))).rejects.toThrow("source, ancestry, tenant, or provider");

    // The Wan-only allowlist now comes from the reviewed provider declaration
    // rather than an inlined branch, and reports itself as such.
    state.rows = frozenRows();
    await expect(freezePersonalWanVideoConsent(freezeInput({
      model: "alibaba/wan-3.0/image-to-video",
    }))).rejects.toThrow("accepts a real likeness only on these exact models");

    // A provider whose classifier refuses photorealistic humans is refused
    // before any funding is reserved, whatever the attestation says.
    state.rows = frozenRows();
    await expect(freezePersonalWanVideoConsent(freezeInput({
      provider: "replicate", model: "wan-video/wan-2.2-i2v-fast",
    }))).rejects.toThrow(/refuses|never receive/);

    state.rows = frozenRows({ grant: { ...grant, allowOutfitEdits: false } });
    await expect(freezePersonalWanVideoConsent(freezeInput()))
      .rejects.toBeInstanceOf(PersonalLikenessVideoError);

    state.rows = frozenRows({ grant: { ...grant, allowVideoDepiction: false } });
    await expect(freezePersonalWanVideoConsent(freezeInput()))
      .rejects.toThrow("video depiction");

    state.rows = frozenRows({ grant: { ...grant, allowScriptedSpeech: false } });
    await expect(freezePersonalWanVideoConsent(freezeInput({ scriptedSpeech: true })))
      .rejects.toThrow("scripted speech");

    // An unacknowledged recipient blocks the submission without touching the
    // attestation, which remains true and reusable.
    state.rows = frozenRows({ disclosure: null });
    await expect(freezePersonalWanVideoConsent(freezeInput()))
      .rejects.toThrow("does not require re-attesting");

    state.rows = frozenRows();
    await expect(freezePersonalWanVideoConsent(freezeInput({
      outfit: { ...outfit, tenantId: TENANT + 1 },
    }))).rejects.toThrow("does not belong to this tenant");
  });

  it("does not authorize generated cast, Seedance, unknown provider aliases, or custom models", async () => {
    await expect(freezePersonalWanVideoConsent(freezeInput({
      character: { ...character, referenceSource: "generated" },
    }))).resolves.toBeNull();
    const frozen = {
      version: 2, provider: "atlascloud", model: MODEL,
      subjectClass: "uploaded_self", recipientDisclosureId: disclosure.id,
      consent: { consentId: grant.id, sourcePath: CHAR_PATH, sourceSha256: CHAR_SHA, policyVersion: grant.policyVersion },
      character: { id: CHARACTER_ID, referenceImagePath: CHAR_PATH, sha256: CHAR_SHA, proof: proof(characterEvidence) },
      outfit: { id: OUTFIT_ID, referenceImagePath: OUTFIT_PATH, sha256: OUTFIT_SHA, proof: proof(outfitEvidence) },
      referenceSheet: { referenceImagePath: SHEET_PATH, sha256: SHEET_SHA, proof: proof(sheetEvidence) },
      scriptedSpeech: false,
    } as any;
    expect(isFrozenPersonalWanGuidedCast({ provider: "atlascloud", model: MODEL, member: member({ personalLikenessVideo: frozen }) })).toBe(true);
    expect(isFrozenPersonalWanGuidedCast({ provider: "atlascloud", model: "seedance-2.5", member: member({ personalLikenessVideo: frozen }) })).toBe(false);
    expect(isFrozenPersonalWanGuidedCast({ provider: "custom", model: MODEL, member: member({ personalLikenessVideo: frozen }) })).toBe(false);
    expect(isFrozenPersonalWanGuidedCast({ provider: "atlascloud", model: `${MODEL}-custom`, member: member({ personalLikenessVideo: frozen }) })).toBe(false);
    expect(isFrozenPersonalWanGuidedCast({ provider: "atlascloud", model: MODEL, member: member({ source: "generated", referenceSource: "generated", personalLikenessVideo: frozen }) })).toBe(false);
  });

  it("fails a recheck when bytes or a tenant-scoped provenance row change", async () => {
    state.rows = frozenRows();
    const frozen = await freezePersonalWanVideoConsent(freezeInput());

    state.rows = recheckRows();
    await expect(assertFrozenPersonalWanVideoConsent({
      tenantId: TENANT, snapshot: frozen, characterSha256: "d".repeat(64),
      outfitSha256: OUTFIT_SHA, referenceSheetSha256: SHEET_SHA,
    })).rejects.toThrow("source or approved references");

    state.rows = withRecheckEvidence({ ...characterEvidence, tenantId: TENANT + 1 });
    await expect(assertFrozenPersonalWanVideoConsent({
      tenantId: TENANT, snapshot: frozen, characterSha256: CHAR_SHA,
      outfitSha256: OUTFIT_SHA, referenceSheetSha256: SHEET_SHA,
    })).rejects.toThrow("source, ancestry, tenant, or provider");
  });

  it("rechecks immediately before every paid scene attempt and prevents the revoked retry dispatch", async () => {
    state.rows = frozenRows();
    const frozen = await freezePersonalWanVideoConsent(freezeInput());
    const paidSubmit = vi.fn();
    const preSubmit = async () => assertFrozenPersonalWanVideoConsent({
      tenantId: TENANT, snapshot: frozen, characterSha256: CHAR_SHA,
      outfitSha256: OUTFIT_SHA, referenceSheetSha256: SHEET_SHA,
    });

    state.rows = recheckRows();
    await preSubmit();
    paidSubmit();
    state.rows = recheckRows([{ id: 1 }]);
    await expect(preSubmit()).rejects.toThrow("No video provider submission was made");
    expect(paidSubmit).toHaveBeenCalledTimes(1);
  });
});