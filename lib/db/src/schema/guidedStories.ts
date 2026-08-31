import {
  pgTable,
  serial,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export type GuidedStoryGenre =
  | "action_adventure"
  | "comedy"
  | "drama"
  | "romance"
  | "thriller_mystery"
  | "fantasy"
  | "science_fiction";

export type GuidedStoryPlatform =
  | "instagram_reels"
  | "tiktok"
  | "youtube_shorts"
  | "instagram_feed"
  | "youtube";

/** Canonical language identities accepted for new Guided Story attempts. */
export type GuidedStoryLocale = "en" | "hi" | "te" | "ta";

export interface GuidedStoryScript {
  version: 1;
  title: string;
  logline: string;
  runtimeSeconds: number;
  roles: Array<{ id: string; name: string; description: string }>;
  scenes: Array<{
    id: string;
    startMs: number;
    endMs: number;
    visualDirection: string;
    /** Every cast role visually present in this exact approved scene. */
    roleIds: string[];
    lines: Array<{
      id: string;
      ownerRoleId: string | null;
      kind: "dialogue" | "narration";
      text: string;
      /** Display-only English meaning. Provider-bound speech always uses text. */
      englishTranslation?: string | null;
      startMs: number;
      endMs: number;
    }>;
  }>;
  warnings: string[];
}

export interface GuidedStoryCastSnapshot {
  roleId: string;
  source: "saved" | "generated";
  characterId: number | null;
  outfitId: number | null;
  brandKitId: number | null;
  voiceId: string;
  character: {
    name: string;
    description: string;
    referenceImagePath: string | null;
  };
  outfit: {
    name: string;
    description: string;
    referenceImagePath: string | null;
  } | null;
  voice: {
    id: string;
    label: string;
    provider: string;
    providerVoiceId: string | null;
  };
  isUserRole: boolean;
  consentGranted: boolean;
  /** Durable receipt for fictional cast reference generation. */
  generatedAsset?: {
    path: string;
    provider: string;
    model: string;
    operationId: number | null;
  } | null;
}

/** Human approval evidence for the exact bytes used by one cast role. */
export interface GuidedStoryCastApprovalManifest {
  version: 1;
  /** Approvals are valid only while the draft remains at this revision. */
  draftRevision: number;
  roles: Record<string, {
    roleId: string;
    approvedAt: string;
    character: {
      referenceImagePath: string;
      sha256: string;
    };
    outfit: {
      referenceImagePath: string;
      sha256: string;
    };
  }>;
}
export type GuidedStoryReferenceOperationStatus =
  | "queued"
  | "generating"
  | "ready_to_review"
  | "finalized"
  | "failed"
  | "outcome_unknown";

/** One revisioned backdrop candidate. Approval covers the exact stored bytes. */
export interface GuidedStoryBackdropReference {
  version: 1;
  prompt: string;
  imagePath: string;
  imageSha256?: string;
  fingerprint: string;
  revision: number;
  approvedAt: string | null;
}

/** The default plate plus explicit, independently-approved scene assignments. */
export interface GuidedStoryBackdropChoices {
  version: 1;
  default: GuidedStoryBackdropReference | null;
  sceneOverrides: Record<string, GuidedStoryBackdropReference>;
}
/** Tenant-owned visual direction selected before an attempt is enqueued. */
export interface GuidedStoryVisualChoices {
  version: 1;
  /** A logo is intentionally opt-in per approved script scene. */
  logo: {
    path: string | null;
    sceneIds: string[];
  };
  /** Exactly one location mode is active for the whole attempt. */
  location:
    | { mode: "none"; imagePath: null; description: null }
    | { mode: "image"; imagePath: string; description: null }
    | { mode: "text"; imagePath: null; description: string };
  /**
   * Dedicated location plate reviewed before any scene preview.  The hash is
   * over prompt, imagePath and affected scene ids; approval is valid only while
   * that exact material remains unchanged.
   */
  backdropReference?: {
    version: 1;
    prompt: string;
    imagePath: string;
    sceneIds: string[];
    fingerprint: string;
    approvedAt: string | null;
  } | null;
  /** Canonical backdrop contract. Legacy backdropReference is read as default. */
  backdrops?: GuidedStoryBackdropChoices;
}

export interface GuidedStoryDraftState {
  version: 1;

  setup: {
    genre: GuidedStoryGenre;
    platform: GuidedStoryPlatform;
    aspectRatio: "16:9" | "9:16" | "4:5";
    width: number;
    height: number;
    safeArea: string;
    durationSeconds: number;
    locale: GuidedStoryLocale;
    topic: string;
    roleCount: number;
    brandKitId: number | null;

  } | null;
  /** Revision-bound, per-role paid cast work. Binary payload is retained only
   * between provider success and object-storage upload, then removed. */

  script: GuidedStoryScript | null;

  scriptApprovedAt: string | null;

  userRoleId: string | null;

  castStrategy: "generated" | "saved" | null;

  cast: GuidedStoryCastSnapshot[];

  /** Explicit, server-verified approvals for the current cast revision. */
  castApprovals?: GuidedStoryCastApprovalManifest | null;

  duplicateAssignmentConfirmed: boolean;
  /**
   * A short-lived, revision-bound claim made before a billable script provider
   * call.  It is deliberately part of the durable draft rather than process
   * memory: duplicate HTTP requests and a restart cannot both buy a script for
   * the same revision.
   */

  scriptGeneration: { revision: number; claimedAt: string } | null;
  /**
   * Durable two-phase lock for one AI scene insertion. Only bounded provider
   * execution in `generating` may expire; `finalizing` is never reclaimed by
   * wall clock while receipt persistence and wallet settlement are underway.
   */

  sceneInsertionGeneration?: {
    revision: number;
    operationKey: string;
    walletOperationKey?: string;
    requestKey: string;
    phase: "generating" | "finalizing";
    fundingMode?: "wallet" | "unmetered";
    claimedAt: string;
    expiresAt: string;
    finalizedAt?: string;
    result?: {
      insertedSceneId: string;
      script: GuidedStoryScript;
    };
  } | null;

  castOperations: Record<string, {
    revision: number;
    operationKey: string;
    voiceId: string;
    status:
      | "claimed"
      | "funded"
      /** Persisted immediately before crossing the provider boundary. */
      | "provider_running"
      /** The provider may have completed; only manual reconciliation may continue. */
      | "provider_outcome_unknown"
      | "provider_succeeded"
      | "upload_succeeded"
      | "uploaded";
    claimedAt: string;
    updatedAt: string;
    funding?: "quota" | "credit" | "wallet";
    walletReservation?: {
      id: number;
      amountPaise: number;
      units: number;
    } | null;
    operationId?: number | null;
    provider?: string;
    model?: string;
    imageBase64?: string;
    imageByteLength?: number;
    path?: string;
    settledAt?: string;

  }>;
  /** Inline awaiting-review replacement candidates, keyed by opaque operation id. */

  inlineReferenceOperations?: Record<string, {
    revision: number;
    operationKey: string;
    kind: "character" | "outfit";
    state: "queued" | "running" | "ready_to_review" | "failed" | "outcome_unknown";
    characterId?: number | null;
    outfitId?: number | null;
    error?: string | null;
    updatedAt: string;
  }>;

  visualChoices?: GuidedStoryVisualChoices;

  storyboardJobId: number | null;

  referenceOperations?: Record<string, GuidedStoryReferenceOperation>;
  /**
   * Revisioned draft input. Enqueue copies this byte-for-byte into its immutable
   * attempt snapshot; it is never inferred from a brand kit or mutable asset.
   */
}

export const guidedStoryDraftsTable = pgTable(
  "guided_story_drafts",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    revision: integer("revision").notNull().default(1),
    state: jsonb("state").$type<GuidedStoryDraftState>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    tenantIdIndex: index("guided_story_drafts_tenant_idx").on(t.tenantId),
  }),
);

