import { videoStyleProfilesTable, type VideoStyleProfilePayload } from "@workspace/db";
import { sql } from "drizzle-orm";

// Reserved JSON payload marker, not a name pattern: users may legitimately
// choose any template name. Only test code may write this value.
export const TEST_TEMPLATE_MARKER_KEY = "__kokaoApiTestFixture";
export const TEST_TEMPLATE_MARKER_VALUE = "video-template-v1";
// Historical unmarked presenter fixtures are only tagged after exact manual
// fingerprint review. Keep them reversible; the run guard must not purge them.
export const HISTORICAL_PRESENTER_MARKER_VALUE = "historical-presenter-v1";

export function markTestTemplatePayload<T extends VideoStyleProfilePayload>(payload: T): T {
  return { ...payload, [TEST_TEMPLATE_MARKER_KEY]: TEST_TEMPLATE_MARKER_VALUE };
}

export function isTestTemplate(payload: VideoStyleProfilePayload): boolean {
  return (payload as unknown as Record<string, unknown>)[TEST_TEMPLATE_MARKER_KEY] === TEST_TEMPLATE_MARKER_VALUE;
}

export function visibleVideoTemplate() {
  return process.env.NODE_ENV === "test"
    ? sql`true`
    : sql`coalesce(${videoStyleProfilesTable.payload} ->> ${TEST_TEMPLATE_MARKER_KEY}, '') NOT IN (${TEST_TEMPLATE_MARKER_VALUE}, ${HISTORICAL_PRESENTER_MARKER_VALUE})`;
}