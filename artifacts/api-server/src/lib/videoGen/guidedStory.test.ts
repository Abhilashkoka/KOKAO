import { describe, expect, it } from "vitest";
import type { GuidedStoryCastSnapshot, GuidedStoryDraftState } from "@workspace/db";
import {
  GUIDED_STORY_PLATFORMS,
  GUIDED_SCENE_INSERTION_CLAIM_TTL_MS,
  GUIDED_SCENE_INSERTION_PROVIDER_TIMEOUT_MS,
  guidedBackdropCoversEveryScriptScene,
  guidedBackdropFingerprint,
  effectiveGuidedBackdrop,
  guidedStoryBackdropsAreApproved,
  guidedCastFailureDisposition,
  guidedCastHasDuplicates,
  guidedCastApprovalsMatch,
  guidedCastOperationCanRestart,
  guidedCastOperationCanResume,
  guidedStoryApprovalSnapshotMatches,
  guidedStoryEstimates,
  guidedStoryRolePlan,
  guidedStorySnapshotFingerprint,
  guidedStoryStoryboard,
  guidedStoryNativeScriptWarning,
  invalidateGuidedStoryDownstream,
  normalizeGuidedStoryLocale,
  planGuidedStoryDialogueReplay,
  validateAndRepairGuidedScript,
  validateGuidedStoryDialogueReplayInputs,
  validateGuidedStoryGeneratedSpeech,
  validateGuidedResumableCastOperation,
} from "./guidedStory";

function approvedBackdrop(
  prompt: string,
  imagePath: string,
  revision: number,
  sceneId: string | null,
) {
  const imageSha256 = "a".repeat(64);
  return {
    version: 1 as const,
    prompt,
    imagePath,
    imageSha256,
    revision,
    fingerprint: guidedBackdropFingerprint({
      prompt,
      imagePath,
      imageSha256,
      revision,
      sceneId,
    }),
    approvedAt: "2025-01-01T00:00:00.000Z",
  };
}

function validRaw(roleCount = 2) {
  const roles = Array.from({ length: roleCount }, (_, index) => ({
    id: `role-${index + 1}`,
    name: `Role ${index + 1}`,
    description: "A wholly fictional person",
  }));
  return {
    title: "A test story",
    logline: "Two people resolve a conflict.",
    roles,
    scenes: [
      {
        startMs: 0,
        endMs: 30_000,
        visualDirection: "A centered two shot",
        roleIds: roles.map((role) => role.id),
        lines: [
          {
            ownerRoleId: roles[0]!.id,
            kind: "dialogue",
            text: "We need to act now because the storm is closing every road and our friends need help before nightfall.",
            startMs: 0,
            endMs: 10_000,
          },
          {
            ownerRoleId: roles[1]!.id,
            kind: "dialogue",
            text: "Then let us begin together, follow the old river path, and bring everyone home safely before the last light fades.",
            startMs: 10_000,
            endMs: 20_000,
          },
        ],
      },
    ],
    warnings: [],
  };
}

function approvalFixture() {
  const script = validateAndRepairGuidedScript(validRaw(), {
    roleCount: 2,
    durationSeconds: 30,
  });
  const cast: GuidedStoryCastSnapshot[] = script.roles.map((role, index) => ({
    roleId: role.id,
    source: "saved",
    characterId: index + 1,
    outfitId: index + 11,
    brandKitId: 20,
    voiceId: `voice-${index}`,
    character: {
      name: role.name,
      description: role.description,
      referenceImagePath: `/objects/1/character-${index}.png`,
    },
    outfit: {
      name: "Approved outfit",
      description: "Exact approved wardrobe",
      referenceImagePath: `/objects/1/outfit-${index}.png`,
    },
    voice: {
      id: `voice-${index}`,
      label: `Voice ${index}`,
      provider: "elevenlabs",
      providerVoiceId: `provider-${index}`,
    },
    isUserRole: index === 0,
    consentGranted: true,
  }));
  const castApprovals = {
    version: 1 as const,
    draftRevision: 4,
    roles: Object.fromEntries(cast.map((member, index) => [
      member.roleId,
      {
        roleId: member.roleId,
        approvedAt: "2025-01-01T00:00:00.000Z",
        character: {
          referenceImagePath: member.character.referenceImagePath!,
          sha256: `${index + 1}`.repeat(64),
        },
        outfit: {
          referenceImagePath: member.outfit!.referenceImagePath!,
          sha256: `${index + 3}`.repeat(64),
        },
      },
    ])),
  };
  const backdropInput = {
    prompt: "A storm shelter command room",
    imagePath: "/objects/1/backdrop.png",
    sceneIds: script.scenes.map((scene) => scene.id),
  };
  const backdropReference = {
    version: 1 as const,
    ...backdropInput,
    fingerprint: guidedBackdropFingerprint(backdropInput),
    approvedAt: "2025-01-01T00:00:00.000Z",
  };
  const visualChoices = {
    version: 1 as const,
    logo: { path: null, sceneIds: [] as string[] },
    location: {
      mode: "none" as const,
      imagePath: null,
      description: null,
    },
    backdropReference,
  };
  const snapshot = {
    version: 1 as const,
    draftId: 7,
    draftRevision: 4,
    scriptApprovedAt: "2025-01-01T00:00:00.000Z",
    platform: {
      id: "tiktok",
      aspectRatio: "9:16" as const,
      width: 1080,
      height: 1920,
      safeArea: "center",
      durationSeconds: 30,
    },
    script,
    cast,
    castApprovals,
    visuals: visualChoices,
    backdropReference,
  };
  const storyboard = guidedStoryStoryboard(snapshot);
  storyboard.scenes = storyboard.scenes.map((scene) => ({
    ...scene,
    previewPath: `/objects/1/${scene.id}.png`,
    previewCheckpoint: {
      targetPath: `/objects/1/${scene.id}.png`,
      status: "complete",
    },
  }));
  const state: GuidedStoryDraftState = {
    version: 1,
    setup: null,
    script,
    scriptApprovedAt: snapshot.scriptApprovedAt,
    userRoleId: script.roles[0]!.id,
    castStrategy: "saved",
    cast,
    castApprovals,
    duplicateAssignmentConfirmed: false,
    scriptGeneration: null,
    castOperations: {},
    visualChoices,
    storyboardJobId: 44,
  };
  return { script, cast, castApprovals, snapshot, storyboard, state };
}