export type GuidedStoryDraft = typeof guidedStoryDraftsTable.$inferSelect;

/**
 * A revision-bound candidate for replacing one complete cast role. Candidates
 * are deliberately separate from `cast`; renderers can only observe them after
 * the atomic finalization transaction copies `candidate` into that array.
 */
export interface GuidedStoryReferenceOperation {
  id: string;
  revision: number;
  roleId: string;
  kind: "character" | "outfit";
  source: "current" | "saved" | "upload" | "generated";
  status: GuidedStoryReferenceOperationStatus;
  /** Stable request identity lets an interrupted post-provider operation resume. */
  requestKey: string;
  /** Internal execution lease. Never serialize this token to API clients. */
  executionClaimToken?: string | null;
  /** Heartbeat for conservative stale-claim recovery. Internal only. */
  executionClaimedAt?: string | null;
  /** Internal durable provider boundary; never inferred from the public status. */
  checkpoint?: "funded" | "provider_running" | "provider_succeeded" | "upload_succeeded" | "uploaded";
  candidate: GuidedStoryCastSnapshot | null;
  description: string | null;
  funding?: "quota" | "credit" | "wallet";
  walletReservation?: {
    id: number;
    amountPaise: number;
    units: number;
  } | null;
  providerOperationId?: number | null;
  provider?: string | null;
  model?: string | null;
  providerStartedAt?: string | null;
  imageBase64?: string;
  imageByteLength?: number;
  /** Validated generated-image MIME type. Internal upload checkpoint metadata. */
  imageContentType?: "image/png" | "image/jpeg";
  path?: string;
  settledAt?: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
}
