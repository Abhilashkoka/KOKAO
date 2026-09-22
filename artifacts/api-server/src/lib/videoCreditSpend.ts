import {
  creditAccountLedgerTable,
  db,
  videoDeliveryBillingItemsTable,
  videoDeliveryBillingManifestsTable,
  type CreditAccountLedgerEntry,
  type VideoGeneration,
} from "@workspace/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";

type DeliveryItem = {
  operationIdentity: string;
  kind?: string;
  independentlySettled: boolean;
  providerReservationId: number | null;
  unmetered: boolean;
};

type DeliverySnapshot = {
  jobId: number;
  tenantId: number;
  items: DeliveryItem[];
};

function identityMatches(key: string | null, identity: string): boolean {
  if (!key) return false;
  return (
    key.startsWith(`spend:${identity}:`) ||
    key === `spend-family:${identity}` ||
    key.startsWith(`spend-family:${identity}:attempt:`) ||
    key.startsWith(`refund:${identity}:`) ||
    key === `refund-family:${identity}` ||
    key.startsWith(`refund-family:${identity}:attempt:`)
  );
}

function operationLedgerIdentities(
  job: VideoGeneration,
  operationIdentity: string,
): string[] {
  const identities = [operationIdentity];
  const videoEvent = operationIdentity.match(
    /^video-chain:\d+:(.+):job:(\d+)$/,
  );
  if (videoEvent) {
    identities.push(`videoJob:${videoEvent[2]}:${videoEvent[1]}`);
  }

  // Early Guided v2 manifests froze the role slug as the delivered identity,
  // while the debit correctly froze the draft/revision/role operation key.
  // The job snapshot makes this translation exact (and tenant scoped); do not
  // attempt a fuzzy ref-kind/ref-id join for any other historical shape.
  const guided = job.options?.guidedStory;
  const role = operationIdentity.match(/^guided-(portrait|sheet):([^:]+)$/);
  if (guided && role) {
    identities.push(
      role[1] === "portrait"
        ? `guided-story-cast:${guided.draftId}:${guided.draftRevision}:${role[2]}`
        : `guided-story-sheet:${guided.draftId}:${guided.draftRevision}:${role[2]}`,
    );
  }
  return identities;
}

function rowMatchesIdentities(
  row: CreditAccountLedgerEntry,
  identities: readonly string[],
): boolean {
  return identities.some((identity) =>
    identityMatches(row.idempotencyKey, identity)
  );
}

const ACCEPTED_INPUT_KINDS = new Set([
  "script",
  "portrait",
  "reference_sheet",
  "outfit",
  "backdrop",
]);

function lifecycleSpendKey(row: CreditAccountLedgerEntry): string | null {
  if (row.note) {
    try {
      const value = JSON.parse(row.note) as { spendKey?: unknown };
      if (typeof value.spendKey === "string") return value.spendKey;
    } catch {
      // Fall through to the durable marker suffix.
    }
  }
  return row.idempotencyKey?.replace(
    /:dispatch:(?:pending|started|succeeded|failed|ambiguous)$/,
    "",
  ) ?? null;
}

function hasUnresolvedChargeLifecycle(
  rows: readonly CreditAccountLedgerEntry[],
): boolean {
  for (const row of rows) {
    if (pendingRefundIsUnresolved(row, rows)) return true;
    if (
      row.kind !== "meter_dispatch_pending" &&
      row.kind !== "meter_dispatch_started" &&
      row.kind !== "meter_dispatch_ambiguous"
    ) continue;
    const spendKey = lifecycleSpendKey(row);
    if (!spendKey) return true;
    const resolved = rows.some((candidate) =>
      lifecycleSpendKey(candidate) === spendKey &&
      (candidate.kind === "meter_dispatch_succeeded" ||
        candidate.kind === "meter_dispatch_failed")
    );
    if (!resolved) return true;
  }
  return false;
}

function pendingRefundIsUnresolved(
  pending: CreditAccountLedgerEntry,
  rows: readonly CreditAccountLedgerEntry[],
): boolean {
  if (pending.kind !== "refund_pending") return false;
  let refundKey: string | null = null;
  if (pending.note) {
    try {
      const parsed = JSON.parse(pending.note) as { refundKey?: unknown };
      if (typeof parsed.refundKey === "string") refundKey = parsed.refundKey;
    } catch {
      // Older pending rows can still be paired by their idempotency suffix.
    }
  }
  refundKey ??= pending.idempotencyKey?.endsWith(":pending")
    ? pending.idempotencyKey.slice(0, -":pending".length)
    : null;
  return !refundKey || !rows.some(
    (row) => row.kind === "refund" && row.idempotencyKey === refundKey,
  );
}