describe("guided story platform contracts", () => {
  it("normalizes supported BCP-47 tags and rejects unsupported or ambiguous locales", () => {
    expect(normalizeGuidedStoryLocale("te-IN")).toBe("te");
    expect(normalizeGuidedStoryLocale("te-Telu-IN")).toBe("te");
    expect(normalizeGuidedStoryLocale("te-Latn")).toBeNull();
    expect(normalizeGuidedStoryLocale("hi-Latn")).toBeNull();
    expect(normalizeGuidedStoryLocale("ta_IN")).toBe("ta");
    expect(normalizeGuidedStoryLocale("HI")).toBe("hi");
    expect(normalizeGuidedStoryLocale("en-US")).toBe("en");
    expect(normalizeGuidedStoryLocale("English")).toBeNull();
    expect(normalizeGuidedStoryLocale("fr-FR")).toBeNull();
  });

  it("preserves approved spoken text byte-for-byte", () => {
    const raw = validRaw();
    const exact = `  ${Array.from({ length: 18 }, () => "మనం").join(" ")}.  `;
    raw.scenes[0]!.lines[0]!.text = exact;
    const script = validateAndRepairGuidedScript(raw, {
      roleCount: 2,
      durationSeconds: 30,
    });
    expect(script.scenes[0]!.lines[0]!.text).toBe(exact);
    const { snapshot } = approvalFixture();
    const storyboard = guidedStoryStoryboard({
      ...snapshot,
      locale: "te",
      script,
    });
    expect(storyboard.scenes[0]!.text).toContain(exact);
  });

  it("accepts expected native scripts and rejects clearly Romanized local speech", () => {
    const script = validateAndRepairGuidedScript(validRaw(), {
      roleCount: 2,
      durationSeconds: 30,
    });
    const withSpeech = (first: string, second: string) => ({
      ...script,
      scenes: [{
        ...script.scenes[0]!,
        lines: script.scenes[0]!.lines.map((line, index) => ({
          ...line,
          text: index === 0 ? first : second,
        })),
      }],
    });
    expect(guidedStoryNativeScriptWarning(withSpeech("మనం ఇప్పుడు వెళ్ళాలి.", "నేను సిద్ధంగా ఉన్నాను."), "te")).toBeNull();
    expect(guidedStoryNativeScriptWarning(withSpeech("நாம் இப்போது செல்ல வேண்டும்.", "நான் தயாராக இருக்கிறேன்."), "ta")).toBeNull();
    expect(guidedStoryNativeScriptWarning(withSpeech("हमें अभी जाना चाहिए।", "मैं तैयार हूँ।"), "hi")).toBeNull();
    expect(guidedStoryNativeScriptWarning(script, "en")).toBeNull();
    expect(
      guidedStoryNativeScriptWarning(
        withSpeech("మనం ఇప్పుడు వెళ్ళాలి.", "Nenu siddhanga unnanu."),
        "te",
      ),
    ).toMatch(/1 spoken line appears.*Romanized.*every spoken line/i);
    expect(() =>
      validateGuidedStoryGeneratedSpeech(
        withSpeech("மనం இப்போது செல்ல வேண்டும்.", "Naan thayaaraga irukkiren."),
        "ta",
      ),
    ).toThrow(/spoken line appears.*Romanized.*Retry generation/i);
    expect(() => validateGuidedStoryGeneratedSpeech(script, "te")).toThrow(
      /Romanized.*native Telugu script.*every spoken line.*Retry generation/i,
    );
  });

  it("keeps the reclaimable generating lease beyond the bounded provider call", () => {
    expect(GUIDED_SCENE_INSERTION_PROVIDER_TIMEOUT_MS).toBe(120_000);
    expect(GUIDED_SCENE_INSERTION_CLAIM_TTL_MS).toBeGreaterThan(
      GUIDED_SCENE_INSERTION_PROVIDER_TIMEOUT_MS,
    );
  });

  it("only recommends and allows 2-4 roles deterministically", () => {
    for (const platform of GUIDED_STORY_PLATFORMS) {
      for (const duration of platform.durations) {
        const first = guidedStoryRolePlan(platform.id, duration);
        const second = guidedStoryRolePlan(platform.id, duration);
        expect(first).toEqual(second);
        expect(first.allowed.every((count) => count >= 2 && count <= 4)).toBe(true);
        expect(first.allowed).toContain(first.recommended);
      }
    }
    expect(guidedStoryRolePlan("instagram_reels", 15).allowed).toEqual([2]);
    expect(guidedStoryRolePlan("instagram_reels", 30).allowed).toEqual([2]);
    expect(guidedStoryRolePlan("instagram_reels", 60).allowed).toEqual([2, 3]);
    expect(guidedStoryRolePlan("instagram_reels", 90).allowed).toEqual([2, 3]);
    expect(guidedStoryRolePlan("youtube", 180).allowed).toEqual([2, 3, 4]);
  });

  it("rejects illegal platform durations", () => {
    expect(() => guidedStoryRolePlan("tiktok", 300)).toThrow();
  });
});

