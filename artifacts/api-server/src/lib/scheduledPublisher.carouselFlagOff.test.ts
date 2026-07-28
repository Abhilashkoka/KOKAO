import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { db, featureFlagsTable, scheduledPostsTable, pool } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  createTenant,
  deleteTenant,
  insertLinkedinAccount,
  insertContentItem,
  getContentItem,
} from "../test/dbHelpers";

/**
 * Confirms a SCHEDULED carousel item still goes out as a plain post when the
 * platform-wide carousel kill switch is OFF: an admin can disable the flag
 * between scheduling and the due time, and createLinkedinPost must fall back
 * from the Documents API (PDF carousel) to the plain text publish path.
 *
 * Uses the REAL feature-flag row in the dev DB (isFeatureEnabled reads the
 * DB, not a module mock), the REAL LinkedIn publish core, and the real
 * scheduled publisher tick — only outbound platform HTTP and object storage
 * are mocked. Asserts ZERO hits to /rest/documents and exactly one
 * post-creating write to /rest/posts.
 */

vi.mock("./clerkUser", () => ({
  fetchVerifiedEmail: vi.fn(async () => null),
}));

vi.mock("./tasteMemory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tasteMemory")>();
  return { ...actual, recordTasteSignalFromContent: vi.fn(async () => {}) };
});

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

vi.mock("./objectStorage", () => ({
  ObjectStorageService: class {
    async getObjectEntityFile() {
      return {
        async download() {
          return [TINY_PNG] as [Buffer];
        },
      };
    }
    async getSignedDownloadURL() {
      return "https://storage.test/signed/image.png";
    }
  },
}));

import { runScheduledPublishTick } from "./scheduledPublisher";
import { invalidateFeatureFlagCache } from "./featureFlags";

interface FetchCall {
  url: string;
  method: string;
}

let fetchCalls: FetchCall[];
let originalFetch: typeof fetch;
/** Pre-test state of the real DB carousel flag row (null = no row). */
let carouselFlagSnapshot: { enabled: boolean } | null = null;

function jsonRes(
  status: number,
  json: unknown,
  headers: Record<string, string> = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response;
}

function routePlatformCall(url: string, method: string): Response {
  if (url.includes("api.linkedin.com/v2/userinfo")) {
    return jsonRes(200, { sub: "li_person_123", name: "LinkedIn User" });
  }
  if (url.includes("api.linkedin.com/rest/documents")) {
    // Must never be reached with the flag off — answer anyway so a
    // regression fails on the call-count assertion, not a routing throw.
    return jsonRes(200, {
      value: {
        uploadUrl: "https://linkedin-upload.test/doc-uploads/doc1",
        document: "urn:li:document:doc1",
      },
    });
  }
  if (url.includes("api.linkedin.com/rest/images")) {
    return jsonRes(200, {
      value: {
        uploadUrl: "https://linkedin-upload.test/dms-uploads/img1",
        image: "urn:li:image:img1",
      },
    });
  }
  if (url.includes("linkedin-upload.test/")) {
    return jsonRes(201, {});
  }
  if (url.includes("api.linkedin.com/rest/posts")) {
    if (method === "GET") return jsonRes(200, { elements: [] }); // dedupe probe
    return jsonRes(201, {}, { "x-restli-id": "urn:li:share:7100" });
  }
  throw new Error(`Unexpected platform call in test: ${method} ${url}`);
}

beforeAll(async () => {
  // Snapshot whatever the shared dev DB holds, then force the REAL carousel
  // flag row OFF (real row + cache invalidation, not a module mock).
  const flagRows = await db
    .select()
    .from(featureFlagsTable)
    .where(eq(featureFlagsTable.feature, "carousel"));
  carouselFlagSnapshot = flagRows[0] ? { enabled: flagRows[0].enabled } : null;
  await db
    .insert(featureFlagsTable)
    .values({ feature: "carousel", enabled: false })
    .onConflictDoUpdate({
      target: featureFlagsTable.feature,
      set: { enabled: false, updatedAt: new Date() },
    });
  invalidateFeatureFlagCache();
});

afterAll(async () => {
  if (carouselFlagSnapshot) {
    await db
      .update(featureFlagsTable)
      .set({ enabled: carouselFlagSnapshot.enabled, updatedAt: new Date() })
      .where(eq(featureFlagsTable.feature, "carousel"));
  } else {
    await db
      .delete(featureFlagsTable)
      .where(eq(featureFlagsTable.feature, "carousel"));
  }
  invalidateFeatureFlagCache();
  await pool.end();
});

beforeEach(() => {
  fetchCalls = [];
  originalFetch = global.fetch;
  global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = (init?.method ?? "GET").toUpperCase();
    fetchCalls.push({ url, method });
    return routePlatformCall(url, method);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("scheduled carousel publish with the carousel kill switch OFF", () => {
  it("publishes as a plain post: zero /rest/documents calls, one /rest/posts write", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAccount(tenant.tenantId);
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "Carousel scheduled before the switch went off",
        title: "Flag-off carousel",
        imagePath: null,
        carouselSlides: [
          { heading: "Slide 1", body: "First", imagePrompt: "p1", imagePath: "/objects/slides/s1.png" },
          { heading: "Slide 2", body: "Second", imagePrompt: "p2", imagePath: "/objects/slides/s2.png" },
        ],
      });
      const [schedule] = await db
        .insert(scheduledPostsTable)
        .values({
          tenantId: tenant.tenantId,
          contentItemId: itemId,
          platform: "linkedin",
          scheduledAt: new Date(Date.now() - 60_000),
          status: "pending",
        })
        .returning();

      await runScheduledPublishTick();

      const [finished] = await db
        .select()
        .from(scheduledPostsTable)
        .where(eq(scheduledPostsTable.id, schedule.id));
      expect(finished.status).toBe("published");
      expect(finished.failureReason).toBeNull();

      // The Documents API (carousel PDF path) was never touched.
      const documentCalls = fetchCalls.filter((c) =>
        c.url.includes("api.linkedin.com/rest/documents"),
      );
      expect(documentCalls).toHaveLength(0);
      // No document binary upload either.
      expect(
        fetchCalls.filter((c) => c.url.includes("linkedin-upload.test/doc-uploads")),
      ).toHaveLength(0);

      // Exactly one post-creating write to /rest/posts (plain post).
      const createWrites = fetchCalls.filter(
        (c) => c.method === "POST" && c.url.includes("api.linkedin.com/rest/posts"),
      );
      expect(createWrites).toHaveLength(1);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("urn:li:share:7100");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
