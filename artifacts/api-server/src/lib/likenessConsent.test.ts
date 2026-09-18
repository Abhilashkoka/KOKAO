import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  eqValues: [] as unknown[],
}));

vi.mock("@workspace/db", () => {
  const column = (name: string) => ({ name });
  const table = new Proxy({}, { get: (_target, property) => column(String(property)) });
  const next = async () => state.rows.shift() ?? [];
  // One queue of result sets, drained in call order, whatever the chain shape
  // (plain where, orderBy+limit, or leftJoin for the recipient ledger).
  const terminal: Record<string, unknown> = {};
  terminal.limit = next;
  terminal.orderBy = () => terminal;
  terminal.where = () => terminal;
  terminal.leftJoin = () => terminal;
  terminal.from = () => terminal;
  terminal.then = undefined;
  const query = () => terminal;
  return {
    db: { select: () => query() },
    charactersTable: table,
    characterLikenessConsentGrantsTable: table,
    characterLikenessConsentRevocationsTable: table,
    characterLikenessRecipientDisclosuresTable: table,
    characterLikenessRecipientRevocationsTable: table,
    tenantLikenessStandingDeclarationsTable: table,
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

import {
  assertFrozenPersonalImageConsent,
  evaluateLikenessSubmission,
  freezePersonalImageConsent,
  PersonalLikenessConsentError,
  validateLikenessGrantAttestation,
  hasOnlyLikenessConsentRequestKeys,
} from "./likenessConsent";
import { GrantCharacterLikenessConsentBody } from "@workspace/api-zod";

const sha = "a".repeat(64);
const POLICY = "2026-09-18";

const character = {
  id: 17,
  tenantId: 42,
  referenceImagePath: "/objects/42/uploads/source.png",
  referenceSource: "uploaded",
} as never;

const generated = {
  id: 18,
  tenantId: 42,
  referenceImagePath: "/objects/42/generated/face.png",
  referenceSource: "generated",
} as never;

const grant = {
  id: 91,
  tenantId: 42,
  characterId: 17,
  sourcePath: "/objects/42/uploads/source.png",
  sourceSha256: sha,
  subjectClass: "uploaded_self",
  policyVersion: POLICY,
  allowOutfitEdits: true,
  allowVideoDepiction: true,
  allowScriptedSpeech: false,
};

const disclosure = {
  id: 501,
  tenantId: 42,
  characterId: 17,
  consentId: 91,
  provider: "openai",
  model: "gpt-image-1",
  operation: "outfit",
};

/** Queue for: latestGrant, isGrantRevoked, activeRecipientDisclosure. */
function queueGrantPath(options: {
  grant?: unknown;
  revoked?: boolean;
  disclosure?: unknown;
} = {}) {
  state.rows = [
    options.grant === undefined ? [grant] : (options.grant ? [options.grant] : []),
    options.revoked ? [{ id: 1 }] : [],
    options.disclosure === undefined
      ? [{ disclosure }]
      : (options.disclosure ? [{ disclosure: options.disclosure }] : []),
  ];
}

const baseRequest = {
  tenantId: 42,
  character,
  surface: "image" as const,
  provider: "openai",
  model: "gpt-image-1",
  operation: "outfit" as const,
  sourceSha256: sha,
  policyVersion: POLICY,
  needs: { outfitEdits: true },
};

describe("evaluateLikenessSubmission", () => {
  beforeEach(() => {
    state.rows = [];
    state.eqValues = [];
  });

  it("checks the provider BEFORE the attestation, so a certain rejection is free", async () => {
    // No rows queued at all: a refused provider must not reach the database.
    const decision = await evaluateLikenessSubmission({
      ...baseRequest,
      provider: "replicate",
      model: "google/nano-banana-pro",
    });
    expect(decision).toMatchObject({ status: "blocked", code: "provider_refused" });
    expect(state.eqValues).toEqual([]);
  });

  it("allows a submission with a current grant and an acknowledged recipient", async () => {
    queueGrantPath();
    const decision = await evaluateLikenessSubmission(baseRequest);
    expect(decision).toMatchObject({ status: "allowed" });
    expect(state.eqValues).toContainEqual(["tenantId", 42]);
  });

  it("blocks a missing, stale, or revoked attestation distinctly", async () => {
    state.rows = [[]];
    expect(await evaluateLikenessSubmission(baseRequest)).toMatchObject({
      code: "attestation_missing",
    });

    queueGrantPath();
    expect(
      await evaluateLikenessSubmission({ ...baseRequest, sourceSha256: "b".repeat(64) }),
    ).toMatchObject({ code: "attestation_stale" });

    queueGrantPath();
    expect(
      await evaluateLikenessSubmission({ ...baseRequest, policyVersion: "2020-01-01" }),
    ).toMatchObject({ code: "attestation_stale" });

    queueGrantPath({ revoked: true });
    expect(await evaluateLikenessSubmission(baseRequest)).toMatchObject({
      code: "attestation_revoked",
    });
  });

  it("keeps the three uses separate", async () => {
    queueGrantPath({ grant: { ...grant, allowOutfitEdits: false } });
    expect(await evaluateLikenessSubmission(baseRequest)).toMatchObject({
      code: "use_not_authorized",
      reason: expect.stringContaining("wardrobe"),
    });

    queueGrantPath({ grant: { ...grant, allowVideoDepiction: false } });
    expect(
      await evaluateLikenessSubmission({
        ...baseRequest,
        needs: { videoDepiction: true },
      }),
    ).toMatchObject({ code: "use_not_authorized", reason: expect.stringContaining("video") });

    // Permission to depict is never permission to put words in their mouth.
    queueGrantPath();
    expect(
      await evaluateLikenessSubmission({
        ...baseRequest,
        needs: { scriptedSpeech: true },
      }),
    ).toMatchObject({ code: "use_not_authorized", reason: expect.stringContaining("speech") });
  });

  it("requires the recipient to be acknowledged, without invalidating the attestation", async () => {
    queueGrantPath({ disclosure: null });
    const decision = await evaluateLikenessSubmission(baseRequest);
    expect(decision).toMatchObject({ status: "blocked", code: "recipient_not_disclosed" });
    expect(decision).toMatchObject({
      reason: expect.stringContaining("does not require re-attesting"),
    });
  });

  it("carries ONE attestation across a provider change once the new one is acknowledged", async () => {
    // Same grant row, different recipient. This is the property that makes the
    // attestation provider-independent: nothing about the grant changed.
    queueGrantPath({
      disclosure: { ...disclosure, id: 777, provider: "openai", model: "gpt-image-1" },
    });
    const first = await evaluateLikenessSubmission(baseRequest);
    expect(first).toMatchObject({ status: "allowed" });

    queueGrantPath({ disclosure: null });
    const beforeAck = await evaluateLikenessSubmission({
      ...baseRequest,
      operation: "reference_sheet",
    });
    expect(beforeAck).toMatchObject({ code: "recipient_not_disclosed" });

    queueGrantPath({
      disclosure: { ...disclosure, id: 778, operation: "reference_sheet" },
    });
    const afterAck = await evaluateLikenessSubmission({
      ...baseRequest,
      operation: "reference_sheet",
    });
    expect(afterAck).toMatchObject({ status: "allowed", grant: { id: 91 } });
  });

  it("requires provider-side verification where the declaration says so", async () => {
    queueGrantPath();
    expect(
      await evaluateLikenessSubmission({
        ...baseRequest,
        surface: "video",
        provider: "byteplus",
        model: "asset-library",
        operation: "asset_registration",
        needs: {},
      }),
    ).toMatchObject({ code: "verified_identity_required" });
  });

  it("covers generated cast by the standing declaration, not a per-character grant", async () => {
    state.rows = [[{ id: 3, policyVersion: POLICY }]];
    const decision = await evaluateLikenessSubmission({
      ...baseRequest,
      character: generated,
      surface: "video",
      provider: "atlascloud",
      model: "asset-library",
      operation: "asset_registration",
      needs: {},
    });
    expect(decision).toMatchObject({ status: "allowed", grant: null });
  });

  it("records rather than blocks a missing standing declaration by default", async () => {
    delete process.env.LIKENESS_STANDING_DECLARATION_ENFORCED;
    state.rows = [[]];
    expect(
      await evaluateLikenessSubmission({
        ...baseRequest,
        character: generated,
        surface: "video",
        provider: "atlascloud",
        model: "asset-library",
        operation: "asset_registration",
        needs: {},
      }),
    ).toMatchObject({ status: "allowed" });
  });

  it("blocks a missing standing declaration once enforcement is switched on", async () => {
    process.env.LIKENESS_STANDING_DECLARATION_ENFORCED = "true";
    state.rows = [[]];
    expect(
      await evaluateLikenessSubmission({
        ...baseRequest,
        character: generated,
        surface: "video",
        provider: "atlascloud",
        model: "asset-library",
        operation: "asset_registration",
        needs: {},
      }),
    ).toMatchObject({ code: "standing_declaration_missing" });
    delete process.env.LIKENESS_STANDING_DECLARATION_ENFORCED;
  });
});

describe("freeze and pre-dispatch recheck", () => {
  beforeEach(() => {
    state.rows = [];
    state.eqValues = [];
  });

  it("freezes the exact grant before funding", async () => {
    queueGrantPath();
    const frozen = await freezePersonalImageConsent({
      tenantId: 42,
      character,
      sourceSha256: sha,
      policyVersion: POLICY,
      provider: "openai",
      model: "gpt-image-1",
      operation: "outfit",
    });
    expect(frozen).toMatchObject({
      consentId: 91,
      sourceSha256: sha,
      subjectClass: "uploaded_self",
    });
  });

  it("refuses to freeze when the bytes changed", async () => {
    queueGrantPath();
    await expect(freezePersonalImageConsent({
      tenantId: 42,
      character,
      sourceSha256: "b".repeat(64),
      policyVersion: POLICY,
      provider: "openai",
      model: "gpt-image-1",
      operation: "outfit",
    })).rejects.toBeInstanceOf(PersonalLikenessConsentError);
  });

  it("rejects a recipient the pipeline substituted after funding", async () => {
    const frozen = {
      consentId: 91,
      sourcePath: grant.sourcePath,
      sourceSha256: sha,
      policyVersion: POLICY,
      subjectClass: "uploaded_self" as const,
    };
    // Character row loads, then the refused provider short-circuits.
    state.rows = [[character]];
    await expect(assertFrozenPersonalImageConsent({
      tenantId: 42,
      characterId: 17,
      frozen,
      sourceSha256: sha,
      provider: "replicate",
      model: "google/nano-banana-pro",
      operation: "outfit",
    })).rejects.toThrow(/must never receive a likeness/);
  });

  it("rejects a job that would ride a newer attestation than it was funded against", async () => {
    const frozen = {
      consentId: 91,
      sourcePath: grant.sourcePath,
      sourceSha256: sha,
      policyVersion: POLICY,
      subjectClass: "uploaded_self" as const,
    };
    state.rows = [
      [character],
      [{ ...grant, id: 92 }],
      [],
      [{ disclosure: { ...disclosure, consentId: 92 } }],
    ];
    await expect(assertFrozenPersonalImageConsent({
      tenantId: 42,
      characterId: 17,
      frozen,
      sourceSha256: sha,
      provider: "openai",
      model: "gpt-image-1",
      operation: "outfit",
    })).rejects.toThrow(/changed after this job was funded/);
  });

  it("rejects a revocation landing between funding and dispatch", async () => {
    const frozen = {
      consentId: 91,
      sourcePath: grant.sourcePath,
      sourceSha256: sha,
      policyVersion: POLICY,
      subjectClass: "uploaded_self" as const,
    };
    state.rows = [[character], [grant], [{ id: 1 }], []];
    await expect(assertFrozenPersonalImageConsent({
      tenantId: 42,
      characterId: 17,
      frozen,
      sourceSha256: sha,
      provider: "openai",
      model: "gpt-image-1",
      operation: "outfit",
    })).rejects.toThrow(/withdrawn/);
  });
});

describe("request body fences", () => {
  it("rejects unchecked attestations, missing written permission, and extra client keys", () => {
    const valid = {
      sourceSha256: sha,
      policyVersion: POLICY,
      subject: "self" as const,
      imageRightsConfirmed: true,
      adultConfirmed: true,
      likenessConfirmed: true,
      writtenPermissionConfirmed: false,
      allowOutfitEdits: true,
      allowVideoDepiction: true,
      allowScriptedSpeech: false,
    };
    expect(GrantCharacterLikenessConsentBody.safeParse(valid).success).toBe(true);
    expect(validateLikenessGrantAttestation({
      ...valid,
      adultConfirmed: false,
    })).toContain("must be confirmed");
    expect(validateLikenessGrantAttestation({
      ...valid,
      subject: "authorized_person",
      writtenPermissionConfirmed: false,
    })).toContain("must be confirmed");
    expect(hasOnlyLikenessConsentRequestKeys({
      ...valid,
      actingClerkUserId: "forged",
    }, "grant")).toBe(false);
    // A recipient is never something the caller asserts inside the attestation.
    expect(hasOnlyLikenessConsentRequestKeys({
      ...valid,
      providers: ["atlascloud"],
    }, "grant")).toBe(false);
    expect(hasOnlyLikenessConsentRequestKeys({ consentId: 91, actor: "forged" }, "revoke"))
      .toBe(false);
    expect(hasOnlyLikenessConsentRequestKeys(
      { provider: "openai", model: "gpt-image-1", operation: "outfit" },
      "recipient",
    )).toBe(true);
    expect(hasOnlyLikenessConsentRequestKeys(
      { provider: "openai", model: "gpt-image-1", operation: "outfit", scopeLabel: "forged" },
      "recipient",
    )).toBe(false);
  });
});