describe("guided story immutable storyboard adapter", () => {
  it("scopes a logo to selected scenes and fingerprints shared location direction", () => {
    const script = validateAndRepairGuidedScript(validRaw(), {
      roleCount: 2,
      durationSeconds: 30,
    });
    const cast: GuidedStoryCastSnapshot[] = script.roles.map((role, index) => ({
      roleId: role.id, source: "saved", characterId: index + 1, outfitId: index + 10,
      brandKitId: null, voiceId: `voice-${index}`,
      character: { name: role.name, description: role.description, referenceImagePath: `/objects/1/uploads/character-${index}.png` },
      outfit: { name: "Outfit", description: "approved outfit", referenceImagePath: `/objects/1/uploads/outfit-${index}.png` },
      voice: { id: `voice-${index}`, label: "Voice", provider: "stock", providerVoiceId: null },
      isUserRole: index === 0, consentGranted: true,
    }));
    const base = {
      version: 1 as const, draftId: 1, draftRevision: 1,
      scriptApprovedAt: "2025-01-01T00:00:00.000Z",
      platform: { id: "tiktok", aspectRatio: "9:16" as const, width: 1080, height: 1920, safeArea: "center", durationSeconds: 30 },
      script, cast,
    };
    const withVisuals = {
      ...base,
      visuals: {
        version: 1 as const,
        logo: { path: "/objects/1/uploads/logo.png", sceneIds: [script.scenes[0]!.id] },
        location: { mode: "text" as const, imagePath: null, description: "A rain-washed mountain village at dawn." },
      },
    };
    const board = guidedStoryStoryboard(withVisuals);
    expect(board.scenes[0]!.guidedStory?.visuals).toMatchObject({
      logoPath: "/objects/1/uploads/logo.png",
      locationMode: "text",
    });
    expect(board.scenes[0]!.visual).toContain("rain-washed mountain village");
    const withoutLogo = guidedStoryStoryboard({
      ...withVisuals,
      visuals: { ...withVisuals.visuals, logo: { path: null, sceneIds: [] } },
    });
    expect(withoutLogo.scenes[0]!.guidedStory?.inputFingerprint).not.toBe(
      board.scenes[0]!.guidedStory?.inputFingerprint,
    );
  });

  it("preserves exact scene timing/ownership and reuses only unaffected receipts", () => {
    const script = validateAndRepairGuidedScript(validRaw(), {
      roleCount: 2,
      durationSeconds: 30,
    });
    const cast: GuidedStoryCastSnapshot[] = script.roles.map((role, index) => ({
      roleId: role.id,
      source: "saved",
      characterId: index + 1,
      outfitId: index + 11,
      brandKitId: index + 21,
      voiceId: `voice-${index}`,
      character: {
        name: role.name,
        description: role.description,
        referenceImagePath: `/objects/1/character-${index}.png`,
      },
      outfit: {
        name: "Approved outfit",
        description: "Exact approved wardrobe",
        referenceImagePath: `/objects/1/outfit-${index}.png`,
      },
      voice: {
        id: `voice-${index}`,
        label: `Voice ${index}`,
        provider: "elevenlabs",
        providerVoiceId: `provider-${index}`,
      },
      isUserRole: index === 0,
      consentGranted: true,
    }));
    const snapshot = {
      version: 1 as const,
      draftId: 1,
      draftRevision: 3,
      scriptApprovedAt: "2025-01-01T00:00:00.000Z",
      platform: {
        id: "tiktok",
        aspectRatio: "9:16" as const,
        width: 1080,
        height: 1920,
        safeArea: "center",
        durationSeconds: 30,
      },
      script,
      cast,
    };
    const first = guidedStoryStoryboard(snapshot);
    expect(first.mode).toBe("guided_story");
    expect(first.scenes[0]!.id).toBe(script.scenes[0]!.id);
    expect(first.scenes[0]!.durationSec).toBe(30);
    expect(first.scenes[0]!.guidedStory?.lineOwnership).toEqual(
      script.scenes[0]!.lines.map((line) => ({
        lineId: line.id,
        ownerRoleId: line.ownerRoleId,
        kind: line.kind,
        text: line.text,
        englishTranslation: line.englishTranslation ?? null,
        startMs: line.startMs,
        endMs: line.endMs,
      })),
    );
    const localized = guidedStoryStoryboard({ ...snapshot, locale: "te" });
    expect(localized.scenes[0]!.guidedStory?.inputFingerprint).not.toBe(
      first.scenes[0]!.guidedStory?.inputFingerprint,
    );
    const translationOnly = {
      ...snapshot,
      script: {
        ...snapshot.script,
        scenes: snapshot.script.scenes.map((scene) => ({
          ...scene,
          lines: scene.lines.map((line) => ({
            ...line,
            englishTranslation: "Display-only changed meaning",
          })),
        })),
      },
    };
    expect(guidedStorySnapshotFingerprint(translationOnly)).toBe(
      guidedStorySnapshotFingerprint(snapshot),
    );
    const reusedAfterTranslationChange = guidedStoryStoryboard(translationOnly, first);
    expect(reusedAfterTranslationChange.scenes[0]!.guidedStory?.inputFingerprint).toBe(
      first.scenes[0]!.guidedStory?.inputFingerprint,
    );
    const paid = {
      ...first,
      narration: {
        audioPath: "/objects/1/uploads/narration.wav",
        totalDurationSec: 30,
        cues: [{ text: first.scenes[0]!.text, startSec: 0, endSec: 30 }],
      },
      scenes: first.scenes.map((scene) => ({
        ...scene,
        previewPath: "/objects/1/approved.png",
        providerCheckpoint: {
          path: "/objects/1/approved.mp4",
          provider: "mock",
          model: "mock",
          durationSec: scene.durationSec,
          event: {
            eventId: "receipt-1",
            provider: "mock",
            model: "mock",
            durationSec: scene.durationSec,
            requestBytes: 1,
            label: "scene",
            costPaise: 1,
          },
        },
      })),
    };
    expect(guidedStoryStoryboard(snapshot, paid).scenes[0]!.previewPath).toBe(
      "/objects/1/approved.png",
    );
    const changed = {
      ...snapshot,
      cast: snapshot.cast.map((member, index) =>
        index === 0
          ? {
              ...member,
              outfit: {
                ...member.outfit!,
                referenceImagePath: "/objects/1/new-outfit.png",
              },
            }
          : member),
    };
    const invalidated = guidedStoryStoryboard(changed, paid);
    expect(invalidated.scenes[0]!.previewPath).toBeNull();
    expect(invalidated.scenes[0]!.providerCheckpoint).toBeNull();
    expect(invalidated.narration).toEqual(paid.narration);
  });
});

