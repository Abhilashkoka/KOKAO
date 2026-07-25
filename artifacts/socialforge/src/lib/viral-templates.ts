/**
 * Proven short-form content formats. Each pattern pre-fills the topic input;
 * the ___ is where the user drops their subject.
 */
export interface ViralTemplate {
  id: string;
  label: string;
  pattern: string;
}

export const VIDEO_TOPIC_TEMPLATES: ViralTemplate[] = [
  {
    id: "listicle",
    label: "Listicle",
    pattern: "5 mistakes people make with ___ (and what to do instead)",
  },
  {
    id: "myth",
    label: "Myth-busting",
    pattern: "The biggest myth about ___ — and what actually works",
  },
  { id: "howto", label: "How-to", pattern: "How to ___ in under a week, step by step" },
  {
    id: "beforeafter",
    label: "Before / after",
    pattern: "What changed when we switched to ___ — the honest before and after",
  },
  {
    id: "pov",
    label: "Day in the life",
    pattern: "A day in the life of ___ — the parts nobody shows",
  },
  {
    id: "beginner",
    label: "Beginner's guide",
    pattern: "Everything a beginner needs to know about ___ in one minute",
  },
  {
    id: "comparison",
    label: "Comparison",
    pattern: "___ vs ___ — which one is actually worth your money?",
  },
  {
    id: "secrets",
    label: "Insider secrets",
    pattern: "3 things people in the ___ industry won't tell you",
  },
];
