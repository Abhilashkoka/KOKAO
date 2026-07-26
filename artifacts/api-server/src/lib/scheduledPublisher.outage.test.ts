import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import {
  db,
  scheduledPostsTable,
  contentItemsTable,
  pool,
  type AppCredential,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  createTenant,
  deleteTenant,
  insertConnectedAccount,
  insertLinkedinAccount,
  insertThreadsAccount,
  insertTwitterAccount,
  insertContentItem,
  getContentItem,
  snapshotTwitterRow,
  setVerifiedTwitterRow,
  restoreTwitterRow,
} from "../test/dbHelpers";

/**
 * End-to-end confirmation that a scheduled post SURVIVES a real platform
 * outage: the schedule is due, the platform's HTTP API returns a 5xx on the
 * first executor tick, and succeeds on the retry tick. Unlike
 * scheduledPublisher.test.ts (which mocks the publish cores), this drives
 * the REAL per-platform cores (meta/linkedin/threads) against the real dev
 * DB, mocking only the outbound platform HTTP (`global.fetch`) and object
 * storage — guarding the wiring between the cores' transient-503
 * classification and the executor's bounded auto-retry.
 *
 * For each platform it asserts:
 * - after tick 1 the row is re-queued "pending" (not "failed"), retryCount 1
 * - after tick 2 the row ends "published"
 * - the platform saw EXACTLY ONE successful post-creating write (the failed
 *   attempt plus one success — no duplicate posts)
 */

vi.mock("./clerkUser", () => ({
  fetchVerifiedEmail: vi.fn(async () => null),
}));

// Taste signals fire on successful publishes and write per-tenant profile
// rows deleteTenant does not clean; no-op them to keep the shared dev DB tidy.
vi.mock("./tasteMemory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tasteMemory")>();
  return { ...actual, recordTasteSignalFromContent: vi.fn(async () => {}) };
});

vi.mock("./objectStorage", () => ({
  ObjectStorageService: class {
    async getObjectEntityFile() {
      return {
        async download() {
          return [Buffer.from("fake-image-bytes")] as [Buffer];
        },
      };
    }
    async getSignedDownloadURL() {
      return "https://storage.test/signed/image.png";
    }
  },
}));

import {
  runScheduledPublishTick,
  SCHEDULED_TRANSIENT_RETRY,
} from "./scheduledPublisher";
import {
  FB_PUBLISH_RETRY,
  IG_PUBLISH_RETRY,
  IG_CONTAINER_POLL,
} from "../routes/meta";

interface FetchCall {
  url: string;
  method: string;
}

let fetchCalls: FetchCall[];
/** When true, post-creating platform writes return a 500. */
let outage: boolean;

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

/**
 * Serve every outbound platform call the real cores make: pre-publish
 * re-verify reads, duplicate-post probes (always empty — nothing landed),
 * and the post-creating writes (500 during the outage, success after).
 */