describe("guided story dialogue replay", () => {
  function replayFixture() {
    const fixture = approvalFixture();
    const exactDialogue = "  మనం ఇప్పుడే కలిసి బయలుదేరాలి.  ";
    const exactNarration = "వాళ్లు వెలుతురు వైపు నిశ్శబ్దంగా నడిచారు.";
    const script = {
      ...fixture.script,
      scenes: fixture.script.scenes.map((scene) => ({
        ...scene,
        lines: [
          { ...scene.lines[0]!, text: exactDialogue, englishTranslation: "We must leave now." },
          {
            ...scene.lines[1]!,
            ownerRoleId: null,
            kind: "narration" as const,
            text: exactNarration,
          },
        ],
      })),
    };
    const snapshot = {
      ...fixture.snapshot,
      locale: "te" as const,
      script,
    };
    const storyboard = guidedStoryStoryboard(snapshot);
    storyboard.scenes = storyboard.scenes.map((scene) => ({
      ...scene,
      previewPath: `/objects/1/${scene.id}-approved.png`,
      previewCheckpoint: {
        targetPath: `/objects/1/${scene.id}-approved.png`,
        status: "complete" as const,
      },
    }));
    return { snapshot, storyboard, exactDialogue, exactNarration };
  }

  it("plans exact ordered role and offscreen segments from approved inputs", () => {
    const { snapshot, storyboard, exactDialogue, exactNarration } = replayFixture();
    const segments = planGuidedStoryDialogueReplay(snapshot, storyboard);

    expect(segments.map(({ sceneId, lineId, startMs, endMs, text }) => ({
      sceneId, lineId, startMs, endMs, text,
    }))).toEqual(snapshot.script.scenes.flatMap((scene) =>
      scene.lines.map((line) => ({
        sceneId: scene.id,
        lineId: line.id,
        startMs: line.startMs,
        endMs: line.endMs,
        text: line.text,
      }))));
    expect(segments[0]).toMatchObject({
      text: exactDialogue,
      speaker: {
        type: "role",
        roleId: "role-1",
        voice: { provider: "elevenlabs", providerVoiceId: "provider-0" },
      },
      preview: { path: "/objects/1/scene-1-approved.png" },
      backdrop: {
        path: snapshot.backdropReference!.imagePath,
        fingerprint: snapshot.backdropReference!.fingerprint,
      },
    });
    expect("englishTranslation" in segments[0]!).toBe(false);
    expect(segments[1]).toMatchObject({
      text: exactNarration,
      speaker: { type: "offscreen", roleId: null, voice: null },
    });
  });

  it("accepts and preserves legacy approved Romanized Telugu dialogue exactly", () => {
    const { snapshot, storyboard } = replayFixture();
    const romanized = "  Manam ippude kalisi bayaluderali.  ";
    const legacySnapshot = {
      ...snapshot,
      script: {
        ...snapshot.script,
        scenes: snapshot.script.scenes.map((scene) => ({
          ...scene,
          lines: scene.lines.map((line, index) =>
            index === 0 ? { ...line, text: romanized } : line),
        })),
      },
    };
    const legacyStoryboard = guidedStoryStoryboard(legacySnapshot);
    legacyStoryboard.scenes = legacyStoryboard.scenes.map((scene) => ({
      ...scene,
      previewPath: `/objects/1/${scene.id}-approved.png`,
      previewCheckpoint: {
        targetPath: `/objects/1/${scene.id}-approved.png`,
        status: "complete" as const,
      },
    }));

    expect(planGuidedStoryDialogueReplay(legacySnapshot, legacyStoryboard)[0]!.text)
      .toBe(romanized);
  });

  it("rejects non-Telugu, unapproved voices, fingerprint drift, and missing previews", () => {
    const { snapshot, storyboard } = replayFixture();
    expect(() =>
      validateGuidedStoryDialogueReplayInputs(
        { ...snapshot, locale: "en" },
        storyboard,
      ),
    ).toThrow(/Telugu snapshot/);
    const snapshotWithStockVoice = {
      ...snapshot,
      cast: snapshot.cast.map((member, index) =>
        index === 0
          ? { ...member, voice: { ...member.voice, provider: "stock" } }
          : member),
    };
    const boardWithStockVoice = guidedStoryStoryboard(snapshotWithStockVoice);
    boardWithStockVoice.scenes = boardWithStockVoice.scenes.map((scene) => ({
      ...scene,
      previewPath: `/objects/1/${scene.id}-approved.png`,
      previewCheckpoint: {
        targetPath: `/objects/1/${scene.id}-approved.png`,
        status: "complete" as const,
      },
    }));
    expect(() =>
      validateGuidedStoryDialogueReplayInputs(
        snapshotWithStockVoice,
        boardWithStockVoice,
      ),
    ).toThrow(/approved ElevenLabs voice/);
    expect(() =>
      validateGuidedStoryDialogueReplayInputs(snapshot, {
        ...storyboard,
        scenes: storyboard.scenes.map((scene, index) =>
          index === 0
            ? {
                ...scene,
                guidedStory: {
                  ...scene.guidedStory!,
                  inputFingerprint: "tampered",
                },
              }
            : scene),
      }),
    ).toThrow(/approved fingerprint/);
    expect(() =>
      validateGuidedStoryDialogueReplayInputs(snapshot, {
        ...storyboard,
        scenes: storyboard.scenes.map((scene, index) =>
          index === 0 ? { ...scene, previewPath: null } : scene),
      }),
    ).toThrow(/approved preview/);
  });
});

