import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

// Mock the two side channels a breakage triggers so this test stays hermetic:
// a real Clerk email lookup and a real SendGrid send are both stubbed.
vi.mock("./clerkUser", () => ({
  fetchVerifiedEmail: vi.fn(async () => "tenant@example.com"),
}));
vi.mock("./email", () => ({
  sendEmail: vi.fn(async () => true),
}));

import { pool } from "@workspace/db";
import { fetchVerifiedEmail } from "./clerkUser";
import { sendEmail } from "./email";
import {
  notifySocialConnectionFailed,
  SOCIAL_CONNECTION_FAILED,
} from "./notifications";
import {
  createTenant,
  deleteTenant,
  getNotifications,
  setNotificationPreference,
  setNotificationPolicy,
  snapshotNotificationPolicy,
  clearNotificationPolicy,
  restoreNotificationPolicy,
} from "../test/dbHelpers";

const mockFetchEmail = vi.mocked(fetchVerifiedEmail);
const mockSendEmail = vi.mocked(sendEmail);

const ORIGINAL_DOMAINS = process.env.REPLIT_DOMAINS;
let policySnapshot: Awaited<ReturnType<typeof snapshotNotificationPolicy>>;

beforeAll(async () => {
  process.env.REPLIT_DOMAINS = "socialforge.example.com";
  // The dispatch path folds in the global policy for this type. Snapshot the
  // shared dev row and clear it so the default "optional" policy applies unless
  // a specific test overrides it; restored in afterAll.
  policySnapshot = await snapshotNotificationPolicy(SOCIAL_CONNECTION_FAILED);
});

afterAll(async () => {
  if (ORIGINAL_DOMAINS === undefined) delete process.env.REPLIT_DOMAINS;
  else process.env.REPLIT_DOMAINS = ORIGINAL_DOMAINS;
  await restoreNotificationPolicy(SOCIAL_CONNECTION_FAILED, policySnapshot);
  await pool.end();
});

beforeEach(async () => {
  // Default policy (optional) for every test; policy-authority tests set their
  // own row explicitly.
  await clearNotificationPolicy(SOCIAL_CONNECTION_FAILED);
  vi.clearAllMocks();
  mockFetchEmail.mockResolvedValue("tenant@example.com");
  mockSendEmail.mockResolvedValue(true);
});

describe("notifySocialConnectionFailed email side channel", () => {
  it("emails the tenant's verified address with an absolute reconnect link on a fresh breakage", async () => {
    const tenant = await createTenant();
    try {
      await notifySocialConnectionFailed(tenant.tenantId, "facebook");

      expect(mockFetchEmail).toHaveBeenCalledWith(tenant.clerkUserId);
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      const msg = mockSendEmail.mock.calls[0][0];
      expect(msg.to).toBe("tenant@example.com");
      expect(msg.subject).toMatch(/Facebook Page disconnected/i);
      expect(msg.text).toContain(
        "https://socialforge.example.com/accounts",
      );
      expect(msg.html).toContain(
        "https://socialforge.example.com/accounts",
      );
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("emails only once per breakage (deduped like the in-app notification)", async () => {
    const tenant = await createTenant();
    try {
      await notifySocialConnectionFailed(tenant.tenantId, "facebook");
      await notifySocialConnectionFailed(tenant.tenantId, "facebook");

      const notes = await getNotifications(tenant.tenantId);
      expect(notes).toHaveLength(1);
      // Second call hit the dedupe guard, so no second email.
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("does not send when the tenant has no verified email", async () => {
    mockFetchEmail.mockResolvedValue(null);
    const tenant = await createTenant();
    try {
      await notifySocialConnectionFailed(tenant.tenantId, "instagram");

      const notes = await getNotifications(tenant.tenantId);
      expect(notes).toHaveLength(1);
      expect(mockSendEmail).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("does not email when the tenant opted out (email=false) but still records the in-app notification", async () => {
    const tenant = await createTenant();
    try {
      await setNotificationPreference(tenant.tenantId, SOCIAL_CONNECTION_FAILED, {
        inApp: true,
        email: false,
      });

      await notifySocialConnectionFailed(tenant.tenantId, "facebook");

      // In-app notification is still recorded (banner visibility preserved)...
      const notes = await getNotifications(tenant.tenantId);
      expect(notes).toHaveLength(1);
      expect(notes[0].inApp).toBe(true);
      // ...but the opted-out email channel is skipped entirely.
      expect(mockSendEmail).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("notifySocialConnectionFailed policy authority", () => {
  it('emails even when the tenant chose email=false if the policy is "forced"', async () => {
    await setNotificationPolicy(SOCIAL_CONNECTION_FAILED, {
      enabled: true,
      emailPolicy: "forced",
    });
    const tenant = await createTenant();
    try {
      await setNotificationPreference(tenant.tenantId, SOCIAL_CONNECTION_FAILED, {
        inApp: true,
        email: false,
      });

      await notifySocialConnectionFailed(tenant.tenantId, "facebook");

      // Forced policy overrides the tenant's opt-out.
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      const notes = await getNotifications(tenant.tenantId);
      expect(notes).toHaveLength(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it('suppresses email even when the tenant chose email=true if the policy is "off"', async () => {
    await setNotificationPolicy(SOCIAL_CONNECTION_FAILED, {
      enabled: true,
      emailPolicy: "off",
    });
    const tenant = await createTenant();
    try {
      await setNotificationPreference(tenant.tenantId, SOCIAL_CONNECTION_FAILED, {
        inApp: true,
        email: true,
      });

      await notifySocialConnectionFailed(tenant.tenantId, "facebook");

      // "off" policy overrides the tenant's opt-in; in-app is still recorded.
      expect(mockSendEmail).not.toHaveBeenCalled();
      const notes = await getNotifications(tenant.tenantId);
      expect(notes).toHaveLength(1);
      expect(notes[0].inApp).toBe(true);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("records nothing and emails nothing when the type is disabled platform-wide", async () => {
    await setNotificationPolicy(SOCIAL_CONNECTION_FAILED, {
      enabled: false,
      emailPolicy: "optional",
    });
    const tenant = await createTenant();
    try {
      await notifySocialConnectionFailed(tenant.tenantId, "facebook");

      // A disabled type produces neither an in-app row nor an email.
      const notes = await getNotifications(tenant.tenantId);
      expect(notes).toHaveLength(0);
      expect(mockSendEmail).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
