import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  assetProvenanceTable,
  db,
  type AssetProvenance,
  type AssetProvenanceAncestry,
  type AssetProvenanceAssetKind,
  type AssetProvenanceSourceKind,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

export type ProvenanceStatus = "verified_generated" | "uploaded" | "unknown";

// PostgreSQL jsonb normalizes object key order and omits undefined properties.
function sameJsonContent(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return isDeepStrictEqual(
    JSON.parse(JSON.stringify(left)),
    JSON.parse(JSON.stringify(right)),
  );
}

export interface ProvenanceSummary {
  method: "textgenerated" | "upload" | "imageedit" | "derived";
  provider: string | null;
  model: string | null;
  createdAt: string | null;
  missingReason?: string;
}

export interface ImmutableProvenanceProof {
  provenanceRecordId: number;
  assetKind: AssetProvenanceAssetKind;
  operationIdentity: string;
  artifactPath: string;
  artifactSha256: string;
  parentPath: string | null;
  parentSha256: string | null;
  sourceKind?: AssetProvenanceSourceKind;
  provider?: string | null;
  model?: string | null;
  providerRequestId?: string | null;
  providerOperationId?: number | null;
  inputAncestry?: AssetProvenanceAncestry;
}

export function immutableProvenanceProof(
  evidence: Pick<
    AssetProvenance,
    | "id"
    | "assetKind"
    | "operationIdentity"
    | "artifactPath"
    | "artifactSha256"
    | "parentPath"
    | "parentSha256"
    | "sourceKind"
    | "provider"
    | "model"
    | "providerRequestId"
    | "providerOperationId"
    | "inputAncestry"
  > | null | undefined,
): ImmutableProvenanceProof | null {
  if (
    !evidence ||
    !evidence.operationIdentity.trim() ||
    !evidence.artifactPath.trim() ||
    !/^[a-f0-9]{64}$/i.test(evidence.artifactSha256)
  ) {
    return null;
  }
  return {
    provenanceRecordId: evidence.id,
    assetKind: evidence.assetKind,
    operationIdentity: evidence.operationIdentity,
    artifactPath: evidence.artifactPath,
    artifactSha256: evidence.artifactSha256,
    parentPath: evidence.parentPath ?? null,
    parentSha256: evidence.parentSha256 ?? null,
    sourceKind: evidence.sourceKind,
    provider: evidence.provider,
    model: evidence.model,
    providerRequestId: evidence.providerRequestId,
    providerOperationId: evidence.providerOperationId,
    inputAncestry: evidence.inputAncestry,
  };
}

/**
 * Reuse the immutable proof captured when a Guided reference reached
 * ready_to_review. Finalization must not recapture the same operation with a
 * new timestamp: the frozen row id is the identity of that accepted output.
 */
export function reuseFrozenProvenanceProof(
  evidence:
    | (Omit<ImmutableProvenanceProof, "provenanceRecordId" | "parentPath" | "parentSha256"> & {
        provenanceRecordId?: number;
        parentPath?: string | null;
        parentSha256?: string | null;
      })
    | null
    | undefined,
  row: AssetProvenance | null | undefined,
): ImmutableProvenanceProof | null {
  const frozen = immutableProvenanceProof(row);
  if (
    !evidence ||
    !frozen ||
    evidence.provenanceRecordId !== frozen.provenanceRecordId
  ) {
    return null;
  }
  return sameJsonContent(
    {
      ...evidence,
      parentPath: evidence.parentPath ?? null,
      parentSha256: evidence.parentSha256 ?? null,
    },
    frozen,
  )
    ? frozen
    : null;
}

/** Replace one asset-kind proof while retaining unrelated frozen refs. */
export function replaceFrozenProvenanceReference<T extends { assetKind: string }>(
  existing: readonly T[],
  replacement: T,
): T[] {
  return [
    ...existing.filter((item) => item.assetKind !== replacement.assetKind),
    replacement,
  ];
}