describe("guided cast provider uncertainty", () => {
  it("accepts a canonical JPEG provider checkpoint for safe resume", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9]);
    expect(
      validateGuidedResumableCastOperation({
        operation: {
          revision: 3,
          operationKey: "guided-story-cast:8:3:ravi",
          voiceId: "stock:alloy",
          status: "provider_succeeded",
          claimedAt: "2026-08-29T00:00:00.000Z",
          updatedAt: "2026-08-29T00:00:01.000Z",
          funding: "quota",
          provider: "replicate",
          model: "image-model",
          imageBase64: jpeg.toString("base64"),
          imageByteLength: jpeg.length,
        } as any,
        tenantId: 4,
        draftId: 8,
        revision: 3,
        roleId: "ravi",
        voiceId: "stock:alloy",
      }),
    ).toEqual({ valid: true });
  });

  it("retains ambiguous generated-cast funding as provider_outcome_unknown", () => {
    expect(guidedCastFailureDisposition(false)).toEqual({
      releaseFunding: false,
      nextStatus: "provider_outcome_unknown",
    });
    expect(guidedCastFailureDisposition(true)).toEqual({
      releaseFunding: true,
      nextStatus: null,
    });
  });

  it("never reclaims stale provider_running or indeterminate work", () => {
    const base = {
      revision: 2,
      operationKey: "guided-story-cast:1:2:role-2",
      voiceId: "voice-2",
      claimedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    const now = Date.parse("2025-01-02T00:00:00.000Z");
    expect(
      guidedCastOperationCanRestart(
        { ...base, status: "provider_running" },
        now,
        60_000,
      ),
    ).toBe(false);
    expect(
      guidedCastOperationCanRestart(
        { ...base, status: "provider_outcome_unknown" },
        now,
        60_000,
      ),
    ).toBe(false);
    expect(
      guidedCastOperationCanRestart({ ...base, status: "funded" }, now, 60_000),
    ).toBe(true);
  });

  it("resumes only exact provider_succeeded and uploaded operation identities", () => {
    const base = {
      revision: 2,
      operationKey: "guided-story-cast:1:2:role-2",
      voiceId: "voice-2",
      claimedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    const expected = {
      revision: 2,
      operationKey: base.operationKey,
      voiceId: base.voiceId,
    };
    expect(
      guidedCastOperationCanResume(
        { ...base, status: "provider_succeeded", imageBase64: "cGFpZA==" },
        expected,
      ),
    ).toBe(true);
    expect(
      guidedCastOperationCanResume(
        { ...base, status: "uploaded", path: "/objects/1/paid.png" },
        expected,
      ),
    ).toBe(true);
    expect(
      guidedCastOperationCanResume({ ...base, status: "provider_running" }, expected),
    ).toBe(false);
    expect(
      guidedCastOperationCanResume(
        { ...base, status: "provider_outcome_unknown" },
        expected,
      ),
    ).toBe(false);
    expect(
      guidedCastOperationCanResume(
        { ...base, status: "uploaded" },
        { ...expected, operationKey: `${expected.operationKey}:different` },
      ),
    ).toBe(false);
  });
});

