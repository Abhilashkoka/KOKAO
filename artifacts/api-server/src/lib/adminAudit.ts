import { db, adminAuditLogsTable } from "@workspace/db";

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
