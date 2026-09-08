import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.setConfig({ testTimeout: 120_000 });

vi.mock("./clerkUser", () => ({
  fetchVerifiedEmail: vi.fn(async () => null),
}));
vi.mock("./email", () => ({
  sendEmail: vi.fn(async () => true),
}));

import { pool } from "@workspace/db";
import { fetchVerifiedEmail } from "./clerkUser";
import { sendEmail } from "./email";
import {
  notifySeedancePricingStale,
  resolveSeedancePricingStaleNotifications,
  SEEDANCE_PRICING_STALE,
} from "./notifications";
import {
  clearNotificationPolicy,
  createTenant,
  deleteTenant,
  getNotifications,
  purgeNotificationsByTypeSince,
  restoreNotificationPolicy,
  setNotificationPreference,
  snapshotNotificationPolicy,
} from "../test/dbHelpers";

const mockFetchEmail = vi.mocked(fetchVerifiedEmail);
const mockSendEmail = vi.mocked(sendEmail);

let policySnapshot: Awaited<ReturnType<typeof snapshotNotificationPolicy>>;
let suiteStart: Date;

beforeAll(async () => {
  suiteStart = new Date();
  policySnapshot = await snapshotNotificationPolicy(SEEDANCE_PRICING_STALE);
});

beforeEach(async () => {
  await clearNotificationPolicy(SEEDANCE_PRICING_STALE);
  vi.clearAllMocks();
  mockFetchEmail.mockResolvedValue(null);
  mockSendEmail.mockResolvedValue(true);
});

afterAll(async () => {
  await purgeNotificationsByTypeSince(SEEDANCE_PRICING_STALE, suiteStart);
  await restoreNotificationPolicy(SEEDANCE_PRICING_STALE, policySnapshot);
  await pool.end();
});

describe("Seedance stale-pricing notification lifecycle", () => {
  it("deduplicates a live outage, resolves every unread alert, and re-arms after recovery", async () => {
    const firstAdmin = await createTenant({ isSuperadmin: true });
    const secondAdmin = await createTenant({ isSuperadmin: true });
    const regular = await createTenant();
    const firstEmail = "seedance-admin-one@example.com";
    const secondEmail = "seedance-admin-two@example.com";

    mockFetchEmail.mockImplementation(async (clerkUserId: string) => {
      if (clerkUserId === firstAdmin.clerkUserId) return firstEmail;
      if (clerkUserId === secondAdmin.clerkUserId) return secondEmail;
      return null;
    });

    try {
      for (const admin of [firstAdmin, secondAdmin]) {
        await setNotificationPreference(
          admin.tenantId,
          SEEDANCE_PRICING_STALE,
          { inApp: true, email: true },
        );
      }

      const firstSnapshot = new Date("2026-08-01T00:00:00.000Z");
      await notifySeedancePricingStale(firstSnapshot, 7);

      const firstRows = await Promise.all(
        [firstAdmin, secondAdmin].map(async (admin) =>
          (await getNotifications(admin.tenantId)).filter(
            (row) => row.type === SEEDANCE_PRICING_STALE,
          ),
        ),
      );
      expect(firstRows[0]).toHaveLength(1);
      expect(firstRows[1]).toHaveLength(1);
      expect(firstRows[0][0]!.readAt).toBeNull();
      expect(firstRows[1][0]!.readAt).toBeNull();
      expect(
        (await getNotifications(regular.tenantId)).filter(
          (row) => row.type === SEEDANCE_PRICING_STALE,
        ),
      ).toHaveLength(0);

      const laterSnapshot = new Date("2026-08-02T00:00:00.000Z");
      await notifySeedancePricingStale(laterSnapshot, 7);

      for (const admin of [firstAdmin, secondAdmin]) {
        const rows = (await getNotifications(admin.tenantId)).filter(
          (row) => row.type === SEEDANCE_PRICING_STALE,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.message).toContain(laterSnapshot.toISOString());
        expect(rows[0]!.message).not.toContain(firstSnapshot.toISOString());
        expect(rows[0]!.readAt).toBeNull();
      }
      for (const email of [firstEmail, secondEmail]) {
        expect(
          mockSendEmail.mock.calls.filter((call) => call[0].to === email),
        ).toHaveLength(1);
      }

      await resolveSeedancePricingStaleNotifications();

      for (const admin of [firstAdmin, secondAdmin]) {
        const rows = (await getNotifications(admin.tenantId)).filter(
          (row) => row.type === SEEDANCE_PRICING_STALE,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.readAt).not.toBeNull();
      }

      const nextOutageSnapshot = new Date("2026-09-01T00:00:00.000Z");
      await notifySeedancePricingStale(nextOutageSnapshot, 7);

      for (const admin of [firstAdmin, secondAdmin]) {
        const rows = (await getNotifications(admin.tenantId)).filter(
          (row) => row.type === SEEDANCE_PRICING_STALE,
        );
        expect(rows).toHaveLength(2);
        expect(rows.filter((row) => row.readAt == null)).toHaveLength(1);
        expect(rows.find((row) => row.readAt == null)!.message).toContain(
          nextOutageSnapshot.toISOString(),
        );
      }
      for (const email of [firstEmail, secondEmail]) {
        expect(
          mockSendEmail.mock.calls.filter((call) => call[0].to === email),
        ).toHaveLength(2);
      }
    } finally {
      await deleteTenant(firstAdmin.tenantId);
      await deleteTenant(secondAdmin.tenantId);
      await deleteTenant(regular.tenantId);
    }
  });
});