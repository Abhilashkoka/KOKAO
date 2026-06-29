import type {
  Tenant,
  BrandKit,
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
    createdAt: t.createdAt.toISOString(),
  };
}

export function serializeBrandKit(b: BrandKit) {
  return {
    id: b.id,
    name: b.name,
    primaryColor: b.primaryColor,
    secondaryColor: b.secondaryColor,
    accentColor: b.accentColor,
    voice: b.voice,
    hashtags: b.hashtags,
    logoPath: b.logoPath ?? null,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
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
    status: c.status,
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
  return {
    id: a.id,
    platform: a.platform,
    accountName: a.accountName,
    status: a.status,
    createdAt: a.createdAt.toISOString(),
  };
}
