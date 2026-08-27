export const VIDEO_ASPECTS = [
  { value: "9:16", label: "9:16", note: "Reels, Shorts, Stories" },
  { value: "4:5", label: "4:5", note: "Instagram feed" },
  { value: "1:1", label: "1:1", note: "Square feed" },
  { value: "16:9", label: "16:9", note: "YouTube, LinkedIn" },
  { value: "4:3", label: "4:3", note: "Classic" },
  { value: "3:4", label: "3:4", note: "Tall classic" },
  { value: "21:9", label: "21:9", note: "Cinemascope" },
] as const;

export type VideoAspect = (typeof VIDEO_ASPECTS)[number]["value"];