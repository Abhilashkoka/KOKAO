import { db, adminAuditLogsTable } from "@workspace/db";
import { and, eq, lte, like, sql } from "drizzle-orm";

export type AdminAuditAction =
  | "plan_change"
  | "superadmin_grant"
  | "superadmin_revoke"
  | "plan_edit"
  | "plan_create"
  | "plan_delete"
  | "notification_policy_change"
  | "credential_change"
  | "app_brand_change"
  | "email_settings_change"
  | "design_skill_change"
  | "asr_provider_change"
  | "asr_key_change"
  | "imagegen_provider_change"
  | "imagegen_key_change"
  | "email_test_send"
  | "sweep_run"
  | "seat_request_approve"
  | "seat_request_deny"
  | "credit_pack_change"
  | "credit_grant";

export interface RecordAdminActionInput {
  action: AdminAuditAction;
  actorTenantId: number;
  actorEmail: string | null;
  targetTenantId: number | null;
  targetEmail: string | null;
  oldValue: string | null;
  newValue: string | null;
}

/**
 * Append a privileged admin action to the append-only audit trail. This is
 * best-effort side-recording: a failure to write the audit row must never
 * cause the underlying privileged action to appear to have failed, so callers
 * should await this AFTER the primary mutation has succeeded and treat a throw
 * as non-fatal (log and continue). The routes here await inside the same
 * handler so the log is durable before responding.
 */
export async function recordAdminAction(
  input: RecordAdminActionInput,
): Promise<void> {
  await db.insert(adminAuditLogsTable).values({
    action: input.action,
    actorTenantId: input.actorTenantId,
    actorEmail: input.actorEmail,
    targetTenantId: input.targetTenantId,
    targetEmail: input.targetEmail,
    oldValue: input.oldValue,
    newValue: input.newValue,
  });
}

/**
 * Per-actor throttle window for test emails (see routes/emailSettings.ts).
 * Lives here because both the test-send reservation path and the audit-trail
 * read path use it to decide when a "pending" reservation is stale.
 */
export const TEST_EMAIL_WINDOW_MS = 60_000;

/**
 * Finalize ABANDONED test-email reservations: if a request crashed or was
 * aborted between reserving a throttle slot (a provisional `email_test_send`
 * row with outcome "pending") and writing the real outcome, its row would
 * otherwise linger as "pending" forever in the append-only trail and mislead
 * admin views. Rows older than the throttle window no longer count against
 * the cap, so rewriting them to "abandoned" cannot change throttle behavior —
 * it only makes the trail honest.
 *
 * Safe to run from any caller (row updates take row locks and never touch
 * in-window rows). Accepts an optional transaction handle so the reservation
 * path can run it inside its serialized transaction.
 */
export async function sweepAbandonedEmailTestSends(
  executor: Pick<typeof db, "update"> = db,
  now = Date.now(),
): Promise<void> {
  const cutoff = new Date(now - TEST_EMAIL_WINDOW_MS);
  await executor
    .update(adminAuditLogsTable)
    .set({
      newValue: sql`replace(${adminAuditLogsTable.newValue}, '"outcome":"pending"', '"outcome":"abandoned"')`,
    })
    .where(
      and(
        eq(adminAuditLogsTable.action, "email_test_send"),
        lte(adminAuditLogsTable.createdAt, cutoff),
        like(adminAuditLogsTable.newValue, '%"outcome":"pending"%'),
      ),
    );
}
