import { describe, expect, it } from "vitest";

import {
  DEFAULT_VOICE_PROFILE,
  SUBTITLE_LIMITS,
  charsPerSecond,
  describeVoiceProfile,
  estimateEnglishSyllables,
  estimateIndicSyllables,
  estimateSyllables,
  hasBlockingIssue,
  lintLocalizedText,
  lintUntranslatables,
  localePolicy,
  parseSubtitleFile,
  syllableBudget,
  timedSyllableBudget,
  toSrt,
  toVtt,
  untranslatableTerms,
  validateCue,
  validateCues,
  wrapCueText,
  type BrandVoiceProfile,
  type SubtitleCue,
} from "./index";

/* ------------------------------------------------------------------ *
 * Syllables
 * ------------------------------------------------------------------ */

describe("estimateEnglishSyllables", () => {
  it("counts vowel groups", () => {
    expect(estimateEnglishSyllables("one")).toBe(1);
    expect(estimateEnglishSyllables("place")).toBe(1);
    expect(estimateEnglishSyllables("水")).toBe(0);
  });

  it("keeps -le as its own syllable but drops a silent terminal e", () => {
    expect(estimateEnglishSyllables("table")).toBe(2);
    expect(estimateEnglishSyllables("made")).toBe(1);
  });

  it("never returns zero for a word with letters", () => {
    expect(estimateEnglishSyllables("rhythm")).toBeGreaterThanOrEqual(1);
  });
});

describe("estimateIndicSyllables", () => {
  it("counts Telugu aksharas", () => {
    expect(estimateIndicSyllables("మీకు", "telugu")).toBe(2);
    expect(estimateIndicSyllables("కావాల్సినవన్నీ", "telugu")).toBe(6);
    expect(estimateIndicSyllables("ఒకే", "telugu")).toBe(2);
    expect(
      estimateIndicSyllables("మీకు కావాల్సినవన్నీ ఒకే చోట.", "telugu"),
    ).toBe(12);
  });

  it("counts Tamil aksharas and ignores a final pulli consonant", () => {
    expect(estimateIndicSyllables("ஒரே", "tamil")).toBe(2);
    // இடத்தில் -> i / da(th) / thil : the closing ல் is a coda, not a syllable.
    expect(estimateIndicSyllables("இடத்தில்", "tamil")).toBe(3);
    expect(estimateIndicSyllables("உங்களுக்குத்", "tamil")).toBe(4);
  });

  it("applies Hindi schwa deletion", () => {
    expect(estimateIndicSyllables("सब", "devanagari")).toBe(1); // sab, not sa-ba
    expect(estimateIndicSyllables("एक", "devanagari")).toBe(1); // ek
    expect(estimateIndicSyllables("करना", "devanagari")).toBe(2); // kar-naa
    expect(estimateIndicSyllables("आपको", "devanagari")).toBe(2); // aap-ko
  });

  it("keeps a word-final consonant that closes a pronounced syllable", () => {
    // जगह is ja-gah: the final ह is silenced, which protects ग's schwa.
    expect(estimateIndicSyllables("जगह", "devanagari")).toBe(2);
  });

  it("falls back to the English heuristic for untranslated Latin tokens", () => {
    expect(estimateIndicSyllables("kokao యాప్", "telugu")).toBe(
      estimateEnglishSyllables("kokao") +
        estimateIndicSyllables("యాప్", "telugu"),
    );
  });

  it("dispatches on locale", () => {
    expect(estimateSyllables("आपको जो चाहिए, सब एक जगह.", "hi")).toBe(10);
  });
});

