import dns from "node:dns/promises";
import net from "node:net";

/**
 * SSRF-hardened outbound fetch helpers, shared by any route that fetches a
 * user-supplied URL server-side (AI URL summarization, brand draft from URL).
 *
 * Guard model: block IP-literal and DNS-resolved private/loopback/link-local/
 * CGNAT/multicast/reserved ranges (IPv4 + full IPv6 incl. IPv4-mapped/compatible
 * forms), block localhost/.local/.internal, use redirect:"manual" and
 * re-validate the host on every hop, cap the response body, and fail closed.
 */

export const MAX_FETCH_BYTES = 2_000_000;
export const ALLOWED_CONTENT_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  const inRange = (base: string, bits: number) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  };
  return (
    inRange("0.0.0.0", 8) ||
    inRange("10.0.0.0", 8) ||
    inRange("100.64.0.0", 10) ||
    inRange("127.0.0.0", 8) ||
    inRange("169.254.0.0", 16) ||
    inRange("172.16.0.0", 12) ||
    inRange("192.0.0.0", 24) ||
    inRange("192.168.0.0", 16) ||
    inRange("198.18.0.0", 15) ||
    inRange("224.0.0.0", 4) ||
    inRange("240.0.0.0", 4)
  );
}

function ipv6ToBytes(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);

  // Convert a trailing embedded IPv4 (e.g. ::ffff:127.0.0.1) into two hex groups.
  if (s.includes(".")) {
    const idx = s.lastIndexOf(":");
    if (idx < 0) return null;
    const v4 = s.slice(idx + 1);
    if (!net.isIPv4(v4)) return null;
    const o = v4.split(".").map(Number);
    const g1 = ((o[0] << 8) | o[1]).toString(16);
    const g2 = ((o[2] << 8) | o[3]).toString(16);
    s = s.slice(0, idx + 1) + g1 + ":" + g2;
  }

  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const headParts = dbl[0] ? dbl[0].split(":") : [];
  const tailParts = dbl.length === 2 ? (dbl[1] ? dbl[1].split(":") : []) : null;

  let groups: number[];
  if (tailParts === null) {
    if (headParts.length !== 8) return null;
    groups = headParts.map((h) => parseInt(h, 16));
  } else {
    const missing = 8 - (headParts.length + tailParts.length);
    if (missing < 0) return null;
    groups = [
      ...headParts.map((h) => parseInt(h, 16)),
      ...Array(missing).fill(0),
      ...tailParts.map((h) => parseInt(h, 16)),
    ];
  }
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  const bytes: number[] = [];
  for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
  return bytes;
}

function isPrivateIPv6(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (!b) return true; // unparseable -> block (fail closed)

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96, deprecated):
  // delegate the embedded IPv4 to the IPv4 checks (also catches ::, ::1).
  const isMapped =
    b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  const isCompat = b.slice(0, 12).every((x) => x === 0);
  if (isMapped || isCompat) {
    const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
    if (isPrivateIPv4(v4)) return true;
  }

  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
  if (b.every((x) => x === 0)) return true; // :: unspecified
  const first = b[0];
  if ((first & 0xfe) === 0xfc) return true; // unique local fc00::/7
  if (first === 0xfe && (b[1] & 0xc0) === 0x80) return true; // link-local fe80::/10
  if (first === 0xff) return true; // multicast ff00::/8
  return false;
}

function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error("Blocked host");
    return;
  }
  const lower = host.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal")
  ) {
    throw new Error("Blocked host");
  }
  const addrs = await dns.lookup(hostname, { all: true });
  if (addrs.length === 0) throw new Error("Blocked host");
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error("Blocked host");
  }
}

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

export async function safeFetch(
  initialUrl: string,
  signal: AbortSignal,
): Promise<FetchResponse> {
  let url = initialUrl;
  for (let hop = 0; hop < 4; hop++) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Blocked protocol");
    }
    await assertPublicHost(parsed.hostname);
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "manual",
      signal,
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url).toString();
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}

export async function readCappedText(
  res: FetchResponse,
  maxBytes: number,
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        chunks.push(Buffer.from(value.slice(0, value.length - (total - maxBytes))));
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}
