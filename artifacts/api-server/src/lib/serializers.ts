import type {
  Tenant,
  ContentItem,
  ScheduledPost,
  ConnectedAccount,
} from "@workspace/db";
import { resolveAiModel } from "./aiModels";

export function serializeTenant(t: Tenant) {
  return {
    id: t.id,
    name: t.name,
    plan: t.plan,
    // Legacy rows may hold retired model names; surface a supported one so
    // the Settings page never round-trips an invalid value.
    aiModel: resolveAiModel(t.aiModel),
    industry: t.industry ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

export function serializeContent(c: ContentItem) {
  return {
    id: c.id,
    title: c.title,
    caption: c.caption,
    imagePath: c.imagePath ?? null,
    imagePrompt: c.imagePrompt ?? null,
    videoPath: c.videoPath ?? null,
    videoThumbnailPath: c.videoThumbnailPath ?? null,
    carouselSlides: c.carouselSlides ?? null,
    imageLayers: c.imageLayers ?? null,
    platform: c.platform,
    contentType: c.contentType,
    status: c.status,
    failureReason: c.failureReason ?? null,
    postId: c.postId ?? null,
    permalink: c.permalink ?? null,
    publishedPlatforms: c.publishedPlatforms ?? {},
    linkedinCommentsPending: c.linkedinCommentState
      ? Math.max(
          0,
          c.linkedinCommentState.comments.length -
            c.linkedinCommentState.postedCount,
        )
      : 0,
    threadsPostsPending: c.threadsChainState
      ? Math.max(
          0,
          c.threadsChainState.posts.length - c.threadsChainState.postedCount,
        )
      : 0,
    twitterPostsPending: c.twitterChainState
      ? Math.max(
          0,
          c.twitterChainState.posts.length - c.twitterChainState.postedCount,
        )
      : 0,
    brandKitId: c.brandKitId ?? null,
    campaignId: c.campaignId ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function serializeSchedule(s: ScheduledPost) {
  return {
    id: s.id,
    contentItemId: s.contentItemId,
    platform: s.platform,
    scheduledAt: s.scheduledAt.toISOString(),
    status: s.status,
    failureReason: s.failureReason,
    retryCount: s.retryCount,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function serializeAccount(a: ConnectedAccount) {
  const canPublish =
    !!a.accessToken &&
    (a.tokenExpiresAt === null || a.tokenExpiresAt.getTime() > Date.now());
  return {
    id: a.id,
    platform: a.platform,
    accountName: a.accountName,
    status: a.status,
    canPublish,
    createdAt: a.createdAt.toISOString(),
  };
}
