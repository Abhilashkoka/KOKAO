import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  eqValues: [] as unknown[],
}));

vi.mock("@workspace/db", () => {
  const column = (name: string) => ({ name });
  const table = new Proxy({}, { get: (_target, property) => column(String(property)) });
  const query = () => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({ limit: async () => state.rows.shift() ?? [] }),
        limit: async () => state.rows.shift() ?? [],
      }),
    }),
  });
  return {
    db: { select: () => query() },
    charactersTable: table,
    characterLikenessConsentGrantsTable: table,
    characterLikenessConsentRevocationsTable: table,
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  desc: (value: unknown) => value,
  eq: (column: { name: string }, value: unknown) => {
    state.eqValues.push([column.name, value]);
    return [column, value];
  },
}));

vi.mock("./provenancePolicy", () => ({
  isPersonalLikenessSource: (character: { referenceSource: string }) =>
    character.referenceSource === "uploaded",
}));

import {
  assertFrozenPersonalImageConsent,
  freezePersonalImageConsent,
  PersonalLikenessConsentError,
  validateLikenessGrantAttestation,
  hasOnlyLikenessConsentRequestKeys,
} from "./likenessConsent";
import { GrantCharacterLikenessConsentBody } from "@workspace/api-zod";

const sha = "a".repeat(64);
const character = {
  id: 17,
  tenantId: 42,
  referenceImagePath: "/objects/42/uploads/source.png",
  referenceSource: "uploaded",
} as never;
const grant = {
  id: 91,
  sourcePath: "/objects/42/uploads/source.png",
  sourceSha256: sha,
  policyVersion: "2026-09-17:image-processors:abcd",
  imageProcessorScope: [
    "reference_sheet|Replicate / google/nano-banana-pro",
    "outfit|OpenAI (built in, no key needed) / gpt-image-1",
  ],
  allowOutfitEdits: true,
};

describe("personal likeness consent boundary", () => {
  beforeEach(() => {
    state.rows = [];
    state.eqValues = [];
  });

  it("requires tenant-scoped current source and exact disclosed processor scope", async () => {
    state.rows = [[grant], []];
    const frozen = await freezePersonalImageConsent({
      tenantId: 42,
      character,
      sourceSha256: sha,
      imageProcessorScope: grant.imageProcessorScope,
      policyVersion: grant.policyVersion,
    });
    expect(frozen).toMatchObject({ consentId: 91, sourceSha256: sha });
    expect(state.eqValues).toContainEqual(["tenantId", 42]);

    state.rows = [[grant]];
    await expect(freezePersonalImageConsent({
      tenantId: 42,
      character,
      sourceSha256: "b".repeat(64),
      imageProcessorScope: grant.imageProcessorScope,
      policyVersion: grant.policyVersion,
    })).rejects.toBeInstanceOf(PersonalLikenessConsentError);

    state.rows = [[grant]];
    await expect(freezePersonalImageConsent({
      tenantId: 42,
      character,
      sourceSha256: sha,
      imageProcessorScope: [
        "reference_sheet|Replicate / google/nano-banana-pro",
        "outfit|Replicate / google/nano-banana-pro",
      ],
      policyVersion: grant.policyVersion,
    })).rejects.toBeInstanceOf(PersonalLikenessConsentError);

    state.rows = [[grant]];
    await expect(freezePersonalImageConsent({
      tenantId: 42,
      character,
      sourceSha256: sha,
      imageProcessorScope: grant.imageProcessorScope,
      policyVersion: "2026-09-18:image-processors:changed",
    })).rejects.toBeInstanceOf(PersonalLikenessConsentError);
  });

  it("rejects a fresh revocation or a changed provider before dispatch", async () => {
    const frozen = {
      consentId: 91,
      sourcePath: grant.sourcePath,
      sourceSha256: sha,
      policyVersion: grant.policyVersion,
      imageProcessorScope: grant.imageProcessorScope,
    };
    await expect(assertFrozenPersonalImageConsent({
      tenantId: 42,
      characterId: 17,
      frozen,
      sourceSha256: sha,
      processor: "outfit|Replicate / google/nano-banana-pro",
    })).rejects.toThrow("not covered");

    state.rows = [[character], [grant], [{ id: 1 }]];
    await expect(assertFrozenPersonalImageConsent({
      tenantId: 42,
      characterId: 17,
      frozen,
      sourceSha256: sha,
      processor: grant.imageProcessorScope[0],
    })).rejects.toThrow("no longer current");
  });

  it("rejects unchecked attestations, missing written permission, and extra client keys", () => {
    const valid = {
      sourceSha256: sha,
      policyVersion: "policy",
      subject: "self" as const,
      imageRightsConfirmed: true,
      adultConfirmed: true,
      likenessConfirmed: true,
      writtenPermissionConfirmed: false,
      allowOutfitEdits: true,
      allowScriptedSpeech: false,
      providers: ["atlascloud"],
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
    expect(GrantCharacterLikenessConsentBody.safeParse({
      ...valid,
      actingClerkUserId: "forged",
    }).success).toBe(true); // codegen strips extras; route adds the strict fence.
    expect(hasOnlyLikenessConsentRequestKeys({
      ...valid,
      actingClerkUserId: "forged",
    }, "grant")).toBe(false);
    expect(hasOnlyLikenessConsentRequestKeys({ consentId: 91, actor: "forged" }, "revoke"))
      .toBe(false);
  });
});