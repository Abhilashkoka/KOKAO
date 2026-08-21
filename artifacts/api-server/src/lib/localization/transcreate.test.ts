import { describe, expect, it, vi } from "vitest";

import type OpenAI from "openai";
import { DEFAULT_VOICE_PROFILE, type BrandVoiceProfile } from "@workspace/localization";

import { MAX_SOURCE_CUES, transcreateCues, type SourceCue } from "./transcreate";

/**
 * A stand-in for the chat client. The unit under test only ever touches
 * `chat.completions.create`, so the fake returns whatever JSON the case needs
 * and records what it was asked — no network, no provider registry.
 */
function fakeClient(responses: string[]): {
  client: OpenAI;
  calls: { system: string; user: string }[];
} {
  const calls: { system: string; user: string }[] = [];
  let call = 0;
  const create = vi.fn(async (params: Record<string, unknown>) => {
    const messages = params.messages as { role: string; content: string }[];
    calls.push({
      system: messages.find((m) => m.role === "system")?.content ?? "",
      user: messages.find((m) => m.role === "user")?.content ?? "",
    });
    const body = responses[Math.min(call, responses.length - 1)] ?? "{}";
    call += 1;
    return { choices: [{ message: { content: body } }] };
  });
  return {
    client: { chat: { completions: { create } } } as unknown as OpenAI,
    calls,
  };
}

const CUES: SourceCue[] = [
  { index: 1, startMs: 0, endMs: 3000, text: "Everything you need, in one place." },
];

const profile: BrandVoiceProfile = {
  ...DEFAULT_VOICE_PROFILE,
  uiStrings: ["Continue"],
  uiIsLocalized: false,
};

function reply(lines: { index: number; text: string; back: string }[]): string {
  return JSON.stringify({ lines });
}