function routePlatformCall(url: string, method: string): Response {
  // ---- LinkedIn ----
  if (url.includes("api.linkedin.com/v2/userinfo")) {
    return jsonRes(200, { sub: "li_person_123", name: "LinkedIn User" });
  }
  if (url.includes("api.linkedin.com/rest/images")) {
    // Image asset register (initializeUpload) — happens BEFORE the
    // post-creating write; a 500 here must be classified transient.
    if (outage) return jsonRes(500, { message: "temporarily down" });
    return jsonRes(200, {
      value: {
        uploadUrl: "https://linkedin-upload.test/dms-uploads/img1",
        image: "urn:li:image:img1",
      },
    });
  }
  if (url.includes("linkedin-upload.test/dms-uploads")) {
    return jsonRes(201, {}); // binary PUT of the image bytes
  }
  if (url.includes("api.linkedin.com/rest/posts")) {
    if (method === "GET") return jsonRes(200, { elements: [] }); // dedupe probe
    if (outage) return jsonRes(500, { message: "temporarily down" });
    return jsonRes(201, {}, { "x-restli-id": "urn:li:share:9001" });
  }

  // ---- Threads ----
  if (url.includes("graph.threads.net")) {
    if (url.includes("/threads_publish")) {
      return jsonRes(200, { id: "th_post_1" });
    }
    if (url.includes("/threads")) {
      if (method === "GET") return jsonRes(200, { data: [] }); // dedupe probe
      if (outage) return jsonRes(500, { error: { message: "temporarily down" } });
      return jsonRes(200, { id: "th_container_1" });
    }
    return jsonRes(200, {});
  }

  // ---- X (Twitter) ----
  if (url.includes("api.x.com")) {
    if (url.includes("/2/users/") && url.includes("/tweets")) {
      return jsonRes(200, { data: [], meta: {} }); // dedupe probe
    }
    if (url.includes("/2/media/upload")) {
      // INIT/APPEND/FINALIZE all hit this endpoint; a 500 on the first
      // call (INIT) during the outage exercises the media-upload transient
      // classification before any tweet-creating write happens.
      if (outage) return jsonRes(500, { detail: "media temporarily down" });
      return jsonRes(200, { data: { id: "tw_media_1" } });
    }
    if (url.includes("/2/tweets")) {
      if (outage) return jsonRes(500, { detail: "temporarily down" });
      return jsonRes(201, { data: { id: "tw_post_1" } });
    }
    return jsonRes(200, {});
  }

  // ---- Facebook / Instagram (Graph API) ----
  if (url.includes("graph.facebook.com")) {
    if (url.includes("/debug_token")) {
      // No app_id in the response = the app-mismatch check passes regardless
      // of whatever meta app row exists in the shared dev DB.
      return jsonRes(200, {
        data: {
          scopes: ["pages_read_engagement", "pages_manage_posts"],
          type: "PAGE",
          expires_at: 0,
        },
      });
    }
    if (url.includes("fields=id,name")) {
      return jsonRes(200, { id: "pg_1", name: "Test Page" }); // FB reverify
    }
    if (url.includes("fields=id,username")) {
      return jsonRes(200, { id: "ig_1", username: "iguser" }); // IG reverify
    }
    if (url.includes("fields=status_code")) {
      return jsonRes(200, { status_code: "FINISHED" }); // IG container poll
    }
    if (url.includes("fields=permalink")) {
      return jsonRes(200, { permalink: "https://instagram.com/p/x" });
    }
    if (method === "GET") {
      return jsonRes(200, { data: [] }); // FB /posts and IG /media dedupe probes
    }
    if (url.includes("/media_publish")) {
      return jsonRes(200, { id: "ig_post_1" });
    }
    if (url.includes("/media")) {
      if (outage) return jsonRes(500, { error: { message: "temporarily down" } });
      return jsonRes(200, { id: "ig_container_1" });
    }
    if (url.includes("/feed") || url.includes("/photos")) {
      if (outage) return jsonRes(500, { error: { message: "temporarily down" } });
      return jsonRes(200, { id: "fb_post_1" });
    }
    return jsonRes(200, {});
  }

  throw new Error(`Unexpected platform call in test: ${method} ${url}`);
}

const saved = {
  transient: { ...SCHEDULED_TRANSIENT_RETRY },
  fb: { ...FB_PUBLISH_RETRY },
  ig: { ...IG_PUBLISH_RETRY },
  igPoll: { ...IG_CONTAINER_POLL },
};

let originalFetch: typeof fetch;
let twitterAppSnapshot: AppCredential | null = null;

beforeAll(async () => {
  // The X core needs app-level OAuth client credentials to exist; snapshot
  // whatever the shared dev DB holds and restore it afterwards.
  twitterAppSnapshot = await snapshotTwitterRow();
  await setVerifiedTwitterRow();
  // Retry immediately (no real waiting) and let a single 500 exhaust the
  // cores' own seconds-scale retry budgets so tick 1 surfaces the 503.
  SCHEDULED_TRANSIENT_RETRY.delayMs = 0;
  FB_PUBLISH_RETRY.maxAttempts = 1;
  FB_PUBLISH_RETRY.initialDelayMs = 0;
  IG_PUBLISH_RETRY.maxAttempts = 1;
  IG_PUBLISH_RETRY.initialDelayMs = 0;
  IG_CONTAINER_POLL.initialDelayMs = 0;
});

