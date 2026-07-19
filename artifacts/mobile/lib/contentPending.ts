import type { ContentItem } from "@workspace/api-client-react";

export const PENDING_TEXT = "#92600a";

export function hasPendingPieces(item: ContentItem): boolean {
  return (
    (item.linkedinCommentsPending ?? 0) > 0 ||
    (item.threadsPostsPending ?? 0) > 0 ||
    (item.twitterPostsPending ?? 0) > 0
  );
}
