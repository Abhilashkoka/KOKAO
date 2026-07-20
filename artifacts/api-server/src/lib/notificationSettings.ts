import {
  db,
  memberNotificationPreferencesTable,
  notificationPoliciesTable,
  notificationPreferencesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  DEFAULT_EMAIL_POLICY,
  type EmailPolicy,
} from "./notificationCatalog";

export interface PolicyState {
  enabled: boolean;
  emailPolicy: EmailPolicy;
}

export interface PreferenceState {
  inApp: boolean;
  email: boolean;
  push: boolean;
}

export interface EffectiveState {
  enabled: boolean;
  inApp: boolean;
  email: boolean;
  push: boolean;
}

export function defaultPolicy(): PolicyState {
  return { enabled: true, emailPolicy: DEFAULT_EMAIL_POLICY };
}

export function defaultPreference(): PreferenceState {
  return { inApp: true, email: true, push: true };
}

/**
 * Fold a global policy and a tenant preference into the channels that actually
 * fire. The policy is authoritative: a disabled type suppresses everything, and
 * the email channel is only tenant-controllable when the policy leaves it
 * "optional".
 */
export function resolveEffective(
  policy: PolicyState,
  pref: PreferenceState,
): EffectiveState {
  if (!policy.enabled)
    return { enabled: false, inApp: false, email: false, push: false };
  const email =
    policy.emailPolicy === "forced"
      ? true
      : policy.emailPolicy === "off"
        ? false
        : pref.email;
  // Push has no admin policy knob beyond the type's enabled switch: it only
  // reaches devices whose owner explicitly registered a push token, so the
  // user's own preference is the gate.
  return { enabled: true, inApp: pref.inApp, email, push: pref.push };
}

export async function getPolicyMap(): Promise<Map<string, PolicyState>> {
  const rows = await db.select().from(notificationPoliciesTable);
  const map = new Map<string, PolicyState>();
  for (const r of rows) {
    map.set(r.type, {
      enabled: r.enabled,
      emailPolicy: r.emailPolicy as EmailPolicy,
    });
  }
  return map;
}

export async function getPreferenceMap(
  tenantId: number,
): Promise<Map<string, PreferenceState>> {
  const rows = await db
    .select()
    .from(notificationPreferencesTable)
    .where(eq(notificationPreferencesTable.tenantId, tenantId));
  const map = new Map<string, PreferenceState>();
  for (const r of rows) {
    map.set(r.type, { inApp: r.inApp, email: r.email, push: r.push });
  }
  return map;
}

/**
 * Member-scoped preferences: rows stored per (workspace, member clerkUserId,
 * type) so a team member/admin working inside someone else's workspace keeps
 * their own channel choices without touching the owner's tenant-scoped rows.
 */
export async function getMemberPreferenceMap(
  tenantId: number,
  clerkUserId: string,
): Promise<Map<string, PreferenceState>> {
  const rows = await db
    .select()
    .from(memberNotificationPreferencesTable)
    .where(
      and(
        eq(memberNotificationPreferencesTable.tenantId, tenantId),
        eq(memberNotificationPreferencesTable.clerkUserId, clerkUserId),
      ),
    );
  const map = new Map<string, PreferenceState>();
  for (const r of rows) {
    map.set(r.type, { inApp: r.inApp, email: r.email, push: r.push });
  }
  return map;
}

/**
 * A single member's stored email choice for one type, or null when the member
 * never saved one (callers treat null as "no opt-out — use the workspace
 * default"). Used by dispatch when emailing individual admin members so one
 * admin's opt-out never silences the owner or other admins.
 */
export async function getMemberEmailSetting(
  tenantId: number,
  clerkUserId: string,
  type: string,
): Promise<boolean | null> {
  const [row] = await db
    .select({ email: memberNotificationPreferencesTable.email })
    .from(memberNotificationPreferencesTable)
    .where(
      and(
        eq(memberNotificationPreferencesTable.tenantId, tenantId),
        eq(memberNotificationPreferencesTable.clerkUserId, clerkUserId),
        eq(memberNotificationPreferencesTable.type, type),
      ),
    )
    .limit(1);
  return row ? row.email : null;
}

/** The stored global policy for one type, or the default when unset. */
export async function getPolicyState(type: string): Promise<PolicyState> {
  const [policyRow] = await db
    .select()
    .from(notificationPoliciesTable)
    .where(eq(notificationPoliciesTable.type, type))
    .limit(1);
  return policyRow
    ? {
        enabled: policyRow.enabled,
        emailPolicy: policyRow.emailPolicy as EmailPolicy,
      }
    : defaultPolicy();
}

/**
 * Resolve the effective channels for a single (tenant, type) pair, used by the
 * dispatch path when a notification is about to be raised.
 */
export async function getEffectiveSetting(
  tenantId: number,
  type: string,
): Promise<EffectiveState> {
  const [policyRow] = await db
    .select()
    .from(notificationPoliciesTable)
    .where(eq(notificationPoliciesTable.type, type))
    .limit(1);
  const policy: PolicyState = policyRow
    ? { enabled: policyRow.enabled, emailPolicy: policyRow.emailPolicy as EmailPolicy }
    : defaultPolicy();

  const [prefRow] = await db
    .select()
    .from(notificationPreferencesTable)
    .where(
      and(
        eq(notificationPreferencesTable.tenantId, tenantId),
        eq(notificationPreferencesTable.type, type),
      ),
    )
    .limit(1);
  const pref: PreferenceState = prefRow
    ? { inApp: prefRow.inApp, email: prefRow.email, push: prefRow.push }
    : defaultPreference();

  return resolveEffective(policy, pref);
}