/**
 * Computes customer credits actually applied by the signed account ledger.
 *
 * Meter-report credits are deliberately not accepted here: shadow events say
 * what an operation would cost, not what the account was debited. A v2 frozen
 * delivery manifest supplies membership; ledger deltas supply the amount.
 */
export function computeVideoCreditTotals(
  jobs: readonly VideoGeneration[],
  deliveries: readonly DeliverySnapshot[],
  ledger: readonly CreditAccountLedgerEntry[],
): Map<number, number | null> {
  const deliveryByJob = new Map(deliveries.map((row) => [row.jobId, row]));
  const result = new Map<number, number | null>();

  for (const job of jobs) {
    const delivery = deliveryByJob.get(job.id);
    if (
      job.status !== "succeeded" ||
      job.options?.billingPolicyVersion !== 2 ||
      job.options.meterFunding?.rail !== "credits" ||
      !delivery ||
      delivery.tenantId !== job.tenantId
    ) {
      result.set(job.id, null);
      continue;
    }

    const creditOperationItems = delivery.items.filter(
      (item) => item.providerReservationId === null && !item.unmetered,
    );
    const operationIdentities = new Set(creditOperationItems.flatMap((item) =>
      operationLedgerIdentities(job, item.operationIdentity)
    ));
    const acceptedItems = creditOperationItems.filter((item) =>
      item.independentlySettled || ACCEPTED_INPUT_KINDS.has(item.kind ?? "")
    );
    const rows = ledger.filter(
      (row) =>
        row.tenantId === job.tenantId &&
        ((row.refKind === "videoJob" && row.refId === String(job.id)) ||
          rowMatchesIdentities(row, [...operationIdentities])),
    );

    // A durable pending refund means the current debit is not the final actual
    // amount. Do not briefly expose an overcharge as authoritative.
    if (hasUnresolvedChargeLifecycle(rows)) {
      result.set(job.id, null);
      continue;
    }

    // Signed account mutations are authoritative even if a newer provider
    // debit uses a more specific kind than the original "spend" label.
    const applied = rows.filter(
      (row) => row.purchasedDeltaMilli !== 0 || row.grantedDeltaMilli !== 0,
    );
    const coveredAcceptedInputs = acceptedItems.every((item) =>
      applied.some((row) =>
        row.purchasedDeltaMilli + row.grantedDeltaMilli < 0 &&
        rowMatchesIdentities(
          row,
          operationLedgerIdentities(job, item.operationIdentity),
        )
      ),
    );
    const coveredVideoOperations = creditOperationItems
      .filter((item) => !item.independentlySettled)
      .every((item) =>
      applied.some(
        (row) =>
          row.purchasedDeltaMilli + row.grantedDeltaMilli < 0 &&
          rowMatchesIdentities(
            row,
            operationLedgerIdentities(job, item.operationIdentity),
          ),
      ),
    );
    const reusedLineageItems = creditOperationItems.filter((item) => {
      const owner = item.operationIdentity.match(
        /(?:video-job|videoJob|video):(\d+)(?::|$)/,
      )?.[1];
      return owner !== undefined && owner !== String(job.id);
    });
    const coveredReusedLineage = reusedLineageItems.every((item) =>
      applied.some(
        (row) =>
          row.purchasedDeltaMilli + row.grantedDeltaMilli < 0 &&
          rowMatchesIdentities(
            row,
            operationLedgerIdentities(job, item.operationIdentity),
          ),
      ),
    );
    const hasVideoDebit = applied.some(
      (row) =>
        row.purchasedDeltaMilli + row.grantedDeltaMilli < 0 &&
        row.refKind === "videoJob" &&
        row.refId === String(job.id),
    );
    const videoIsExplicitlyUnmetered =
      delivery.items.some((item) => !item.independentlySettled) &&
      delivery.items
        .filter((item) => !item.independentlySettled)
        .every((item) => item.unmetered);
    if (
      !coveredAcceptedInputs ||
      !coveredReusedLineage ||
      (!hasVideoDebit &&
        !videoIsExplicitlyUnmetered &&
        !coveredVideoOperations)
    ) {
      result.set(job.id, null);
      continue;
    }

    const netDeltaMilli = applied.reduce(
      (sum, row) =>
        sum + row.purchasedDeltaMilli + row.grantedDeltaMilli,
      0,
    );
    if (!Number.isSafeInteger(netDeltaMilli) || netDeltaMilli > 0) {
      result.set(job.id, null);
      continue;
    }
    result.set(job.id, -netDeltaMilli / 1_000);
  }
  return result;
}

