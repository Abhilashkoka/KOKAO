type Source = { text: string; sourceType: "guided_script" | "walkthrough_script" | "character_script" | "narration" | "brief" };
type Result = { caption: string; hashtags: string[]; title?: string; clarifyingQuestions?: string[] };

export const VIDEO_COPY_LIMITS: Record<string, number> = {
  instagram: 2200,
  twitter: 280,
  threads: 500,
  linkedin: 3000,
  facebook: 5000,
  youtube: 5000,
};
export const VIDEO_COPY_HASHTAG_LIMITS: Record<string, number> = {
  instagram: 5,
  twitter: 3,
  threads: 3,
  linkedin: 5,
  facebook: 5,
  youtube: 3,
};

/** Maximum title length per destination (YouTube enforces 100). */
export function videoCopyTitleLimit(platform: string) {
  return platform === "youtube" ? 100 : 200;
}

export const VIDEO_COPY_SOURCE_LABELS: Record<Source["sourceType"], string> = {
  guided_script: "saved guided video script",
  walkthrough_script: "saved walkthrough script",
  character_script: "saved character script",
  narration: "saved narration",
  brief: "original brief (not a transcript)",
};

export function videoLibraryCopyPrompt(source: Source, platform: string) {
  const limit = VIDEO_COPY_LIMITS[platform];
  if (!limit) throw new Error("Select a supported platform.");
  const sourceLabel = source.sourceType === "brief" ? "the creator's brief (NOT a video transcript)"
    : source.sourceType === "narration" ? "the saved narration"
    : "the saved video script";
  return `Write a catchy, accurate short title (max ${videoCopyTitleLimit(platform)} characters), a platform-appropriate ${platform === "youtube" ? "YouTube video description" : "social video caption"} and relevant hashtags for ${platform} using only ${sourceLabel} below. Match the source language. Do not claim to have watched the video or invent footage, product claims, links or scenes not in the source. Provide a complete JSON result with title, caption and hashtags. The ENTIRE caption including spaces, line breaks and hashtags must fit within ${limit} characters. Include at most ${VIDEO_COPY_HASHTAG_LIMITS[platform]} relevant hashtags TOTAL, including any inline in the caption; Instagram must never have more than 5. Avoid duplicate hashtags. Do not silently remove hashtags to satisfy a limit. Source:\n\n${source.text.slice(0, 9000)}`;
}

export function formatVideoLibraryCopy(result: Result, platform: string): { title: string; caption: string } {
  const limit = VIDEO_COPY_LIMITS[platform];
  if (!limit) throw new Error("Select a supported platform.");
  if (result.clarifyingQuestions?.length) throw new Error(`More detail needed: ${result.clarifyingQuestions.join(" ")}`);
  const title = result.title?.trim() ?? "";
  const titleLimit = videoCopyTitleLimit(platform);
  if (!title || title.length > titleLimit) throw new Error(`The generated title is missing or exceeds ${titleLimit} characters. Please retry or write a title.`);
  const caption = result.caption?.trim() ?? "";
  if (!caption) throw new Error("No caption was generated. Please try again.");
  const inlineTags = Array.from(caption.matchAll(/#[\p{L}\p{N}_]+/gu), (match) => match[0].toLowerCase());
  const existing = new Set(inlineTags);
  if (inlineTags.length !== existing.size) {
    throw new Error("Generated copy repeats an inline hashtag. Please retry or edit it yourself.");
  }
  const tags: string[] = [];
  for (const raw of result.hashtags ?? []) {
    const tag = `#${raw.replace(/^#+/, "").trim()}`;
    if (!/^#[\p{L}\p{N}_]+$/u.test(tag)) {
      throw new Error("Generated copy contains an invalid hashtag. Please retry or edit it yourself.");
    }
    if (existing.has(tag.toLowerCase())) continue;
    existing.add(tag.toLowerCase());
    tags.push(tag);
  }
  const hashtagMaximum = VIDEO_COPY_HASHTAG_LIMITS[platform];
  if ((platform === "twitter" || platform === "threads") && existing.size === 0) {
    throw new Error(`Generated ${platform} copy needs at least one hashtag. Please retry.`);
  }
  if (existing.size > hashtagMaximum) {
    throw new Error(`Generated copy contains ${existing.size} hashtags; ${platform} allows ${hashtagMaximum}. Please retry or edit it yourself.`);
  }
  const complete = caption + (tags.length ? `\n\n${tags.join(" ")}` : "");
  if (complete.length > limit) throw new Error(`Generated caption including hashtags is ${complete.length} characters; ${platform} allows ${limit}. Please retry with a shorter caption or edit it yourself.`);
  return { title, caption: complete };
}