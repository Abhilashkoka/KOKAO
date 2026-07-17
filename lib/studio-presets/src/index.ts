/**
 * Studio tweak chips shared by the web and mobile Studio screens. Keeping the
 * labels and AI instructions in one place guarantees both platforms show the
 * same chips and send the AI the exact same instruction text.
 */
export const CAPTION_TWEAKS = [
  { label: "Shorter", instruction: "Make the caption shorter and more concise." },
  { label: "Punchier", instruction: "Make the caption punchier and more attention-grabbing." },
  { label: "More formal", instruction: "Make the caption more formal and professional." },
] as const;

export type CaptionTweak = (typeof CAPTION_TWEAKS)[number];