describe("per-scene Guided Story backdrops", () => {
  it("resolves an approved override without weakening the approved default gate", () => {
    const fixture = approvalFixture();
    const sceneId = fixture.snapshot.script.scenes[0]!.id;
    const defaultReference = approvedBackdrop(
      "Default command room",
      "/objects/1/default.png",
      1,
      null,
    );
    const override = approvedBackdrop(
      "Scene-specific rooftop",
      "/objects/1/rooftop.png",
      1,
      sceneId,
    );
    const snapshot = {
      ...fixture.snapshot,
      backdrops: {
        version: 1 as const,
        default: defaultReference,
        sceneOverrides: { [sceneId]: override },
      },
    };

    expect(guidedStoryBackdropsAreApproved(snapshot)).toBe(true);
    expect(effectiveGuidedBackdrop(snapshot, sceneId)).toEqual({
      source: "override",
      reference: override,
    });
    expect(guidedStoryStoryboard(snapshot).scenes[0]!.guidedStory!.visuals).toMatchObject({
      backdropSource: "override",
      backdropReferencePath: override.imagePath,
      backdropRevision: 1,
      backdropImageSha256: override.imageSha256,
    });
  });

  it("fails closed for an active unapproved override", () => {
    const fixture = approvalFixture();
    const sceneId = fixture.snapshot.script.scenes[0]!.id;
    const pending = {
      ...approvedBackdrop("Pending room", "/objects/1/pending.png", 2, sceneId),
      approvedAt: null,
    };
    const snapshot = {
      ...fixture.snapshot,
      backdrops: {
        version: 1 as const,
        default: approvedBackdrop("Default room", "/objects/1/default.png", 1, null),
        sceneOverrides: { [sceneId]: pending },
      },
    };

    expect(guidedStoryBackdropsAreApproved(snapshot)).toBe(false);
    expect(guidedStoryStoryboard(snapshot).scenes[0]!.guidedStory!.visuals)
      .toMatchObject({ backdropSource: "override", backdropReferencePath: pending.imagePath });
  });
});

