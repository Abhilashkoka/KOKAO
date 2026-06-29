export interface PlanLimits {
  captions: number;
  images: number;
  brandKits: number;
  scheduledPosts: number;
}

export interface Plan {
  id: string;
  name: string;
  priceLabel: string;
  limits: PlanLimits;
  features: string[];
}

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    priceLabel: "$0 / mo",
    limits: { captions: 20, images: 10, brandKits: 1, scheduledPosts: 10 },
    features: [
      "20 AI captions / month",
      "10 AI images / month",
      "1 brand kit",
      "Schedule up to 10 posts",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    priceLabel: "$29 / mo",
    limits: { captions: 500, images: 200, brandKits: 10, scheduledPosts: 200 },
    features: [
      "500 AI captions / month",
      "200 AI images / month",
      "10 brand kits",
      "Schedule up to 200 posts",
      "Priority generation",
    ],
  },
  {
    id: "business",
    name: "Business",
    priceLabel: "$99 / mo",
    limits: { captions: -1, images: -1, brandKits: -1, scheduledPosts: -1 },
    features: [
      "Unlimited AI captions",
      "Unlimited AI images",
      "Unlimited brand kits",
      "Unlimited scheduling",
      "Team collaboration",
    ],
  },
];

export function getPlan(planId: string): Plan {
  return PLANS.find((p) => p.id === planId) ?? PLANS[0]!;
}

export function getPlanLimits(planId: string): PlanLimits {
  return getPlan(planId).limits;
}
