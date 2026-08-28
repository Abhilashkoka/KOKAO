import { afterEach, describe, expect, it } from "vitest";
import { db, appCredentialsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { encryptJson } from "./secretCrypto";
import { getStoredImageGenKey } from "./imageGen";
import { getStoredVideoGenKey } from "./videoGen";

const PROVIDERS = ["imagegen_replicate", "videogen_replicate"];

afterEach(async () => {
  await db.delete(appCredentialsTable).where(inArray(appCredentialsTable.provider, PROVIDERS));
});

describe("Replicate credential sharing", () => {
  it("lets video generation reuse a token saved on the image provider", async () => {
    await db.insert(appCredentialsTable).values({
      provider: "imagegen_replicate",
      encryptedCredentials: encryptJson({ apiKey: "shared-image-token" }),
    });

    expect(await getStoredVideoGenKey("replicate")).toBe("shared-image-token");
  });

  it("lets image generation reuse a token saved on the video provider", async () => {
    await db.insert(appCredentialsTable).values({
      provider: "videogen_replicate",
      encryptedCredentials: encryptJson({ apiKey: "shared-video-token" }),
    });

    expect(await getStoredImageGenKey("replicate")).toBe("shared-video-token");
  });

  it("prefers the capability-specific token when both rows exist", async () => {
    await db.insert(appCredentialsTable).values([
      {
        provider: "imagegen_replicate",
        encryptedCredentials: encryptJson({ apiKey: "image-token" }),
      },
      {
        provider: "videogen_replicate",
        encryptedCredentials: encryptJson({ apiKey: "video-token" }),
      },
    ]);

    expect(await getStoredImageGenKey("replicate")).toBe("image-token");
    expect(await getStoredVideoGenKey("replicate")).toBe("video-token");
  });
});