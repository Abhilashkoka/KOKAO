/** Formats the server's authoritative aggregate without deriving it from rates. */
export function formatVideoCreditsUsed(
  totalCreditsUsed: number | null | undefined,
): string {
  if (totalCreditsUsed == null) return "Credits used: unavailable";
  return `Total credits used: ${totalCreditsUsed.toLocaleString("en-IN", {
    maximumFractionDigits: 3,
  })}`;
}
