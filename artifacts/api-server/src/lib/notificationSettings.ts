import {
  db,
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
}

export interface EffectiveState {
  enabled: boolean;
  inApp: boolean;
  email: boolean;
}

export function defaultPolicy(): PolicyState {
  return { enabled: true, emailPolicy: DEFAULT_EMAIL_POLICY };
}

export function defaultPreference(): PreferenceState {
  return { inApp: true, email: false };
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
  if (!policy.enabled) return { enabled: false, inApp: false, email: false };
  const email =
    policy.emailPolicy === "forced"
      ? true
      : policy.emailPolicy === "off"
        ? false
        : pref.email;
  return { enabled: true, inApp: pref.inApp, email };
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
    map.set(r.type, { inApp: r.inApp, email: r.email });
  }
  return map;
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
    ? { inApp: prefRow.inApp, email: prefRow.email }
    : defaultPreference();

  return resolveEffective(policy, pref);
}