export async function verifyFrozenAssetProvenance(
  tenantId: number,
  evidence:
    | (Omit<ImmutableProvenanceProof, "provenanceRecordId"> & {
        provenanceRecordId?: number;
      })
    | null
    | undefined,
  readArtifact: (
    path: string,
    tenantId: number,
  ) => Promise<Buffer>,
): Promise<boolean> {
  if (!evidence?.provenanceRecordId || !readArtifact) return false;
  const [row] = await db
    .select()
    .from(assetProvenanceTable)
    .where(
      and(
        eq(assetProvenanceTable.id, evidence.provenanceRecordId),
        eq(assetProvenanceTable.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (
    !row ||
    row.tenantId !== tenantId ||
    row.assetKind !== evidence.assetKind ||
    row.operationIdentity !== evidence.operationIdentity ||
    row.artifactPath !== evidence.artifactPath ||
    row.artifactSha256.toLowerCase() !== evidence.artifactSha256.toLowerCase() ||
    row.parentPath !== evidence.parentPath ||
    row.parentSha256 !== evidence.parentSha256 ||
    (evidence.inputAncestry !== undefined &&
      !sameJsonContent(row.inputAncestry, evidence.inputAncestry)) ||
    (evidence.sourceKind !== undefined && row.sourceKind !== evidence.sourceKind) ||
    (evidence.provider !== undefined && row.provider !== evidence.provider) ||
    (evidence.model !== undefined && row.model !== evidence.model) ||
    (evidence.providerRequestId !== undefined &&
      row.providerRequestId !== evidence.providerRequestId) ||
    (evidence.providerOperationId !== undefined &&
      row.providerOperationId !== evidence.providerOperationId)
  ) {
    return false;
  }
  try {
    const bytes = await readArtifact(row.artifactPath, tenantId);
    return sha256Hex(bytes) === row.artifactSha256.toLowerCase();
  } catch {
    return false;
  }
}

export interface CaptureProvenanceInput {
  tenantId: number;
  assetKind: AssetProvenanceAssetKind;
  sourceKind: AssetProvenanceSourceKind;
  characterId?: number | null;
  outfitId?: number | null;
  roleId?: string | null;
  operationIdentity: string;
  provider?: string | null;
  model?: string | null;
  /** Native provider id only. Internal operation ids belong in providerOperationId. */
  providerRequestId?: string | null;
  providerOperationId?: number | null;
  artifactPath: string;
  artifactSha256: string;
  parentPath?: string | null;
  parentSha256?: string | null;
  inputAncestry: AssetProvenanceAncestry;
  succeededAt?: Date;
}

export interface ExactRecoveryEvidenceInput {
  tenantId: number;
  characterTenantId: number;
  draftId: number;
  roleId: string;
  currentPath: string;
  currentSha256: string;
  checkpoint: {
    draftId: number;
    roleId: string;
    status: string;
    sourcePath: string | null;
    sourceSha256: string | null;
    provider: string | null;
    model: string | null;
    operationKey: string | null;
    operationId: number | null;
  };
  providerReceipt?: {
    tenantId: number;
    operationKind: string;
    operationKey: string | null;
    provider: string | null;
    model: string | null;
    status: string;
  } | null;
}

export function validateExactRecoveryEvidence(
  input: ExactRecoveryEvidenceInput,
): { ok: true } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (
    input.tenantId !== input.characterTenantId ||
    input.draftId <= 0 ||
    input.roleId.trim().length === 0 ||
    input.checkpoint.draftId !== input.draftId ||
    input.checkpoint.roleId !== input.roleId
  ) {
    return fail("Tenant, draft, and role do not match the exact recovery request.");
  }
  if (
    !["uploaded", "completed"].includes(input.checkpoint.status) ||
    !input.currentPath.startsWith(`/objects/${input.tenantId}/`) ||
    input.checkpoint.sourcePath !== input.currentPath ||
    input.checkpoint.sourceSha256 !== input.currentSha256 ||
    !/^[a-f0-9]{64}$/i.test(input.currentSha256) ||
    !input.checkpoint.provider?.trim() ||
    !input.checkpoint.model?.trim() ||
    !input.checkpoint.operationKey?.trim()
  ) {
    return fail("The current bytes do not exactly match the durable server checkpoint.");
  }
  if (input.checkpoint.operationId === null) return { ok: true };
  const receipt = input.providerReceipt;
  if (
    !receipt ||
    receipt.tenantId !== input.tenantId ||
    receipt.operationKind !== "character_reference" ||
    receipt.operationKey !== input.checkpoint.operationKey ||
    receipt.provider !== input.checkpoint.provider ||
    receipt.model !== input.checkpoint.model ||
    !["succeeded", "settlement_queued", "settled"].includes(receipt.status)
  ) {
    return fail("The linked provider receipt is missing or does not match.");
  }
  return { ok: true };
}

export type ProvenanceExecutor = Pick<typeof db, "insert" | "select">;

function immutableCaptureMatches(
  existing: AssetProvenance,
  input: CaptureProvenanceInput,
): boolean {
  return (
    existing.tenantId === input.tenantId &&
    existing.assetKind === input.assetKind &&
    existing.sourceKind === input.sourceKind &&
    existing.characterId === (input.characterId ?? null) &&
    existing.outfitId === (input.outfitId ?? null) &&
    existing.roleId === (input.roleId ?? null) &&
    existing.operationIdentity === input.operationIdentity &&
    existing.provider === (input.provider ?? null) &&
    existing.model === (input.model ?? null) &&
    existing.providerRequestId === (input.providerRequestId ?? null) &&
    existing.providerOperationId === (input.providerOperationId ?? null) &&
    existing.artifactPath === input.artifactPath &&
    existing.artifactSha256.toLowerCase() === input.artifactSha256.toLowerCase() &&
    existing.parentPath === (input.parentPath ?? null) &&
    existing.parentSha256 === (input.parentSha256 ?? null) &&
    sameJsonContent(existing.inputAncestry, input.inputAncestry)
  );
}

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Persist evidence in the same transaction as the library row. A retry of the
 * same server operation is idempotent; it never creates a second origin claim.
 */
export async function captureAssetProvenance(
  tx: ProvenanceExecutor,
  input: CaptureProvenanceInput,
): Promise<AssetProvenance | null> {
  if (
    !input.artifactPath.startsWith(`/objects/${input.tenantId}/`) ||
    !/^[a-f0-9]{64}$/i.test(input.artifactSha256) ||
    !input.operationIdentity.trim() ||
    !input.inputAncestry ||
    !Array.isArray(input.inputAncestry.parents)
  ) {
    throw new Error("Invalid server asset provenance.");
  }
  const [row] = await tx
    .insert(assetProvenanceTable)
    .values({
      tenantId: input.tenantId,
      assetKind: input.assetKind,
      sourceKind: input.sourceKind,
      characterId: input.characterId ?? null,
      outfitId: input.outfitId ?? null,
      roleId: input.roleId ?? null,
      operationIdentity: input.operationIdentity,
      provider: input.provider ?? null,
      model: input.model ?? null,
      providerRequestId: input.providerRequestId ?? null,
      providerOperationId: input.providerOperationId ?? null,
      artifactPath: input.artifactPath,
      artifactSha256: input.artifactSha256.toLowerCase(),
      parentPath: input.parentPath ?? null,
      parentSha256: input.parentSha256 ?? null,
      inputAncestry: input.inputAncestry,
      succeededAt: input.succeededAt ?? new Date(),
    })
    .onConflictDoNothing({
      target: [
        assetProvenanceTable.tenantId,
        assetProvenanceTable.assetKind,
        assetProvenanceTable.operationIdentity,
      ],
    })
    .returning();
  if (row) return row;
  const [existing] = await tx
    .select()
    .from(assetProvenanceTable)
    .where(
      and(
        eq(assetProvenanceTable.tenantId, input.tenantId),
        eq(assetProvenanceTable.assetKind, input.assetKind),
        eq(assetProvenanceTable.operationIdentity, input.operationIdentity),
      ),
    )
    .limit(1);
  if (!existing || !immutableCaptureMatches(existing, input)) {
    throw new Error(
      "Asset provenance operation identity collision; immutable evidence differs.",
    );
  }
  return existing;
}

export function provenanceStatus(
  evidence: Pick<AssetProvenance, "sourceKind" | "provider" | "model" | "operationIdentity" | "artifactPath" | "artifactSha256" | "inputAncestry"> | null | undefined,
): ProvenanceStatus {
  if (!evidence) return "unknown";
  if (evidence.sourceKind === "upload") return "uploaded";
  const inheritedUpload = evidence.inputAncestry?.referenceSource === "uploaded";
  if (inheritedUpload) return "uploaded";
  if (
    evidence.inputAncestry?.referenceSource === "generated" &&
    evidence.provider &&
    evidence.model &&
    evidence.operationIdentity &&
    evidence.artifactPath &&
    /^[a-f0-9]{64}$/i.test(evidence.artifactSha256)
  ) return "verified_generated";
  return "unknown";
}

export function summarizeProvenance(
  evidence: AssetProvenance | null | undefined,
): { status: ProvenanceStatus; summary: ProvenanceSummary } {
  if (!evidence) {
    return {
      status: "unknown",
      summary: {
        method: "derived",
        provider: null,
        model: null,
        createdAt: null,
        missingReason: "No server-authored origin evidence is recorded.",
      },
    };
  }
  const status = provenanceStatus(evidence);
  return {
    status,
    summary: {
      method: evidence.sourceKind,
      provider: evidence.provider,
      model: evidence.model,
      createdAt: evidence.succeededAt.toISOString(),
      ...(status === "unknown"
        ? { missingReason: "Origin evidence is incomplete or inherited from an unknown source." }
        : {}),
    },
  };
}

export async function latestCharacterProvenance(
  tenantId: number,
  characterId: number,
): Promise<AssetProvenance | null> {
  const [row] = await db
    .select()
    .from(assetProvenanceTable)
    .where(
      and(
        eq(assetProvenanceTable.tenantId, tenantId),
        eq(assetProvenanceTable.characterId, characterId),
        eq(assetProvenanceTable.assetKind, "character_reference"),
      ),
    )
    .orderBy(desc(assetProvenanceTable.succeededAt), desc(assetProvenanceTable.id))
    .limit(1);
  return row ?? null;
}

export async function latestOutfitProvenance(
  tenantId: number,
  outfitId: number,
): Promise<AssetProvenance | null> {
  const [row] = await db
    .select()
    .from(assetProvenanceTable)
    .where(
      and(
        eq(assetProvenanceTable.tenantId, tenantId),
        eq(assetProvenanceTable.outfitId, outfitId),
        eq(assetProvenanceTable.assetKind, "character_outfit"),
      ),
    )
    .orderBy(desc(assetProvenanceTable.succeededAt), desc(assetProvenanceTable.id))
    .limit(1);
  return row ?? null;
}

export async function latestReferenceSheetProvenance(
  tenantId: number,
  characterId: number,
): Promise<AssetProvenance | null> {
  const [row] = await db
    .select()
    .from(assetProvenanceTable)
    .where(
      and(
        eq(assetProvenanceTable.tenantId, tenantId),
        eq(assetProvenanceTable.characterId, characterId),
        eq(assetProvenanceTable.assetKind, "reference_sheet"),
      ),
    )
    .orderBy(desc(assetProvenanceTable.succeededAt), desc(assetProvenanceTable.id))
    .limit(1);
  return row ?? null;
}
