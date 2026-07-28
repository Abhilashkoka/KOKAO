import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import request from "supertest";

/**
 * Confirms that turning the platform-wide carousel kill switch OFF also
 * downgrades an IN-PROGRESS chain resend: a publish that started while the
 * flag was ON (carousel item + a persisted resumable comment-chain snapshot)
 * must complete via the resend path as PLAIN posts — zero calls to the
 * LinkedIn Documents API (/rest/documents) — after an admin flips the real DB
 * flag row feature="carousel" to enabled=false.
 *
 * Two paths re-drive publishing for a partially failed publish:
 *  1. POST /content/:id/resend-linkedin-comments — posts only the missing
 *     follow-up comments from the snapshot.
 *  2. POST /content/:id/publish-linkedin re-clicked after a mid-publish
 *     failure — re-drives createLinkedinPost, whose carousel branch must be
 *     skipped when the flag is off.
 *
 * Uses the REAL feature-flag row in the shared dev DB (snapshotted and
 * restored), the REAL routers + tenant gate, and real DB rows — only Clerk
 * and outbound platform HTTP are mocked.
 */

vi.mock("@clerk/express", async () => {
  const { authState } = await import("../test/authState");
  return {
    getAuth: () =>
      authState.userId
        ? {
            userId: authState.userId,
            sessionClaims: { userId: authState.userId },
          }
        : {},
    clerkClient: {
      users: {
        getUser: async (id: string) => {
          const u = authState.users[id];
          if (!u) throw new Error("user not found");
          return u;
        },
      },
    },
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  };
});

vi.mock("../lib/tasteMemory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tasteMemory")>();
  return { ...actual, recordTasteSignalFromContent: vi.fn(async () => {}) };
});

import { db, featureFlagsTable, contentItemsTable, pool } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  insertLinkedinAccount,
  insertContentItem,
  getContentItem,
} from "../test/dbHelpers";
import { invalidateFeatureFlagCache } from "../lib/featureFlags";

const app = createTestApp();

const SLIDES = [
  {
    heading: "Slide 1",
    body: "First",
    imagePrompt: "p1",
    imagePath: "/objects/slides/s1.png",
  },
  {
    heading: "Slide 2",
    body: "Second",
    imagePrompt: "p2",
    imagePath: "/objects/slides/s2.png",
  },
];

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
  if (url.includes("api.linkedin.com/rest/socialActions/")) {
    if (method === "GET") return jsonRes(200, { elements: [] }); // comment probe
    return jsonRes(201, { id: "urn:li:comment:1" });
  }
  if (url.includes("api.linkedin.com/rest/posts")) {
    if (method === "GET") return jsonRes(200, { elements: [] }); // dedupe probe
    return jsonRes(201, {}, { "x-restli-id": "urn:li:share:7200" });
  }
  throw new Error(`Unexpected platform call in test: ${method} ${url}`);
}

beforeAll(async () => {
  process.env.SESSION_SECRET ||= "test-session-secret-value";
  // Snapshot whatever the shared dev DB holds. Each test flips the flag
  // itself (ON while the chain starts, OFF before the resend).
  const flagRows = await db
    .select()
    .from(featureFlagsTable)
    .where(eq(featureFlagsTable.feature, "carousel"));
  carouselFlagSnapshot = flagRows[0] ? { enabled: flagRows[0].enabled } : null;
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

async function setCarouselFlag(enabled: boolean): Promise<void> {
  await db
    .insert(featureFlagsTable)
    .values({ feature: "carousel", enabled })
    .onConflictDoUpdate({
      target: featureFlagsTable.feature,
      set: { enabled, updatedAt: new Date() },
    });
  invalidateFeatureFlagCache();
}

beforeEach(async () => {
  resetAuthState();
  fetchCalls = [];
  originalFetch = global.fetch;
  global.fetch = vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const method = (init?.method ?? "GET").toUpperCase();
      fetchCalls.push({ url, method });
      return routePlatformCall(url, method);
    },
  ) as unknown as typeof fetch;
  // The chain started while the flag was ON.
  await setCarouselFlag(true);
});

afterEach(() => {
  global.fetch = originalFetch;
});

function documentCalls(): FetchCall[] {
  return fetchCalls.filter((c) =>
    c.url.includes("api.linkedin.com/rest/documents"),
  );
}

describe("carousel switch turned off mid chain-resend", () => {
  it("resend-linkedin-comments completes the chain as plain comments with zero /rest/documents calls", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAccount(tenant.tenantId);
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "Carousel whose comment chain broke mid-publish",
        title: "In-progress chain",
        imagePath: null,
        carouselSlides: SLIDES,
      });
      // Simulate a publish that started while the flag was ON: the carousel
      // post landed, comment 1 of 3 posted, then the chain broke — the
      // publish path persisted this resumable snapshot.
      await db
        .update(contentItemsTable)
        .set({
          status: "published",
          postId: "urn:li:share:7100",
          linkedinCommentState: {
            postUrn: "urn:li:share:7100",
            comments: ["part 2 (2/3)", "part 3 (3/3)", "part 4 (4/4)"],
            postedCount: 1,
          },
        })
        .where(
          and(
            eq(contentItemsTable.id, itemId),
            eq(contentItemsTable.tenantId, tenant.tenantId),
          ),
        );

      // Admin turns the carousel switch OFF before the user hits resend.
      await setCarouselFlag(false);

      actAs(tenant.clerkUserId);
      const res = await request(app).post(
        `/api/content/${itemId}/resend-linkedin-comments`,
      );
      expect(res.status).toBe(200);
      expect(res.body.commentsPosted).toBe(3);
      expect(res.body.commentsRemaining).toBe(0);

      // The Documents API (carousel PDF path) was never touched, and no
      // document binary upload happened either.
      expect(documentCalls()).toHaveLength(0);
      expect(
        fetchCalls.filter((c) =>
          c.url.includes("linkedin-upload.test/doc-uploads"),
        ),
      ).toHaveLength(0);

      // The missing pieces went out as plain comment posts on the chain.
      const commentWrites = fetchCalls.filter(
        (c) =>
          c.method === "POST" &&
          c.url.includes("api.linkedin.com/rest/socialActions/"),
      );
      expect(commentWrites).toHaveLength(2);

      // Snapshot cleared: the chain is complete.
      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.linkedinCommentState).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("re-clicking Publish after a mid-publish failure re-drives createLinkedinPost as a PLAIN post when the flag is off", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAccount(tenant.tenantId);
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "Carousel publish that failed and is being retried",
        title: "Retry after flag off",
        imagePath: null,
        carouselSlides: SLIDES,
      });
      // The first attempt (flag ON) failed before anything landed.
      await db
        .update(contentItemsTable)
        .set({ status: "failed", failureReason: "LinkedIn API error (500)" })
        .where(
          and(
            eq(contentItemsTable.id, itemId),
            eq(contentItemsTable.tenantId, tenant.tenantId),
          ),
        );

      // Admin turns the carousel switch OFF before the retry.
      await setCarouselFlag(false);

      actAs(tenant.clerkUserId);
      const res = await request(app).post(
        `/api/content/${itemId}/publish-linkedin`,
      );
      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("urn:li:share:7200");

      // Zero carousel Documents API traffic; exactly one plain post write.
      expect(documentCalls()).toHaveLength(0);
      const createWrites = fetchCalls.filter(
        (c) =>
          c.method === "POST" && c.url.includes("api.linkedin.com/rest/posts"),
      );
      expect(createWrites).toHaveLength(1);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("urn:li:share:7200");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