describe("guided approval fail-closed snapshot guard", () => {
  it("requires the approved shared backdrop to cover every script scene exactly once", () => {
    const fixture = approvalFixture();
    expect(guidedBackdropCoversEveryScriptScene(fixture.snapshot)).toBe(true);

    const partial = structuredClone(fixture.snapshot);
    partial.backdropReference!.sceneIds = [];
    expect(guidedBackdropCoversEveryScriptScene(partial)).toBe(false);

    const duplicated = structuredClone(fixture.snapshot);
    duplicated.backdropReference!.sceneIds = [
      ...duplicated.backdropReference!.sceneIds,
      duplicated.backdropReference!.sceneIds[0]!,
    ];
    expect(guidedBackdropCoversEveryScriptScene(duplicated)).toBe(false);
  });

  it("requires every role, current revision, exact paths, and SHA-256 fingerprints", () => {
    const fixture = approvalFixture();
    expect(guidedStoryEstimates(fixture.state)).toMatchObject({
      castAssetUnits: 0,
      generatedStrategyCastUnits: 1,
      savedStrategyCastUnits: 0,
    });
    expect(
      guidedStoryEstimates({
        ...fixture.state,
        castStrategy: "generated",
        cast: fixture.cast.slice(0, 1),
      }),
    ).toMatchObject({
      castAssetUnits: 1,
      generatedStrategyCastUnits: 1,
    });
  });

  it("does not count foreign or malformed completed operation keys as paid assets", () => {
    const fixture = approvalFixture();
    const changed = structuredClone(fixture.snapshot);
    changed.castApprovals!.roles["role-1"]!.outfit.sha256 = "f".repeat(64);
    expect(guidedStorySnapshotFingerprint(changed)).not.toBe(
      guidedStorySnapshotFingerprint(fixture.snapshot),
    );
    expect(guidedStoryStoryboard(changed).scenes[0]!.guidedStory!.inputFingerprint).not.toBe(
      fixture.storyboard.scenes[0]!.guidedStory!.inputFingerprint,
    );
  });

  it("rejects revision drift, cast fingerprints, scene fingerprints, and cast operations", () => {
    const fixture = approvalFixture();
    const check = (
      overrides: Partial<Parameters<typeof guidedStoryApprovalSnapshotMatches>[0]> = {},
    ) =>
      guidedStoryApprovalSnapshotMatches({
        draftId: 7,
        draftRevision: 4,
        draftState: fixture.state,
        jobId: 44,
        snapshot: fixture.snapshot,
        storyboard: fixture.storyboard,
        ...overrides,
      });
    expect(check()).toBe(true);
    expect(check({ draftRevision: 5 })).toBe(false);
    expect(
      check({
        draftState: {
          ...fixture.state,
          cast: fixture.cast.map((member, index) =>
            index === 1
              ? { ...member, character: { ...member.character, name: "Changed" } }
              : member),
        },
      }),
    ).toBe(false);
    expect(
      check({
        storyboard: {
          ...fixture.storyboard,
          scenes: fixture.storyboard.scenes.map((scene) => ({
            ...scene,
            visual: `${scene.visual} drift`,
          })),
        },
      }),
    ).toBe(false);
    expect(
      check({
        storyboard: {
          ...fixture.storyboard,
          scenes: fixture.storyboard.scenes.map((scene) => ({
            ...scene,
            previewCheckpoint: { ...scene.previewCheckpoint!, status: "prepared" },
          })),
        },
      }),
    ).toBe(false);
    expect(
      check({
        storyboard: {
          ...fixture.storyboard,
          scenes: fixture.storyboard.scenes.map((scene, index) =>
            index === 0
              ? {
                  ...scene,
                  guidedStory: {
                    ...scene.guidedStory!,
                    cast: scene.guidedStory!.cast.map((member, castIndex) =>
                      castIndex === 0
                        ? {
                            ...member,
                            referenceImagePath:
                              "/objects/1/tampered-character.png",
                          }
                        : member),
                  },
                }
              : scene),
        },
      }),
    ).toBe(false);
    expect(
      check({
        draftState: {
          ...fixture.state,
          castOperations: {
            "role-2": {
              revision: 4,
              operationKey: "guided-story-cast:7:4:role-2",
              voiceId: "voice-2",
              status: "claimed",
              claimedAt: "2025-01-01T00:00:00.000Z",
              updatedAt: "2025-01-01T00:00:00.000Z",
            },
          },
        },
      }),
    ).toBe(false);
  });
});

