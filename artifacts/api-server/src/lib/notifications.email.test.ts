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
import { notifySocialConnectionFailed } from "./notifications";
import { createTenant, deleteTenant, getNotifications } from "../test/dbHelpers";

const mockFetchEmail = vi.mocked(fetchVerifiedEmail);
const mockSendEmail = vi.mocked(sendEmail);

const ORIGINAL_DOMAINS = process.env.REPLIT_DOMAINS;

beforeAll(() => {
  process.env.REPLIT_DOMAINS = "socialforge.example.com";
});

afterAll(async () => {
  if (ORIGINAL_DOMAINS === undefined) delete process.env.REPLIT_DOMAINS;
  else process.env.REPLIT_DOMAINS = ORIGINAL_DOMAINS;
  await pool.end();
});

beforeEach(() => {
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
});
