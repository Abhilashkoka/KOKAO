import { sql, type SQL } from "drizzle-orm";
import { contentItemsTable } from "@workspace/db";

/**
 * SQL fragment that merges one platform's publish record into the item's
 * cumulative publishedPlatforms map (jsonb || jsonb). Republishing to the
 * same platform overwrites only that platform's entry; other platforms'
 * entries are preserved. Done in SQL so concurrent publishes to different
 * platforms cannot clobber each other's entries.
 */
export type PublishablePlatform =
  | "facebook"
  | "instagram"
  | "linkedin"
  | "twitter"
  | "threads";

export function mergePublishedPlatform(
  platform: PublishablePlatform,
  info: { postId?: string | null; permalink?: string | null },
): SQL {
  const entry = JSON.stringify({
    [platform]: {
      postId: info.postId ?? null,
      permalink: info.permalink ?? null,
      publishedAt: new Date().toISOString(),
    },
  });
  return sql`COALESCE(${contentItemsTable.publishedPlatforms}, '{}'::jsonb) || ${entry}::jsonb`;
}
