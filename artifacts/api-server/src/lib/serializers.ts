import type {
  Tenant,
  ContentItem,
  ScheduledPost,
  ConnectedAccount,
} from "@workspace/db";

export function serializeTenant(t: Tenant) {
  return {
    id: t.id,
    name: t.name,
    plan: t.plan,
    aiModel: t.aiModel,
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
    platform: c.platform,
    contentType: c.contentType,
    status: c.status,
    failureReason: c.failureReason ?? null,
    postId: c.postId ?? null,
    permalink: c.permalink ?? null,
    brandKitId: c.brandKitId ?? null,
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
