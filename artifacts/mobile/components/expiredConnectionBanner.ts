export type ExpiredFlags = {
  linkedinExpired: boolean;
  twitterExpired: boolean;
  threadsExpired: boolean;
};

export function buildExpiredNames(flags: ExpiredFlags): string[] {
  return [
    flags.linkedinExpired ? "LinkedIn" : null,
    flags.twitterExpired ? "X" : null,
    flags.threadsExpired ? "Threads" : null,
  ].filter((n): n is string => n !== null);
}

export function buildExpiredBannerText(names: string[]): string | null {
  if (names.length === 0) return null;
  const plural = names.length > 1;
  const joined =
    names.length <= 2
      ? names.join(" and ")
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Your ${joined} connection${plural ? "s" : ""} expired. Reconnect ${plural ? "them" : "it"} from KOKAO on the web.`;
}