afterAll(async () => {
  await restoreTwitterRow(twitterAppSnapshot);
  Object.assign(SCHEDULED_TRANSIENT_RETRY, saved.transient);
  Object.assign(FB_PUBLISH_RETRY, saved.fb);
  Object.assign(IG_PUBLISH_RETRY, saved.ig);
  Object.assign(IG_CONTAINER_POLL, saved.igPoll);
  await pool.end();
});

beforeEach(() => {
  fetchCalls = [];
  outage = true;
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

async function insertDueSchedule(
  tenantId: number,
  contentItemId: number,
  platform: string,
): Promise<number> {
  const [row] = await db
    .insert(scheduledPostsTable)
    .values({
      tenantId,
      contentItemId,
      platform,
      scheduledAt: new Date(Date.now() - 60_000),
      status: "pending",
    })
    .returning();
  return row.id;
}

async function getSchedule(id: number) {
  return (
    await db.select().from(scheduledPostsTable).where(eq(scheduledPostsTable.id, id))
  )[0];
}

interface PlatformCase {
  platform: string;
  /** Test-name suffix when a platform has more than one case. */
  label?: string;
  seed: (tenantId: number) => Promise<void>;
  withImage: boolean;
  /**
   * True when the outage hits a step BEFORE the post-creating write (e.g. the
   * X media upload), so tick 1 sees zero create writes instead of a failed one.
   */
  outageBeforeCreate?: boolean;
  /** Matches the platform's post-CREATING write (the call that must not duplicate). */
  isCreateWrite: (c: FetchCall) => boolean;
  expectedPostId: string;
}

const CASES: PlatformCase[] = [
  {
    platform: "linkedin",
    seed: async (tenantId) => {
      await insertLinkedinAccount(tenantId);
    },
    withImage: false,
    isCreateWrite: (c) =>
      c.method === "POST" && c.url.includes("api.linkedin.com/rest/posts"),
    expectedPostId: "urn:li:share:9001",
  },
  {
    platform: "linkedin",
    label: "with image",
    seed: async (tenantId) => {
      await insertLinkedinAccount(tenantId);
    },
    withImage: true,
    // The 500 lands on the image register (initializeUpload), before any
    // post-creating write — the schedule must still re-queue and publish.
    outageBeforeCreate: true,
    isCreateWrite: (c) =>
      c.method === "POST" && c.url.includes("api.linkedin.com/rest/posts"),
    expectedPostId: "urn:li:share:9001",
  },
  {
    platform: "threads",
    seed: async (tenantId) => {
      await insertThreadsAccount(tenantId, {
        // Far enough out that the silent token refresh is not due.
        tokenExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      });
    },
    withImage: false,
    isCreateWrite: (c) =>
      c.method === "POST" &&
      c.url.includes("graph.threads.net") &&
      c.url.includes("/threads") &&
      !c.url.includes("/threads_publish"),
    expectedPostId: "th_post_1",
  },
  {
    platform: "threads",
    label: "with image",
    seed: async (tenantId) => {
      await insertThreadsAccount(tenantId, {
        tokenExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      });
    },
    // An image post creates an IMAGE container (carrying the signed image
    // URL) before threads_publish; the 500 lands on that container create.
    withImage: true,
    isCreateWrite: (c) =>
      c.method === "POST" &&
      c.url.includes("graph.threads.net") &&
      c.url.includes("/threads") &&
      !c.url.includes("/threads_publish"),
    expectedPostId: "th_post_1",
  },
  {
    platform: "twitter",
    seed: async (tenantId) => {
      // Token expiry defaults far enough out that no refresh is due — the
      // outage hits the tweet-creating write itself.
      await insertTwitterAccount(tenantId);
    },
    withImage: false,
    isCreateWrite: (c) =>
      c.method === "POST" && c.url.includes("api.x.com/2/tweets"),
    expectedPostId: "tw_post_1",
  },
  {
    platform: "twitter",
    label: "with image",
    seed: async (tenantId) => {
      await insertTwitterAccount(tenantId);
    },
    withImage: true,
    // The 500 lands on the media-upload INIT, before any tweet-creating
    // write — the schedule must still re-queue and publish on the retry.
    outageBeforeCreate: true,
    isCreateWrite: (c) =>
      c.method === "POST" &&
      c.url.includes("api.x.com/2/tweets") &&
      !c.url.includes("/2/media/upload"),
    expectedPostId: "tw_post_1",
  },
  {
    platform: "facebook",
    seed: async (tenantId) => {
      await insertConnectedAccount(
        tenantId,
        "facebook",
        { pageId: "pg_1", pageAccessToken: "pg_token" },
        "verified",
      );
    },
    withImage: false,
    isCreateWrite: (c) => c.method === "POST" && c.url.includes("/feed"),
    expectedPostId: "fb_post_1",
  },
  {
    platform: "facebook",
    label: "with image",
    seed: async (tenantId) => {
      await insertConnectedAccount(
        tenantId,
        "facebook",
        { pageId: "pg_1", pageAccessToken: "pg_token" },
        "verified",
      );
    },
    withImage: true,
    // Photo posts go through the /photos endpoint instead of /feed; a 5xx
    // there must be classified transient exactly like the text-only path.
    isCreateWrite: (c) => c.method === "POST" && c.url.includes("/photos"),
    expectedPostId: "fb_post_1",
  },
  {
    platform: "instagram",
    seed: async (tenantId) => {
      await insertConnectedAccount(
        tenantId,
        "facebook",
        { pageId: "pg_1", pageAccessToken: "pg_token" },
        "verified",
      );
      await insertConnectedAccount(
        tenantId,
        "instagram",
        { igUserId: "ig_1" },
        "verified",
      );
    },
    withImage: true,
    // The container create is the write that lands content on Instagram;
    // media_publish only flips an existing container live.
    isCreateWrite: (c) =>
      c.method === "POST" &&
      c.url.includes("/media") &&
      !c.url.includes("/media_publish"),
    expectedPostId: "ig_post_1",
  },
];

describe("scheduled publish survives a platform outage (real cores, mocked HTTP)", () => {
  for (const tc of CASES) {
    const name = tc.label ? `${tc.platform} (${tc.label})` : tc.platform;
    it(`${name}: 5xx on the first tick, published on the retry tick, no duplicate writes`, async () => {
      const tenant = await createTenant();
      try {
        await tc.seed(tenant.tenantId);
        const itemId = await insertContentItem(tenant.tenantId, {
          caption: `Outage survivor ${tc.platform}`,
          title: "Outage post",
          imagePath: tc.withImage
            ? `/objects/${tenant.tenantId}/uploads/test-image.png`
            : null,
        });
        const scheduleId = await insertDueSchedule(
          tenant.tenantId,
          itemId,
          tc.platform,
        );

        // Tick 1: the platform is down — the core surfaces 503 and the
        // executor re-queues instead of failing.
        await runScheduledPublishTick();

        const afterOutage = await getSchedule(scheduleId);
        expect(afterOutage.status).toBe("pending");
        expect(afterOutage.retryCount).toBe(1);
        expect(afterOutage.failureReason).toBeTruthy();
        const failedWrites = fetchCalls.filter(tc.isCreateWrite).length;
        if (tc.outageBeforeCreate) {
          // The outage struck before the create write — nothing may have
          // reached the post-creating endpoint yet.
          expect(failedWrites).toBe(0);
        } else {
          expect(failedWrites).toBeGreaterThanOrEqual(1);
        }

        // Tick 2: the outage clears — the retry publishes.
        outage = false;
        await runScheduledPublishTick();

        const finished = await getSchedule(scheduleId);
        expect(finished.status).toBe("published");
        expect(finished.failureReason).toBeNull();

        // Exactly ONE more create write than during the outage tick — the
        // retry posted once, never twice.
        const totalWrites = fetchCalls.filter(tc.isCreateWrite).length;
        expect(totalWrites).toBe(failedWrites + 1);

        // The content item reflects the single successful platform post.
        const item = await getContentItem(itemId, tenant.tenantId);
        expect(item.status).toBe("published");
        expect(item.postId).toBe(tc.expectedPostId);
      } finally {
        await deleteTenant(tenant.tenantId);
      }
    });
  }
});