describe("syllableBudget", () => {
  it("scales the English count by the locale ratio and rounds up", () => {
    expect(syllableBudget(8, "hi")).toBe(
      Math.ceil(8 * localePolicy("hi").syllableRatio),
    );
    expect(syllableBudget(8, "ta")).toBeGreaterThan(syllableBudget(8, "hi"));
  });

  it("caps a dense line by the duration of its locked cue", () => {
    const sourceSyllables = 12;
    expect(timedSyllableBudget(sourceSyllables, "te", 900)).toBe(4);
    expect(timedSyllableBudget(sourceSyllables, "te", 6000)).toBe(
      syllableBudget(sourceSyllables, "te"),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Subtitles
 * ------------------------------------------------------------------ */

function cue(partial: Partial<SubtitleCue> = {}): SubtitleCue {
  return {
    index: 1,
    startMs: 0,
    endMs: 3000,
    text: "Everything you need.",
    ...partial,
  };
}

describe("validateCue", () => {
  it("passes a well-formed cue", () => {
    expect(validateCue(cue())).toEqual([]);
  });

  it("flags an over-long line", () => {
    const issues = validateCue(
      cue({ text: "x".repeat(SUBTITLE_LIMITS.maxCharsPerLine + 1) }),
    );
    expect(issues.map((i) => i.code)).toContain("line_too_long");
  });

  it("flags more than two lines", () => {
    const issues = validateCue(cue({ text: "a\nb\nc" }));
    expect(issues.map((i) => i.code)).toContain("too_many_lines");
  });

  it("flags reading speed above 22 cps", () => {
    const issues = validateCue(
      cue({ text: "x".repeat(40), startMs: 0, endMs: 1000 }),
    );
    expect(issues.map((i) => i.code)).toContain("reading_speed");
  });

  it("uses the stricter children's limit when asked", () => {
    const fast = cue({ text: "x".repeat(20), startMs: 0, endMs: 1000 });
    expect(validateCue(fast).map((i) => i.code)).not.toContain("reading_speed");
    expect(
      validateCue(fast, { childrenContent: true }).map((i) => i.code),
    ).toContain("reading_speed");
  });

  it("flags a cue that is too short to read", () => {
    const issues = validateCue(cue({ text: "Hi", startMs: 0, endMs: 400 }));
    expect(issues.map((i) => i.code)).toContain("duration_too_short");
  });

  it("flags overlap with the previous cue", () => {
    const issues = validateCue(cue({ startMs: 500 }), { previousEndMs: 900 });
    expect(issues.map((i) => i.code)).toContain("overlaps_previous");
  });

  it("flags an orphaned top line", () => {
    const issues = validateCue(
      cue({ text: "Yes\nand everything else you need here" }),
    );
    expect(issues.map((i) => i.code)).toContain("orphan_top_line");
  });

  it("flags a top-heavy break", () => {
    const issues = validateCue(
      cue({ text: "everything you need is here\nin one place" }),
    );
    expect(issues.map((i) => i.code)).toContain("top_heavy");
  });

  it("sorts errors before warnings", () => {
    const issues = validateCue(
      cue({
        text: `${"x".repeat(50)} more words here\nshort`,
        startMs: 0,
        endMs: 12000,
      }),
    );
    expect(issues[0]!.severity).toBe("error");
  });

  it("reports an empty cue once and stops", () => {
    const issues = validateCue(cue({ text: "   " }));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("empty");
  });
});

describe("validateCues", () => {
  it("threads the previous end time through the track", () => {
    const issues = validateCues([
      cue({ index: 1, startMs: 0, endMs: 2000 }),
      cue({ index: 2, startMs: 1500, endMs: 4000 }),
    ]);
    expect(issues.get(1)).toBeUndefined();
    expect(issues.get(2)!.map((i) => i.code)).toContain("overlaps_previous");
  });
});

describe("charsPerSecond", () => {
  it("excludes the line break from the count", () => {
    expect(
      charsPerSecond({ index: 1, startMs: 0, endMs: 1000, text: "ab\ncd" }),
    ).toBe(4);
  });
});

describe("wrapCueText", () => {
  it("leaves a short line alone", () => {
    expect(wrapCueText("Everything you need.")).toBe("Everything you need.");
  });

  it("breaks bottom-heavy", () => {
    const wrapped = wrapCueText(
      "Everything you need is right here in one single place today",
      30,
    );
    const [top, bottom] = wrapped.split("\n");
    expect(bottom).toBeDefined();
    expect(top!.length).toBeLessThanOrEqual(bottom!.length);
    expect(top!.length).toBeLessThanOrEqual(30);
    expect(bottom!.length).toBeLessThanOrEqual(30);
  });

  it("does not hard-split a single over-long token", () => {
    const token = "க".repeat(60);
    expect(wrapCueText(token)).toBe(token);
  });

  it("normalises an existing break before rewrapping", () => {
    expect(wrapCueText("one\ntwo")).toBe("one two");
  });
});

describe("SRT and VTT", () => {
  const cues: SubtitleCue[] = [
    { index: 1, startMs: 0, endMs: 2500, text: "మీకు కావాల్సినవన్నీ" },
    { index: 2, startMs: 2500, endMs: 5000, text: "ఒకే చోట." },
  ];

  it("formats timecodes with a comma for SRT and a dot for VTT", () => {
    expect(toSrt(cues)).toContain("00:00:00,000 --> 00:00:02,500");
    expect(toVtt(cues)).toContain("00:00:00.000 --> 00:00:02.500");
  });

  it("emits no byte-order mark", () => {
    expect(toSrt(cues).charCodeAt(0)).not.toBe(0xfeff);
  });

  it("starts a VTT file with the required header", () => {
    expect(toVtt(cues).startsWith("WEBVTT\n\n")).toBe(true);
  });

  it("round-trips through the parser", () => {
    expect(parseSubtitleFile(toSrt(cues))).toEqual(cues);
  });

  it("round-trips VTT too", () => {
    expect(parseSubtitleFile(toVtt(cues))).toEqual(cues);
  });

  it("strips a BOM and accepts CRLF", () => {
    const messy = "﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n";
    expect(parseSubtitleFile(messy)).toEqual([
      { index: 1, startMs: 1000, endMs: 2000, text: "Hello" },
    ]);
  });

  it("accepts a missing index line and renumbers", () => {
    const noIndex =
      "00:00:01,000 --> 00:00:02,000\nHello\n\n00:00:02,000 --> 00:00:03,000\nBye";
    expect(parseSubtitleFile(noIndex).map((c) => c.index)).toEqual([1, 2]);
  });

  it("skips blocks with no timecode rather than throwing the file away", () => {
    const partial = "junk block\n\n1\n00:00:01,000 --> 00:00:02,000\nHello";
    expect(parseSubtitleFile(partial)).toHaveLength(1);
  });

  it("keeps a two-line cue intact", () => {
    const two = "1\n00:00:01,000 --> 00:00:03,000\nline one\nline two";
    expect(parseSubtitleFile(two)[0]!.text).toBe("line one\nline two");
  });
});

/* ------------------------------------------------------------------ *
 * Voice profile
 * ------------------------------------------------------------------ */

describe("voice profile", () => {
  it("treats UI strings as untranslatable only while the app is English-only", () => {
    const base: BrandVoiceProfile = {
      ...DEFAULT_VOICE_PROFILE,
      uiStrings: ["Continue"],
      uiIsLocalized: false,
    };
    expect(untranslatableTerms(base)).toContain("Continue");
    expect(untranslatableTerms({ ...base, uiIsLocalized: true })).not.toContain(
      "Continue",
    );
  });

  it("always keeps the brand name", () => {
    expect(untranslatableTerms(DEFAULT_VOICE_PROFILE)).toContain("kokao");
  });

  it("renders the anti-list and the keep-list into the prompt block", () => {
    const described = describeVoiceProfile({
      ...DEFAULT_VOICE_PROFILE,
      uiStrings: ["Continue"],
    });
    expect(described).toContain("kokao");
    expect(described).toContain("Continue");
    expect(described).toContain("notification");
  });
});

/* ------------------------------------------------------------------ *
 * Lint
 * ------------------------------------------------------------------ */

describe("lintLocalizedText", () => {
  const profile: BrandVoiceProfile = {
    ...DEFAULT_VOICE_PROFILE,
    uiStrings: ["Continue"],
    uiIsLocalized: false,
  };

  it("passes a clean Telugu line", () => {
    const issues = lintLocalizedText("మీకు కావాల్సినవన్నీ ఒకే చోట.", {
      locale: "te",
      profile,
    });
    expect(issues).toEqual([]);
  });

  it("flags an answer that came back in English", () => {
    const issues = lintLocalizedText("Everything you need.", {
      locale: "te",
      profile,
    });
    expect(issues.map((i) => i.code)).toEqual(["wrong_script"]);
  });

  it("flags Latin left inside an Indic line", () => {
    const issues = lintLocalizedText("మీకు download చేసుకోండి", {
      locale: "te",
      profile,
    });
    expect(issues.map((i) => i.code)).toContain("latin_in_indic");
    expect(issues.find((i) => i.code === "latin_in_indic")!.fragment).toBe(
      "download",
    );
  });

  it("allows the brand name and interface labels through in Latin", () => {
    const issues = lintLocalizedText("kokao లో Continue నొక్కండి", {
      locale: "te",
      profile,
    });
    expect(issues.map((i) => i.code)).not.toContain("latin_in_indic");
  });

  it("treats stray Latin as an error in Tamil and a warning elsewhere", () => {
    const tamil = lintLocalizedText("உங்களுக்கு download பண்ணுங்க", {
      locale: "ta",
      profile,
    });
    const hindi = lintLocalizedText("आपको download करना है", {
      locale: "hi",
      profile,
    });
    expect(tamil.find((i) => i.code === "latin_in_indic")!.severity).toBe(
      "error",
    );
    expect(hindi.find((i) => i.code === "latin_in_indic")!.severity).toBe(
      "warning",
    );
  });

  it("flags textbook coinages with a replacement", () => {
    const te = lintLocalizedText("అనువర్తనం తెరవండి", {
      locale: "te",
      profile,
    });
    const hi = lintLocalizedText("अनुप्रयोग खोलें", { locale: "hi", profile });
    const ta = lintLocalizedText("இப்போதே செய்யுங்கள்", {
      locale: "ta",
      profile,
    });
    expect(te.find((i) => i.code === "avoided_term")!.suggestion).toBe("యాప్");
    expect(hi.find((i) => i.code === "avoided_term")!.suggestion).toBe("ऐप");
    expect(ta.map((i) => i.code)).toContain("avoided_term");
  });

  it("flags a line over its syllable budget", () => {
    const issues = lintLocalizedText("మీకు కావాల్సినవన్నీ ఒకే చోట.", {
      locale: "te",
      profile,
      syllables: 12,
      syllableBudget: 9,
    });
    const over = issues.find((i) => i.code === "over_budget")!;
    expect(over.severity).toBe("error");
    expect(over.message).toContain("3 over");
  });

  it("stays quiet on an empty line", () => {
    expect(lintLocalizedText("   ", { locale: "hi", profile })).toEqual([]);
  });

  it("reports each distinct Latin fragment once", () => {
    const issues = lintLocalizedText("download మరియు download మరియు upload", {
      locale: "te",
      profile,
    });
    expect(issues.filter((i) => i.code === "latin_in_indic")).toHaveLength(2);
  });
});

describe("lintUntranslatables", () => {
  const profile: BrandVoiceProfile = {
    ...DEFAULT_VOICE_PROFILE,
    uiStrings: ["Continue"],
    uiIsLocalized: false,
  };

  it("flags a brand name that got translated away", () => {
    const issues = lintUntranslatables(
      "Open kokao now",
      "ఇప్పుడే తెరవండి",
      profile,
    );
    expect(issues.map((i) => i.code)).toEqual(["missing_untranslatable"]);
  });

  it("passes when the term survived", () => {
    expect(
      lintUntranslatables("Open kokao now", "kokao ఇప్పుడే తెరవండి", profile),
    ).toEqual([]);
  });

  it("ignores terms that were never in the source", () => {
    expect(
      lintUntranslatables("Open the app", "యాప్ తెరవండి", profile),
    ).toEqual([]);
  });
});

describe("hasBlockingIssue", () => {
  it("is true only when something is an error", () => {
    expect(
      hasBlockingIssue([
        { code: "avoided_term", severity: "warning", message: "" },
      ]),
    ).toBe(false);
    expect(
      hasBlockingIssue([
        { code: "wrong_script", severity: "error", message: "" },
      ]),
    ).toBe(true);
  });
});