/** Batched tenant-scoped lookup for list and detail video responses. */
export async function getVideoCreditTotals(
  tenantId: number,
  jobs: readonly VideoGeneration[],
): Promise<Map<number, number | null>> {
  const owned = jobs.filter((job) => job.tenantId === tenantId);
  const defaults = new Map(owned.map((job) => [job.id, null] as const));
  if (!owned.length) return defaults;

  const manifests = await db
    .select({
      id: videoDeliveryBillingManifestsTable.id,
      jobId: videoDeliveryBillingManifestsTable.completedJobId,
      tenantId: videoDeliveryBillingManifestsTable.tenantId,
    })
    .from(videoDeliveryBillingManifestsTable)
    .where(
      and(
        eq(videoDeliveryBillingManifestsTable.tenantId, tenantId),
        inArray(
          videoDeliveryBillingManifestsTable.completedJobId,
          owned.map((job) => job.id),
        ),
      ),
    );
  if (!manifests.length) return defaults;

  const items = await db
    .select({
      manifestId: videoDeliveryBillingItemsTable.manifestId,
      operationIdentity: videoDeliveryBillingItemsTable.operationIdentity,
      kind: videoDeliveryBillingItemsTable.kind,
      independentlySettled:
        videoDeliveryBillingItemsTable.independentlySettled,
      providerReservationId:
        videoDeliveryBillingItemsTable.providerReservationId,
      unmetered: videoDeliveryBillingItemsTable.unmetered,
    })
    .from(videoDeliveryBillingItemsTable)
    .where(
      inArray(
        videoDeliveryBillingItemsTable.manifestId,
        manifests.map((manifest) => manifest.id),
      ),
    );
  const jobsById = new Map(owned.map((job) => [job.id, job]));
  const manifestById = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const identities = items
    .filter((item) => item.providerReservationId === null && !item.unmetered)
    .flatMap((item) => {
      const manifest = manifestById.get(item.manifestId);
      const job = manifest ? jobsById.get(manifest.jobId) : undefined;
      return job
        ? operationLedgerIdentities(job, item.operationIdentity)
        : [item.operationIdentity];
    });
  const refs = owned.map((job) => String(job.id));
  const identityPredicates = identities.flatMap((identity) => [
    sql`starts_with(${creditAccountLedgerTable.idempotencyKey}, ${`spend:${identity}:`})`,
    sql`starts_with(${creditAccountLedgerTable.idempotencyKey}, ${`spend-family:${identity}`})`,
    sql`starts_with(${creditAccountLedgerTable.idempotencyKey}, ${`refund:${identity}:`})`,
    sql`starts_with(${creditAccountLedgerTable.idempotencyKey}, ${`refund-family:${identity}`})`,
  ]);
  const ledger = await db
    .select()
    .from(creditAccountLedgerTable)
    .where(
      and(
        eq(creditAccountLedgerTable.tenantId, tenantId),
        or(
          and(
            eq(creditAccountLedgerTable.refKind, "videoJob"),
            inArray(creditAccountLedgerTable.refId, refs),
          ),
          ...identityPredicates,
        ),
      ),
    );
  const itemsByManifest = new Map<number, DeliveryItem[]>();
  for (const item of items) {
    const list = itemsByManifest.get(item.manifestId) ?? [];
    list.push(item);
    itemsByManifest.set(item.manifestId, list);
  }
  return computeVideoCreditTotals(
    owned,
    manifests.map((manifest) => ({
      jobId: manifest.jobId,
      tenantId: manifest.tenantId,
      items: itemsByManifest.get(manifest.id) ?? [],
    })),
    ledger,
  );
}