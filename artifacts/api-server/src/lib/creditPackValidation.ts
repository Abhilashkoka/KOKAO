/** Accept unified packs and preserve legacy packs during the billing transition. */
export function invalidPack(b: {
  name: string;
  pricePaise: number;
  credits?: number;
  captionCredits: number;
  imageCredits: number;
  videoCredits?: number;
}): boolean {
  const quantities = [
    b.credits ?? 0,
    b.captionCredits,
    b.imageCredits,
    b.videoCredits ?? 0,
  ];
  return (
    !b.name.trim() ||
    !Number.isSafeInteger(b.pricePaise) ||
    b.pricePaise <= 0 ||
    quantities.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    quantities.every((value) => value === 0)
  );
}