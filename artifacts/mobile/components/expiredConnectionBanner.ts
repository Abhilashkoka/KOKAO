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
  return `Your ${names.join(" and ")} connection${plural ? "s" : ""} expired. Reconnect ${plural ? "them" : "it"} from KOKAO on the web.`;
}