describe("transcreateCues", () => {
  it("returns a measured, linted cue", async () => {
    const { client } = fakeClient([
      reply([{ index: 1, text: "మీకు కావాల్సినవన్నీ ఒకే చోట.", back: "Everything you need, one place." }]),
    ]);

    const result = await transcreateCues({
      cues: CUES,
      locale: "te",
      profile,
      client,
      model: "gpt-test",
    });

    expect(result.locale).toBe("te");
    expect(result.cues).toHaveLength(1);
    const cue = result.cues[0]!;
    expect(cue.text).toBe("మీకు కావాల్సినవన్నీ ఒకే చోట.");
    expect(cue.backTranslation).toBe("Everything you need, one place.");
    expect(cue.syllables).toBe(12);
    expect(cue.syllableBudget).toBeGreaterThan(cue.sourceSyllables);
    expect(cue.issues).toEqual([]);
    expect(result.blocked).toBe(false);
  });

  it("puts the per-cue syllable budget and duration in the prompt", async () => {
    const { client, calls } = fakeClient([reply([{ index: 1, text: "ఒకే చోట.", back: "One place." }])]);

    await transcreateCues({ cues: CUES, locale: "te", profile, client, model: "gpt-test" });

    expect(calls[0]!.user).toContain("3.0s");
    expect(calls[0]!.user).toMatch(/max \d+ syllables/);
  });

  it("carries the brand voice and locale register into the system prompt", async () => {
    const { client, calls } = fakeClient([reply([{ index: 1, text: "ఒకే చోట.", back: "One place." }])]);

    await transcreateCues({ cues: CUES, locale: "ta", profile, client, model: "gpt-test" });

    expect(calls[0]!.system).toContain("kokao");
    expect(calls[0]!.system).toContain("Continue");
    // Tamil's policy note, which differs from the other two languages.
    expect(calls[0]!.system).toContain("purism");
  });

  it("flags a line that came back over its syllable budget", async () => {
    const { client } = fakeClient([
      reply([
        {
          index: 1,
          text: "మీ అవసరాలన్నీ ఒకే వేదికపై లభ్యమవుతాయి అని మేము చెప్పగలము.",
          back: "We can say all your requirements are available on one platform.",
        },
      ]),
    ]);

    const result = await transcreateCues({
      cues: [{ index: 1, startMs: 0, endMs: 1200, text: "One place." }],
      locale: "te",
      profile,
      client,
      model: "gpt-test",
    });

    expect(result.cues[0]!.issues.map((i) => i.code)).toContain("over_budget");
    expect(result.blocked).toBe(true);
  });

  it("flags a textbook coinage the locale policy rejects", async () => {
    const { client } = fakeClient([
      reply([{ index: 1, text: "అనువర్తనం తెరవండి", back: "Open the application." }]),
    ]);

    const result = await transcreateCues({
      cues: [{ index: 1, startMs: 0, endMs: 4000, text: "Open the app." }],
      locale: "te",
      profile,
      client,
      model: "gpt-test",
    });

    const issue = result.cues[0]!.issues.find((i) => i.code === "avoided_term");
    expect(issue?.suggestion).toBe("యాప్");
  });

  it("flags an answer that came back in English", async () => {
    const { client } = fakeClient([
      reply([{ index: 1, text: "Everything you need.", back: "Everything you need." }]),
    ]);

    const result = await transcreateCues({
      cues: CUES,
      locale: "hi",
      profile,
      client,
      model: "gpt-test",
    });

    expect(result.cues[0]!.issues.map((i) => i.code)).toContain("wrong_script");
    expect(result.blocked).toBe(true);
  });

  it("keeps a missing line visible instead of dropping it", async () => {
    const { client } = fakeClient([reply([])]);

    const result = await transcreateCues({
      cues: CUES,
      locale: "te",
      profile,
      client,
      model: "gpt-test",
    });

    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe("");
    expect(result.cues[0]!.issues[0]!.severity).toBe("error");
    expect(result.blocked).toBe(true);
  });

  it("survives unparseable model output without losing the cue list", async () => {
    const { client } = fakeClient(["not json at all"]);

    const result = await transcreateCues({
      cues: CUES,
      locale: "ta",
      profile,
      client,
      model: "gpt-test",
    });

    expect(result.cues).toHaveLength(1);
    expect(result.blocked).toBe(true);
  });

  it("chunks long scripts across several calls and reassembles by index", async () => {
    const cues: SourceCue[] = Array.from({ length: 30 }, (_, i) => ({
      index: i + 1,
      startMs: i * 2000,
      endMs: (i + 1) * 2000,
      text: "One place.",
    }));
    const first = reply(
      Array.from({ length: 25 }, (_, i) => ({ index: i + 1, text: "ఒకే చోట.", back: "One place." })),
    );
    const second = reply(
      Array.from({ length: 5 }, (_, i) => ({ index: i + 26, text: "ఒకే చోట.", back: "One place." })),
    );
    const { client, calls } = fakeClient([first, second]);

    const result = await transcreateCues({ cues, locale: "te", profile, client, model: "gpt-test" });

    expect(calls).toHaveLength(2);
    expect(result.cues).toHaveLength(30);
    expect(result.cues.every((cue) => cue.text.length > 0)).toBe(true);
    expect(result.cues.map((cue) => cue.index)).toEqual(cues.map((cue) => cue.index));
  });

  it("flags a brand name that vanished from the whole track", async () => {
    const { client } = fakeClient([
      reply([{ index: 1, text: "ఇప్పుడే తెరవండి", back: "Open now." }]),
    ]);

    const result = await transcreateCues({
      cues: [{ index: 1, startMs: 0, endMs: 4000, text: "Open kokao now." }],
      locale: "te",
      profile,
      client,
      model: "gpt-test",
    });

    expect(result.trackIssues.map((i) => i.code)).toEqual(["missing_untranslatable"]);
    expect(result.blocked).toBe(true);
  });

  it("passes usage-accounting params straight through to the provider", async () => {
    const create = vi.fn(async (_params: Record<string, unknown>) => ({
      choices: [{ message: { content: reply([{ index: 1, text: "ఒకే చోట.", back: "One place." }]) } }],
    }));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    await transcreateCues({
      cues: CUES,
      locale: "te",
      profile,
      client,
      model: "gpt-test",
      requestParams: { usage: { include: true } },
    });

    expect(create.mock.calls[0]![0]).toMatchObject({ usage: { include: true } });
  });

  it("exposes a source-cue ceiling for callers to enforce", () => {
    expect(MAX_SOURCE_CUES).toBeGreaterThan(0);
  });
});
