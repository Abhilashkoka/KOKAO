/**
 * Guided Story setup: does the topic read like a product or service ad?
 * Used only to nudge the user to attach a Brand Kit product; never blocks.
 */
const PRODUCT_AD_PATTERN = new RegExp(
  [
    "\\b(?:our|my|the) (?:new )?(?:product|range|collection|launch|brand|serum|cream|app|service|offer)s?\\b",
    "\\b(?:product|advert(?:isement)?|ad|promo(?:tion)?|commercial|launch|unboxing|sale|discount|offer|buy|shop|order now|collection)s?\\b",
    "\\b(?:serum|cream|lotion|sunscreen|shampoo|perfume|saree|sari|kurta|lehenga|dress|shoes?|watch|phone|gadget|supplement|tablet|syrup|kit|bottle|package|pack)s?\\b",
  ].join("|"),
  "i",
);

export function topicMentionsProduct(topic: string): boolean {
  return PRODUCT_AD_PATTERN.test(topic);
}

export function shouldNudgeProduct(params: {
  topic: string;
  selectedProducts: number;
  productUploads: number;
  dismissed: boolean;
}): boolean {
  return (
    !params.dismissed &&
    params.selectedProducts === 0 &&
    params.productUploads === 0 &&
    params.topic.trim().length >= 8 &&
    topicMentionsProduct(params.topic)
  );
}
