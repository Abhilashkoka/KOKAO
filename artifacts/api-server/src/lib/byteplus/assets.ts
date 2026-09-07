import { db, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { boundedProviderFetch, errorDetail } from "../aiProviderFetch";
import { encryptJson, decryptJson } from "../secretCrypto";
import {
  signBytePlusAssetsRequest,
  type BytePlusSigningCredentials,
} from "./assetsSigner";

const CREDENTIAL_PROVIDER = "byteplus_assets";
const DEFAULT_HOST = "ark.ap-southeast-1.byteplusapi.com";
const DEFAULT_REGION = "ap-southeast-1";
const API_VERSION = "2024-01-01";
const FETCH_TIMEOUT_MS = 30_000;

interface StoredKey {
  accessKeyId: string;
  secretAccessKey: string;
}

export type BytePlusAssetStatus = "Processing" | "Active" | "Failed";

export class BytePlusAssetsError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "BytePlusAssetsError";
  }
}

export async function setStoredBytePlusAssetsKey(key: StoredKey): Promise<void> {
  const encryptedCredentials = encryptJson(key);
  await db.insert(appCredentialsTable).values({
    provider: CREDENTIAL_PROVIDER,
    encryptedCredentials,
  }).onConflictDoUpdate({
    target: appCredentialsTable.provider,
    set: { encryptedCredentials, updatedAt: new Date() },
  });
}

export async function clearStoredBytePlusAssetsKey(): Promise<void> {
  await db.delete(appCredentialsTable).where(eq(appCredentialsTable.provider, CREDENTIAL_PROVIDER));
}

async function storedKey(): Promise<StoredKey | null> {
  const [row] = await db.select().from(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, CREDENTIAL_PROVIDER)).limit(1);
  if (!row) return null;
  try {
    const key = decryptJson<StoredKey>(row.encryptedCredentials);
    return key.accessKeyId && key.secretAccessKey ? key : null;
  } catch {
    return null;
  }
}

export async function getBytePlusAssetsKeySource(): Promise<"database" | "env" | null> {
  if (await storedKey()) return "database";
  return process.env.ARK_ACCESS_KEY_ID?.trim() && process.env.ARK_SECRET_ACCESS_KEY?.trim()
    ? "env"
    : null;
}

export async function resolveBytePlusAssetsCredentials():
  Promise<BytePlusSigningCredentials | null> {
  const key = await storedKey();
  const accessKeyId = key?.accessKeyId ?? process.env.ARK_ACCESS_KEY_ID?.trim();
  const secretAccessKey = key?.secretAccessKey ?? process.env.ARK_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) return null;
  return {
    accessKeyId,
    secretAccessKey,
    region: process.env.ARK_ASSETS_REGION?.trim() || DEFAULT_REGION,
    service: "ark",
  };
}

interface Envelope<T> {
  ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
  Result?: T;
}

async function call<T>(
  action: string,
  payload: Record<string, unknown>,
  credentials: BytePlusSigningCredentials,
): Promise<T> {
  const signed = signBytePlusAssetsRequest({
    host: process.env.ARK_ASSETS_HOST?.trim() || DEFAULT_HOST,
    action,
    version: API_VERSION,
    body: JSON.stringify(payload),
    credentials,
  });
  const response = await boundedProviderFetch(
    signed.url,
    { method: "POST", headers: signed.headers, body: signed.body, redirect: "manual" },
    FETCH_TIMEOUT_MS,
    () => new BytePlusAssetsError(`BytePlus ModelArk ${action} timed out.`),
  );
  if (!response.ok) {
    throw new BytePlusAssetsError(
      `BytePlus ModelArk ${action} failed (${response.status}): ${await errorDetail(response)}`,
      response.status,
    );
  }
  const body = await response.json().catch(() => null) as Envelope<T> | null;
  if (!body) throw new BytePlusAssetsError(`BytePlus ModelArk ${action} returned invalid JSON.`);
  const upstream = body.ResponseMetadata?.Error;
  if (upstream?.Code || upstream?.Message) {
    throw new BytePlusAssetsError(
      `BytePlus ModelArk ${action} failed: ${upstream.Message ?? upstream.Code}`,
      response.status,
      upstream.Code,
    );
  }
  return (body.Result ?? body) as T;
}

export async function createAssetGroup(
  name: string,
  credentials: BytePlusSigningCredentials,
): Promise<string> {
  const result = await call<{ Id?: string }>(
    "CreateAssetGroup",
    { Name: name, Description: "", ProjectName: "default" },
    credentials,
  );
  if (!result.Id) throw new BytePlusAssetsError("BytePlus returned no asset group id.");
  return result.Id;
}

export async function createAsset(
  args: { groupId: string; url: string; name: string },
  credentials: BytePlusSigningCredentials,
): Promise<string> {
  const result = await call<{ Id?: string }>(
    "CreateAsset",
    {
      GroupId: args.groupId,
      AssetType: "Image",
      Name: args.name,
      URL: args.url,
      ProjectName: "default",
    },
    credentials,
  );
  if (!result.Id) throw new BytePlusAssetsError("BytePlus returned no asset id.");
  return result.Id;
}

export async function getAsset(
  id: string,
  credentials: BytePlusSigningCredentials,
): Promise<{ Id?: string; Status?: BytePlusAssetStatus }> {
  return call("GetAsset", { Id: id, ProjectName: "default" }, credentials);
}

export async function deleteAsset(
  id: string,
  credentials: BytePlusSigningCredentials,
): Promise<void> {
  await call("DeleteAsset", { Id: id, ProjectName: "default" }, credentials);
}

export async function waitForAssetActive(
  id: string,
  credentials: BytePlusSigningCredentials,
  timeoutMs = 5 * 60_000,
): Promise<BytePlusAssetStatus> {
  const deadline = Date.now() + timeoutMs;
  do {
    const asset = await getAsset(id, credentials);
    if (asset.Status === "Active" || asset.Status === "Failed") return asset.Status;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  } while (Date.now() < deadline);
  return "Processing";
}

export const BYTEPLUS_VERIFY_SUCCESS_CODE = "10000";
export const BYTEPLUS_TOKEN_TTL_MS = 30 * 60_000;

export async function createLivenessVerification(
  callbackUrl: string,
  credentials: BytePlusSigningCredentials,
): Promise<{ verificationUrl: string; bytedToken: string }> {
  const result = await call<{ H5Link?: string; BytedToken?: string }>(
    "CreateVisualValidateSession",
    { CallbackURL: callbackUrl, ProjectName: "default" },
    credentials,
  );
  if (!result.H5Link || !result.BytedToken) {
    throw new BytePlusAssetsError("BytePlus returned no verification URL.");
  }
  const separator = result.H5Link.includes("?") ? "&" : "?";
  return { verificationUrl: `${result.H5Link}${separator}lng=en`, bytedToken: result.BytedToken };
}

export async function resolveLivenessAssetGroup(
  token: string,
  credentials: BytePlusSigningCredentials,
): Promise<string> {
  const result = await call<{ GroupId?: string; AssetGroupId?: string }>(
    "GetVisualValidateResult",
    { BytedToken: token, ProjectName: "default" },
    credentials,
  );
  const id = result.GroupId ?? result.AssetGroupId;
  if (!id) throw new BytePlusAssetsError("BytePlus returned no verified asset group id.");
  return id;
}