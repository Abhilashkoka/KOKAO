import { describe, expect, it } from "vitest";
import {
  assessNativeAudioTranscript,
  detectTranscriptLocale,
  nativeAudioTranscriptDiagnostics,
} from "./nativeAudioGate";

describe("native Guided audio assessment", () => {
  it("accepts the requested language and dialogue", () => {
    expect(assessNativeAudioTranscript({
      expectedLocale: "en",
      expectedDialogue: "The market opens at sunrise",
      transcript: "The market opens at sunrise.",
    })).toEqual({ outcome: "pass", detectedLocale: "en" });
  });

  it("reports a major language mismatch separately", () => {
    expect(assessNativeAudioTranscript({
      expectedLocale: "en",
      expectedDialogue: "The market opens at sunrise",
      transcript: "El mercado abre al amanecer.",
      providerDetectedLanguage: "es",
    })).toEqual({ outcome: "wrong_language", detectedLocale: "es" });
  });

  it("does not invent a language from uncertain detection", () => {
    expect(detectTranscriptLocale("OK 2")).toBeNull();
    expect(assessNativeAudioTranscript({
      expectedLocale: "en",
      expectedDialogue: "OK 2",
      transcript: "OK 2",
    })).toEqual({ outcome: "pass", detectedLocale: null });
  });

  it("reports exact-dialogue drift separately from language drift", () => {
    expect(assessNativeAudioTranscript({
      expectedLocale: "en",
      expectedDialogue: "The market opens at sunrise",
      transcript: "A completely different English sentence was spoken.",
    })).toEqual({ outcome: "dialogue_drift", detectedLocale: "en" });
  });

  it("rejects materially reordered dialogue", () => {
    expect(assessNativeAudioTranscript({
      expectedLocale: "en",
      expectedDialogue: "The dog follows the man before sunrise",
      transcript: "Before sunrise the man follows the dog",
      providerDetectedLanguage: "english",
    })).toEqual({ outcome: "dialogue_drift", detectedLocale: "en" });
  });

  it("treats a short conflicting language label as uncertain", () => {
    expect(assessNativeAudioTranscript({
      expectedLocale: "en",
      expectedDialogue: "No",
      transcript: "No",
      providerDetectedLanguage: "spanish",
    })).toEqual({ outcome: "pass", detectedLocale: null });
  });

  it("trusts matching Telugu script over a conflicting Tamil provider label", () => {
    const expected = "మన చిన్న తార కోసం ఎంత దూరమైనా వెళ్తాం";
    expect(assessNativeAudioTranscript({
      expectedLocale: "te",
      expectedDialogue: expected,
      transcript: `${expected}.`,
      providerDetectedLanguage: "Tamil",
    })).toEqual({ outcome: "pass", detectedLocale: "te" });
    expect(nativeAudioTranscriptDiagnostics({
      expectedDialogue: expected,
      transcript: `${expected}.`,
      providerDetectedLanguage: "Tamil",
    })).toMatchObject({
      providerDetectedLocale: "ta",
      transcriptDetectedLocale: "te",
      transcriptWordCount: 7,
      dialogueSimilarity: 1,
    });
  });

  it("accepts locale-hinted Telugu with ordered phonetic ASR spelling noise", () => {
    const expectedDialogue =
      "మన చిన్న తార కోసం ఎంత దూరమైనా వెళ్తాం";
    const expectedPhoneticDialogue =
      "Mana chinna tara kosam enta duramaina veltam.";
    const transcript =
      "మంచిన్ని తార్ కిలన ఏరదురమణన వెత్తమ్";

    expect(assessNativeAudioTranscript({
      expectedLocale: "te",
      expectedDialogue,
      expectedPhoneticDialogue,
      transcript,
      providerDetectedLanguage: "Telugu",
    })).toEqual({ outcome: "pass", detectedLocale: "te" });
    expect(nativeAudioTranscriptDiagnostics({
      expectedDialogue,
      expectedPhoneticDialogue,
      transcript,
      providerDetectedLanguage: "Telugu",
    }).dialogueSimilarity).toBeGreaterThanOrEqual(0.75);
  });

  it("trusts strong frozen Telugu phonetics over a conflicting Tamil label", () => {
    const expectedDialogue =
      "మన చిన్న తార కోసం ఎంత దూరమైనా వెళ్తాం";
    const expectedPhoneticDialogue =
      "Mana chinna tara kosam enta duramaina veltam.";

    expect(assessNativeAudioTranscript({
      expectedLocale: "te",
      expectedDialogue,
      expectedPhoneticDialogue,
      transcript: "Mana chinna tara kosam enta duramaina veltam",
      providerDetectedLanguage: "Tamil",
    })).toEqual({ outcome: "pass", detectedLocale: "te" });
  });

  it("keeps a conflicting Tamil label when Telugu phonetics do not match", () => {
    expect(assessNativeAudioTranscript({
      expectedLocale: "te",
      expectedDialogue:
        "మన చిన్న తార కోసం ఎంత దూరమైనా వెళ్తాం",
      expectedPhoneticDialogue:
        "Mana chinna tara kosam enta duramaina veltam.",
      transcript:
        "Indha kathai mutrilum veru vishayathai patri pesugirathu",
      providerDetectedLanguage: "Tamil",
    })).toEqual({ outcome: "wrong_language", detectedLocale: "ta" });
  });

  describe("Telugu transcribed in Tamil script under a Tamil label", () => {
    const expectedDialogue =
      "అదే వీధి. అవే టపాసులు. మరి నా షాప్ మాత్రమే ఎందుకు నిండిపోయింది?";
    const expectedPhoneticDialogue =
      "Ade veedhi. Ave tapasulu. Mari naa shop maatrame enduku nindipoyindi?";
    // Mirrors a real false failure: correct Telugu audio, ASR said Tamil, 0.739.
    const transcript =
      "அதே வீதி அவே டபாசு மரி நா ஷாப் மாத்ரமே எந்துகு நிண்டிபோயிந்தி";

    it("passes when the phonetics still match the frozen script", () => {
      const similarity = nativeAudioTranscriptDiagnostics({
        expectedDialogue,
        expectedPhoneticDialogue,
        transcript,
        providerDetectedLanguage: "ta",
      }).dialogueSimilarity;
      expect(similarity).toBeGreaterThanOrEqual(0.7);
      expect(similarity).toBeLessThan(0.75);
      expect(assessNativeAudioTranscript({
        expectedLocale: "te",
        expectedDialogue,
        expectedPhoneticDialogue,
        transcript,
        providerDetectedLanguage: "ta",
      })).toEqual({ outcome: "pass", detectedLocale: "te" });
    });

    it("still rejects half-wrong speech", () => {
      expect(assessNativeAudioTranscript({
        expectedLocale: "te",
        expectedDialogue: "మన చిన్న తార కోసం ఎంత దూరమైనా వెళ్తాం",
        expectedPhoneticDialogue:
          "Mana chinna tara kosam enta duramaina veltam.",
        transcript: "மன சின்ன தார வேறு விஷயத்தைப் பற்றி",
        providerDetectedLanguage: "ta",
      })).toEqual({ outcome: "wrong_language", detectedLocale: "ta" });
    });

    it("keeps the stricter 0.75 bar when ASR agrees it is Telugu", () => {
      const changedDialogue =
        "Ade veedi ave tapasulu ippudu manchi shop ekkada undi";
      expect(nativeAudioTranscriptDiagnostics({
        expectedDialogue,
        expectedPhoneticDialogue,
        transcript: changedDialogue,
        providerDetectedLanguage: "te",
      }).dialogueSimilarity).toBeLessThan(0.75);
      expect(assessNativeAudioTranscript({
        expectedLocale: "te",
        expectedDialogue,
        expectedPhoneticDialogue,
        transcript: changedDialogue,
        providerDetectedLanguage: "te",
      }).outcome).toBe("dialogue_drift");
    });
  });

  it("does not accept reordered Telugu on phonetic similarity alone", () => {
    expect(assessNativeAudioTranscript({
      expectedLocale: "te",
      expectedDialogue:
        "మన చిన్న తార కోసం ఎంత దూరమైనా వెళ్తాం ఆశకు ఆకాశమే హద్దు కాదు",
      expectedPhoneticDialogue:
        "Mana chinna tara kosam enta duramaina veltam aashaku akashame haddu kaadu",
      transcript:
        "ఆశకు ఆకాశమే హద్దు కాదు మన చిన్న తార కోసం ఎంత దూరమైనా వెళ్తాం",
      providerDetectedLanguage: "Telugu",
    }).outcome).toBe("dialogue_drift");
  });

  it("rejects clips with no transcribed speech", () => {
    expect(assessNativeAudioTranscript({
      expectedLocale: "en",
      expectedDialogue: "The market opens at sunrise",
      transcript: " ... ",
    })).toEqual({ outcome: "no_speech", detectedLocale: null });
  });
});