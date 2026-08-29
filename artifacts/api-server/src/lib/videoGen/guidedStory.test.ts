import { describe, expect, it } from "vitest";
import type { GuidedStoryCastSnapshot, GuidedStoryDraftState } from "@workspace/db";
import {
  GUIDED_STORY_PLATFORMS,
  guidedCastFailureDisposition,
  guidedCastHasDuplicates,
  guidedCastOperationCanRestart,
  guidedCastOperationCanResume,
  guidedStoryApprovalSnapshotMatches,
  guidedStoryEstimates,
  guidedStoryRolePlan,
  guidedStoryStoryboard,
  invalidateGuidedStoryDownstream,
  validateAndRepairGuidedScript,
} from "./guidedStory";

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
  };
  const storyboard = guidedStoryStoryboard(snapshot);
  storyboard.scenes = storyboard.scenes.map((scene) => ({
    ...scene,
    previewPath: `/objects/1/${scene.id}.png`,
  }));
  const state: GuidedStoryDraftState = {
    version: 1,
    setup: null,
    script,
    scriptApprovedAt: snapshot.scriptApprovedAt,
    userRoleId: script.roles[0]!.id,
    castStrategy: "saved",
    cast,
    duplicateAssignmentConfirmed: false,
    scriptGeneration: null,
    castOperations: {},
    storyboardJobId: 44,
  };
  return { script, cast, snapshot, storyboard, state };
}

describe("guided story platform contracts", () => {
  it("only recommends and allows 2-4 roles deterministically", () => {
    for (const platform of GUIDED_STORY_PLATFORMS) {
      for (const duration of platform.durations) {
        const first = guidedStoryRolePlan(platform.id, duration);
        const second = guidedStoryRolePlan(platform.id, duration);
        expect(first).toEqual(second);
        expect(first.allowed.every((count) => count >= 2 && count <= 4)).toBe(true);
        expect(first.allowed).toContain(first.recommended);
        if (platform.mobileFirst) expect(first.allowed).toEqual([2]);
      }
    }
  });

  it("rejects illegal platform durations", () => {
    expect(() => guidedStoryRolePlan("tiktok", 300)).toThrow();
  });
});

describe("guided story immutable storyboard adapter", () => {
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
        startMs: line.startMs,
        endMs: line.endMs,
      })),
    );
    const paid = {
      ...first,
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
  });
});

describe("guided cast provider uncertainty", () => {
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

describe("guided approval fail-closed snapshot guard", () => {
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
          scenes: fixture.storyboard.scenes.map((scene, index) =>
            index === 0
              ? {
                  ...scene,
                  guidedStory: {
                    ...scene.guidedStory!,
                    inputFingerprint: "different",
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