describe("guided story estimates", () => {
  it("quotes generated preselection while saved castAssetUnits remains zero", () => {
    const fixture = approvalFixture();
    expect(guidedStoryEstimates(fixture.state)).toMatchObject({
      castAssetUnits: 0,
      generatedStrategyCastUnits: 1,
      savedStrategyCastUnits: 0,
    });
    expect(
      guidedStoryEstimates({
        ...fixture.state,
        castStrategy: "generated",
        cast: fixture.cast.slice(0, 1),
      }),
    ).toMatchObject({
      castAssetUnits: 1,
      generatedStrategyCastUnits: 1,
    });
  });

  it("does not count foreign or malformed completed operation keys as paid assets", () => {
    const fixture = approvalFixture();
    const malformed = {
      revision: 4,
      operationKey: "guided-story-cast:7:4:intruder",
      voiceId: "voice-x",
      status: "uploaded" as const,
      claimedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      funding: "quota" as const,
      provider: "mock",
      model: "mock",
      path: "/objects/1/uploads/foreign.png",
      settledAt: "2025-01-01T00:00:00.000Z",
    };
    expect(
      guidedStoryEstimates(
        {
          ...fixture.state,
          castStrategy: "generated",
          cast: fixture.cast.slice(0, 1),
          castOperations: { intruder: malformed, friend: malformed },
        },
        { tenantId: 1, draftId: 7, revision: 4 },
      ),
    ).toMatchObject({ castAssetUnits: 1, generatedStrategyCastUnits: 1 });
  });
});

describe("guided story script validation", () => {
  it("repairs missing stable ids but preserves valid ownership and timing", () => {
    const script = validateAndRepairGuidedScript(validRaw(), {
      roleCount: 2,
      durationSeconds: 30,
    });
    expect(script.roles.map((role) => role.id)).toEqual(["role-1", "role-2"]);
    expect(script.scenes[0]!.id).toBe("scene-1");
    expect(script.scenes[0]!.lines.map((line) => line.id)).toEqual([
      "scene-1-line-1",
      "scene-1-line-2",
    ]);
  });

  it("rejects unknown dialogue owners, overlaps, role-count drift, and runtime overflow", () => {
    const unknown = validRaw();
    unknown.scenes[0]!.lines[0]!.ownerRoleId = "foreign-role";
    expect(() =>
      validateAndRepairGuidedScript(unknown, { roleCount: 2, durationSeconds: 30 }),
    ).toThrow(/unknown role/);

    const overlap = validRaw();
    overlap.scenes[0]!.lines[1]!.startMs = 5_000;
    expect(() =>
      validateAndRepairGuidedScript(overlap, { roleCount: 2, durationSeconds: 30 }),
    ).toThrow(/invalid timing/);

    expect(() =>
      validateAndRepairGuidedScript(validRaw(3), { roleCount: 2, durationSeconds: 30 }),
    ).toThrow(/exactly 2 roles/);
    expect(() =>
      validateAndRepairGuidedScript(validRaw(), { roleCount: 2, durationSeconds: 20 }),
    ).toThrow(/runtime/);
  });
});

describe("guided story invalidation and duplicate confirmation rules", () => {
  it("clears every downstream approval and never restores consent", () => {
    const script = validateAndRepairGuidedScript(validRaw(), {
      roleCount: 2,
      durationSeconds: 30,
    });
    const state: GuidedStoryDraftState = {
      version: 1,
      setup: null,
      script,
      scriptApprovedAt: "2025-01-01T00:00:00.000Z",
      userRoleId: "role-1",
      castStrategy: "saved",
      cast: [],
      duplicateAssignmentConfirmed: true,
      scriptGeneration: null,
      castOperations: {},
      storyboardJobId: 99,
    };
    expect(invalidateGuidedStoryDownstream(state, script)).toMatchObject({
      scriptApprovedAt: null,
      userRoleId: null,
      castStrategy: null,
      cast: [],
      duplicateAssignmentConfirmed: false,
      storyboardJobId: null,
    });
  });

  it("detects duplicate server-resolved identity and provider voice snapshots", () => {
    const base: GuidedStoryCastSnapshot = {
      roleId: "role-1",
      source: "saved",
      characterId: 1,
      outfitId: 2,
      brandKitId: 3,
      voiceId: "v1",
      character: { name: "A", description: "A", referenceImagePath: "/objects/1/a" },
      outfit: null,
      voice: { id: "v1", label: "Voice", provider: "elevenlabs", providerVoiceId: "provider-v1" },
      isUserRole: true,
      consentGranted: true,
    };
    expect(
      guidedCastHasDuplicates([
        base,
        { ...base, roleId: "role-2", isUserRole: false },
      ]),
    ).toBe(true);
    expect(
      guidedCastHasDuplicates([
        base,
        {
          ...base,
          roleId: "role-2",
          characterId: 4,
          voiceId: "v2",
          voice: { ...base.voice, id: "v2", providerVoiceId: "provider-v2" },
          isUserRole: false,
        },
      ]),
    ).toBe(false);
  });
});
