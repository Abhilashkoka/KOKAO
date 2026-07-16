/**
 * Build the text published to a social platform from a content item: the
 * title on its own line, then the caption. When the caption already starts
 * with the title (or one of them is empty) no duplication happens.
 */
export function buildPostText(
  title: string | null | undefined,
  caption: string | null | undefined,
): string {
  const t = title?.trim() ?? "";
  const c = caption?.trim() ?? "";
  if (!c) return t;
  if (!t || c.toLowerCase().startsWith(t.toLowerCase())) return c;
  return `${t}\n\n${c}`;
}
