import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { like } from "drizzle-orm";
import { db, appCredentialsTable, type VideoJobOptions } from "@workspace/db";
import { recordProviderFailure, resetProviderHealthForTests } from "../providerHealth";
import { preflightVideoJob } from "./preflight";

const ENV_KEYS = [
  "REPLICATE_API_TOKEN",
  "PEXELS_API_KEY",
  "PIXABAY_API_KEY",
  "GEMINI_API_KEY",
  "ARK_API_KEY",
  "BFL_API_KEY",
  "STABILITY_API_KEY",
  "OPENROUTER_API_KEY",
  "CUSTOM_IMAGE_API_KEY",
  "DEEPGRAM_API_KEY",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function options(extra: Partial<VideoJobOptions> = {}): VideoJobOptions {
  return { aspectRatio: "9:16", ...extra };
}

/** Trip a circuit breaker the way three real consecutive failures would. */
function open(key: string): void {
  for (let i = 0; i < 3; i++) recordProviderFailure(key);
}

describe("preflightVideoJob", () => {
  beforeEach(async () => {
    resetProviderHealthForTests();
    for (const key of ENV_KEYS) delete process.env[key];
    // Stored admin keys count as configured; clear them so env alone decides.
    await db
      .delete(appCredentialsTable)
      .where(like(appCredentialsTable.provider, "videogen_%"));
    await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "imagegen_%"));
    await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "stock_%"));
    await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "asr_%"));
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  // -------------------------------------------------------------------------
  // AI video generation

  it("refuses a text-to-video job with no video token as a misconfiguration", async () => {
    const issue = await preflightVideoJob("text_to_video", options());
    expect(issue?.status).toBe(400);
    expect(issue?.message).toContain("REPLICATE_API_TOKEN");
  });

  it("refuses a text-to-video job while the video provider is failing", async () => {
    process.env.REPLICATE_API_TOKEN = "test-token";
    open("videogen:replicate");

    const issue = await preflightVideoJob("text_to_video", options());
    expect(issue?.status).toBe(503);
    expect(issue?.message).toContain("Nothing was charged");
  });

  it("passes a healthy text-to-video job", async () => {
    process.env.REPLICATE_API_TOKEN = "test-token";
    expect(await preflightVideoJob("text_to_video", options())).toBeNull();
  });

  it("checks video generation for character-visuals topic videos", async () => {
    process.env.PEXELS_API_KEY = "test-pexels-key";
    const issue = await preflightVideoJob(
      "topic_to_video",
      options({ visualsSource: "character", characterId: 1 }),
    );
    expect(issue?.status).toBe(400);
    expect(issue?.message).toContain("AI video generation");
  });

  // -------------------------------------------------------------------------
  // Image generation

  it("refuses an AI-visuals topic video while every image provider is failing", async () => {
    // The built-in OpenAI provider needs no key, so it is the only candidate.
    open("imagegen:openai");

    const issue = await preflightVideoJob("topic_to_video", options({ visualsSource: "ai" }));
    expect(issue?.status).toBe(503);
    expect(issue?.message).toContain("image provider");
  });

  it("passes when one image provider is healthy even though another is down", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    open("imagegen:openai");

    expect(await preflightVideoJob("topic_to_video", options({ visualsSource: "ai" }))).toBeNull();
  });

  it("checks image generation for a character clip on the text engine", async () => {
    process.env.REPLICATE_API_TOKEN = "test-token";
    // The same token configures Replicate as an IMAGE provider too, so both
    // image candidates have to be down for this to reach the image check.
    open("imagegen:openai");
    open("imagegen:replicate");

    const issue = await preflightVideoJob("text_to_video", options({ characterId: 7 }));
    expect(issue?.status).toBe(503);
    expect(issue?.message).toContain("image provider");
  });

  it("does not check image generation for a plain text-to-video clip", async () => {
    process.env.REPLICATE_API_TOKEN = "test-token";
    open("imagegen:openai");

    expect(await preflightVideoJob("text_to_video", options())).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Stock footage

  it("refuses a stock topic video with no stock source configured", async () => {
    const issue = await preflightVideoJob("topic_to_video", options());
    expect(issue?.status).toBe(400);
    expect(issue?.message).toContain("stock footage source");
  });

  it("refuses when every configured stock source is failing", async () => {
    process.env.PEXELS_API_KEY = "test-pexels-key";
    process.env.PIXABAY_API_KEY = "test-pixabay-key";
    open("stock:pexels");
    open("stock:pixabay");

    const issue = await preflightVideoJob("topic_to_video", options());
    expect(issue?.status).toBe(503);
    expect(issue?.message).toContain("stock footage source");
  });

  it("passes when one stock source is still healthy", async () => {
    process.env.PEXELS_API_KEY = "test-pexels-key";
    process.env.PIXABAY_API_KEY = "test-pixabay-key";
    open("stock:pexels");

    expect(await preflightVideoJob("topic_to_video", options())).toBeNull();
  });

  it("honours an explicit stock source instead of falling back to the other", async () => {
    process.env.PEXELS_API_KEY = "test-pexels-key";

    const issue = await preflightVideoJob("topic_to_video", options({ stockSource: "pixabay" }));
    expect(issue?.status).toBe(400);
    expect(issue?.message).toContain("pixabay");
  });

  it("reports an explicitly chosen source that is failing", async () => {
    process.env.PEXELS_API_KEY = "test-pexels-key";
    process.env.PIXABAY_API_KEY = "test-pixabay-key";
    open("stock:pixabay");

    const issue = await preflightVideoJob("topic_to_video", options({ stockSource: "pixabay" }));
    expect(issue?.status).toBe(503);
    expect(issue?.message).toContain("pixabay");
  });

  // -------------------------------------------------------------------------
  // Narration

  it("checks narration for every topic video", async () => {
    process.env.PEXELS_API_KEY = "test-pexels-key";
    open("tts:openai");

    const issue = await preflightVideoJob("topic_to_video", options());
    expect(issue?.status).toBe(503);
    expect(issue?.message).toContain("narration voice");
  });

  it("passes narration when a fallback voice provider is healthy", async () => {
    process.env.PEXELS_API_KEY = "test-pexels-key";
    process.env.DEEPGRAM_API_KEY = "test-dg-key";
    open("tts:openai");

    expect(await preflightVideoJob("topic_to_video", options())).toBeNull();
  });

  // -------------------------------------------------------------------------
  // AI music

  it("needs nothing at all for a plain slideshow", async () => {
    expect(await preflightVideoJob("slideshow", options({ slideDurationSec: 3 }))).toBeNull();
  });

  it("refuses a slideshow with an AI music bed and no video token", async () => {
    const issue = await preflightVideoJob(
      "slideshow",
      options({ musicPrompt: "soft pastel lo-fi" }),
    );
    expect(issue?.status).toBe(400);
    expect(issue?.message).toContain("AI music");
  });

  it("ignores the music prompt when the tenant uploaded their own track", async () => {
    const issue = await preflightVideoJob(
      "slideshow",
      options({ musicPrompt: "soft pastel lo-fi", musicPath: "/objects/1/uploads/track.mp3" }),
    );
    expect(issue).toBeNull();
  });

  it("refuses an AI music bed while the music provider is failing", async () => {
    process.env.REPLICATE_API_TOKEN = "test-token";
    open("videogen:replicate");

    const issue = await preflightVideoJob(
      "slideshow",
      options({ musicPrompt: "soft pastel lo-fi" }),
    );
    expect(issue?.status).toBe(503);
    expect(issue?.message).toContain("Uploading your own track");
  });

  it("treats a blank music prompt as no music at all", async () => {
    expect(await preflightVideoJob("slideshow", options({ musicPrompt: "   " }))).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Shape

  it("passes a fully configured stock topic video", async () => {
    process.env.PEXELS_API_KEY = "test-pexels-key";
    expect(await preflightVideoJob("topic_to_video", options())).toBeNull();
  });

  it("treats missing options as a stock topic video", async () => {
    const issue = await preflightVideoJob("topic_to_video", null);
    expect(issue?.status).toBe(400);
    expect(issue?.message).toContain("stock footage source");
  });
});
