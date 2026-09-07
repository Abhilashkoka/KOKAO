import { createHash, createHmac } from "crypto";

export interface BytePlusSigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: "ark";
}

const encode = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string) =>
  createHmac("sha256", key).update(value).digest();

export function formatBytePlusDate(date: Date): string {
  return `${date.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15)}Z`;
}

/** Volcengine/BytePlus V4 signing used by the top-level Assets API. */
export function signBytePlusAssetsRequest(args: {
  host: string;
  action: string;
  version: string;
  body: string;
  credentials: BytePlusSigningCredentials;
  now?: Date;
}): { url: string; headers: Record<string, string>; body: string } {
  const date = formatBytePlusDate(args.now ?? new Date());
  const shortDate = date.slice(0, 8);
  const query = Object.entries({ Action: args.action, Version: args.version })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join("&");
  const headers = {
    "Content-Type": "application/json",
    Host: args.host,
    "X-Content-Sha256": sha256(args.body),
    "X-Date": date,
  };
  const signedHeaders = "content-type;host;x-content-sha256;x-date";
  const canonicalHeaders =
    `content-type:${headers["Content-Type"]}\nhost:${headers.Host}\n` +
    `x-content-sha256:${headers["X-Content-Sha256"]}\nx-date:${headers["X-Date"]}\n`;
  const canonicalRequest =
    `POST\n/\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${headers["X-Content-Sha256"]}`;
  const scope = `${shortDate}/${args.credentials.region}/${args.credentials.service}/request`;
  const stringToSign = `HMAC-SHA256\n${date}\n${scope}\n${sha256(canonicalRequest)}`;
  const dateKey = hmac(args.credentials.secretAccessKey, shortDate);
  const regionKey = hmac(dateKey, args.credentials.region);
  const serviceKey = hmac(regionKey, args.credentials.service);
  const signingKey = hmac(serviceKey, "request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    url: `https://${args.host}/?${query}`,
    headers: {
      ...headers,
      Authorization:
        `HMAC-SHA256 Credential=${args.credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: args.body,
  };
}