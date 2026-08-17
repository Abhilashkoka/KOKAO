import type { PromptBlock, PromptFlowKey } from "@workspace/db";

/**
 * Seed data for the Prompt Template Kit: one case type per real flow key.
 * Consumed by scripts/seed-prompt-kit.ts (which inserts it) and by tests
 * (which assert every real flow key is bound to a seeded case).
 */
export const SEEDS: Array<{
  slug: string;
  name: string;
  description: string;
  flowKey: PromptFlowKey;
  riskLevel: "low" | "high";
  templateTitle: string;
  blocks: PromptBlock[];
}> = [
  {
    slug: "everyday-caption",
    name: "Everyday caption",
    description: "Day-to-day single-platform caption writing.",
    flowKey: "caption",
    riskLevel: "low",
    templateTitle: "Everyday caption v-base",
    blocks: [
      {
        id: "blk_role",
        title: "Role",
        content:
          "You are a senior {{platform}} copywriter with a decade of hands-on niche experience. Write one caption plus a short creative-brief title (3-8 words).",
        mandatory: true,
        order: 1,
      },
      {
        id: "blk_quality",
        title: "Quality bar",
        content:
          "Open with a strong hook, write like a human expert (specific, concrete, no fluff), and match the requested tone exactly.",
        mandatory: true,
        order: 2,
      },
      {
        id: "blk_extras",
        title: "Optional flourishes",
        content: "Where natural, end with a light call-to-action question.",
        mandatory: false,
        order: 3,
      },
    ],
  },
  {
    slug: "brand-image",
    name: "Brand image",
    description: "AI image generation guidance for on-brand visuals.",
    flowKey: "image",
    riskLevel: "low",
    templateTitle: "Brand image v-base",
    blocks: [
      {
        id: "blk_style",
        title: "Visual style",
        content:
          "Produce a clean, professional social-media visual: strong single subject, uncluttered composition, natural lighting, no text overlays unless asked.",
        mandatory: true,
        order: 1,
      },
    ],
  },
  {
    slug: "multi-platform-campaign",
    name: "Multi-platform campaign",
    description: "Coordinated campaign copy across several platforms.",
    flowKey: "campaign",
    riskLevel: "high",
    templateTitle: "Campaign master v-base",
    blocks: [
      {
        id: "blk_role",
        title: "Role",
        content:
          "You are a senior social media strategist running a multi-platform campaign for {{platforms}}. Draft the roomiest platform first, then condense down without losing the core hook.",
        mandatory: true,
        order: 1,
      },
      {
        id: "blk_consistency",
        title: "Consistency",
        content:
          "Every platform variant must carry the same core message and offer; adapt format and length, never the substance.",
        mandatory: true,
        order: 2,
      },
    ],
  },
  {
    slug: "topic-video-script",
    name: "Topic video script",
    description: "Narration scripts for short vertical videos.",
    flowKey: "video_script",
    riskLevel: "low",
    templateTitle: "Video narration v-base",
    blocks: [
      {
        id: "blk_voice",
        title: "Narration voice",
        content:
          "You write narration for short vertical videos: spoken words only, straight to the point, no markdown, no speaker labels, same language as the topic.",
        mandatory: true,
        order: 1,
      },
    ],
  },
  {
    slug: "video-scene-image",
    name: "Video scene image",
    description: "Image-generation guidance for video scene stills and b-roll.",
    flowKey: "video_scene_image",
    riskLevel: "low",
    templateTitle: "Scene image v-base",
    blocks: [
      {
        id: "blk_scene",
        title: "Scene style",
        content:
          "Produce cinematic, photorealistic scene stills: one clear subject per frame, coherent lighting across scenes, no text overlays or watermarks.",
        mandatory: true,
        order: 1,
      },
    ],
  },
  {
    slug: "video-motion",
    name: "Video motion",
    description:
      "The motion instruction appended to image-to-video prompts (character scenes and animated AI b-roll).",
    flowKey: "video_motion",
    riskLevel: "low",
    templateTitle: "Motion instruction v-base",
    blocks: [
      {
        id: "blk_motion",
        title: "Motion style",
        content: "Subtle natural motion, cinematic.",
        mandatory: true,
        order: 1,
      },
    ],
  },
  {
    slug: "multi-slide-carousel",
    name: "Multi-slide carousel",
    description: "Multi-slide carousel design: per-slide copy plus image prompts.",
    flowKey: "carousel",
    riskLevel: "low",
    templateTitle: "Carousel designer v-base",
    blocks: [
      {
        id: "blk_role",
        title: "Role",
        content:
          "You are a senior social media strategist and carousel designer. Design a {{slideCount}}-slide carousel with a deliberate narrative arc: slide 1 hooks, middle slides each carry one idea, the last slide pays off with a call to action.",
        mandatory: true,
        order: 1,
      },
      {
        id: "blk_visuals",
        title: "Visual system",
        content:
          "Every slide's image prompt must visually communicate that slide's specific information and keep one consistent visual system (colors, layout, typography) across the whole carousel.",
        mandatory: true,
        order: 2,
      },
    ],
  },
];

/** Every real flow key must be bound to exactly one seeded case. */
export function unseededFlowKeys(allFlowKeys: readonly string[]): string[] {
  const seeded = new Set(SEEDS.map((s) => s.flowKey as string));
  return allFlowKeys.filter((k) => !seeded.has(k));
}
