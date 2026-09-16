import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Server-authored, append-only origin record for a tenant-owned visual asset.
 *
 * This table intentionally does not have foreign keys to the mutable character
 * library. Provenance is an audit record and must survive a library row being
 * deleted or replaced. Paths and hashes are captured at the provider-success
 * boundary and are never reconstructed from a filename, UI label, or billing
 * row.
 */
export type AssetProvenanceAssetKind =
  | "character_reference"
  | "reference_sheet"
  | "character_outfit"
  | "customization"
  | "video_selection"
  | "video_asset";

export type AssetProvenanceSourceKind =
  | "textgenerated"
  | "upload"
  | "imageedit"
  | "derived";

export interface AssetProvenanceAncestry {
  /** Parent assets that were actually supplied to the server operation. */
  parents: Array<{
    kind: AssetProvenanceAssetKind | "external";
    path: string | null;
    sha256: string | null;
    characterId?: number | null;
    outfitId?: number | null;
  }>;
  /** Safe, non-secret server operation inputs; prompts and credentials are excluded. */
  inputKinds?: string[];
  referenceSource?: "generated" | "uploaded" | "unknown" | null;
  capturedAt: string;
}

export const assetProvenanceTable = pgTable(
  "asset_provenance",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    assetKind: text("asset_kind").$type<AssetProvenanceAssetKind>().notNull(),
    sourceKind: text("source_kind").$type<AssetProvenanceSourceKind>().notNull(),
    characterId: integer("character_id"),
    outfitId: integer("outfit_id"),
    roleId: text("role_id"),
    /** Stable server operation identity, never a provider request id. */
    operationIdentity: text("operation_identity").notNull(),
    provider: text("provider"),
    model: text("model"),
    /** Native provider request/task id, only when the provider returned one. */
    providerRequestId: text("provider_request_id"),
    /** Internal paid-operation row id, not presented as a provider request id. */
    providerOperationId: integer("provider_operation_id"),
    artifactPath: text("artifact_path").notNull(),
    artifactSha256: text("artifact_sha256").notNull(),
    parentPath: text("parent_path"),
    parentSha256: text("parent_sha256"),
    inputAncestry: jsonb("input_ancestry").$type<AssetProvenanceAncestry>().notNull(),
    succeededAt: timestamp("succeeded_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("asset_provenance_tenant_idx").on(table.tenantId),
    index("asset_provenance_character_idx").on(table.tenantId, table.characterId),
    index("asset_provenance_artifact_idx").on(table.tenantId, table.artifactPath),
    uniqueIndex("asset_provenance_operation_kind_uniq").on(
      table.tenantId,
      table.assetKind,
      table.operationIdentity,
    ),
  ],
);

export type AssetProvenance = typeof assetProvenanceTable.$inferSelect;