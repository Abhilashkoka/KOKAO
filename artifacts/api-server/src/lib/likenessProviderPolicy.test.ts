import { describe, expect, it } from "vitest";
import {
  declaredProviderCoverage,
  PROVIDER_LIKENESS_DECLARATIONS,
  providerLikenessDeclaration,
  recipientScopeLabel,
  resolveLikenessRouting,
  type LikenessSurface,
} from "./likenessProviderPolicy";
import { IMAGE_GEN_PROVIDERS } from "./imageGen";
import { VIDEO_GEN_PROVIDERS } from "./videoGen";
import {
  ATLASCLOUD_WAN_30_PRIME_REFERENCE_MODEL,
  ATLASCLOUD_WAN_30_REFERENCE_MODEL,
} from "./videoGen/providers/atlascloud";

const REAL = "uploaded_self" as const;
const AUTHORIZED = "uploaded_authorized_person" as const;
const GENERATED = "generated_fictional" as const;

describe("provider likeness declarations", () => {
  it("covers every provider in both registries", () => {
    const coverage = declaredProviderCoverage([
      ...IMAGE_GEN_PROVIDERS.map((def) => ({
        surface: "image" as LikenessSurface,
        providerId: def.id,
      })),
      ...VIDEO_GEN_PROVIDERS.map((def) => ({
        surface: "video" as LikenessSurface,
        providerId: def.id,
      })),
    ]);
    // A newly added provider must fail here until someone decides what it may
    // receive. That is the whole point: no provider becomes eligible silently.
    expect(coverage.missing).toEqual([]);
    expect(coverage.extra).toEqual([]);
  });

  it("keeps the inlined Atlas model ids identical to the adapter's", () => {
    const atlas = providerLikenessDeclaration("video", "atlascloud");
    expect(atlas?.realLikenessModelAllowlist).toEqual([
      ATLASCLOUD_WAN_30_REFERENCE_MODEL,
      ATLASCLOUD_WAN_30_PRIME_REFERENCE_MODEL,
    ]);
  });

  it("never leaves a declaration without a stated basis", () => {
    for (const declaration of PROVIDER_LIKENESS_DECLARATIONS) {
      expect(declaration.basis.trim().length).toBeGreaterThan(20);
    }
  });
});

describe("resolveLikenessRouting", () => {
  it("fails closed for an unknown provider", () => {
    const verdict = resolveLikenessRouting({
      surface: "image",
      provider: "some-new-thing",
      model: "m",
      operation: "outfit",
      subjectClass: REAL,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining("undeclared recipient") });
  });

  it("fails closed for a declared-but-unreviewed provider", () => {
    const verdict = resolveLikenessRouting({
      surface: "image",
      provider: "stability",
      model: "core",
      operation: "outfit",
      subjectClass: REAL,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining("no reviewed position") });
  });

  it("refuses Replicate and OpenRouter for BOTH real and generated faces", () => {
    for (const provider of ["replicate", "openrouter"]) {
      for (const subjectClass of [REAL, GENERATED]) {
        for (const surface of ["image", "video"] as const) {
          const verdict = resolveLikenessRouting({
            surface,
            provider,
            model: "google/nano-banana-pro",
            operation: surface === "image" ? "outfit" : "video",
            subjectClass,
          });
          expect(verdict.allowed).toBe(false);
        }
      }
    }
  });

  it("never routes a likeness to an admin-entered custom endpoint", () => {
    const verdict = resolveLikenessRouting({
      surface: "image",
      provider: "custom",
      model: "whatever",
      operation: "reference_sheet",
      subjectClass: GENERATED,
    });
    expect(verdict.allowed).toBe(false);
  });

  it("allows OpenAI for consented wardrobe and sheet work", () => {
    for (const operation of ["outfit", "reference_sheet"] as const) {
      expect(
        resolveLikenessRouting({
          surface: "image",
          provider: "openai",
          model: "gpt-image-1",
          operation,
          subjectClass: REAL,
        }).allowed,
      ).toBe(true);
    }
  });

  it("keeps Atlas real-likeness video on its exact Wan reference models only", () => {
    expect(
      resolveLikenessRouting({
        surface: "video",
        provider: "atlascloud",
        model: ATLASCLOUD_WAN_30_REFERENCE_MODEL,
        operation: "video",
        subjectClass: REAL,
      }).allowed,
    ).toBe(true);
    for (const model of [
      "bytedance/seedance-2.5/image-to-video",
      `${ATLASCLOUD_WAN_30_REFERENCE_MODEL}-custom`,
      null,
    ]) {
      expect(
        resolveLikenessRouting({
          surface: "video",
          provider: "atlascloud",
          model,
          operation: "video",
          subjectClass: AUTHORIZED,
        }).allowed,
      ).toBe(false);
    }
  });

  it("lets generated cast use any Atlas model and its asset library, but never a real person", () => {
    expect(
      resolveLikenessRouting({
        surface: "video",
        provider: "atlascloud",
        model: "bytedance/seedance-2.5/image-to-video",
        operation: "video",
        subjectClass: GENERATED,
      }).allowed,
    ).toBe(true);
    // The working generated-character asset path must keep working...
    expect(
      resolveLikenessRouting({
        surface: "video",
        provider: "atlascloud",
        model: "asset-library",
        operation: "asset_registration",
        subjectClass: GENERATED,
      }).allowed,
    ).toBe(true);
    // ...while a real person is still never registered there.
    const real = resolveLikenessRouting({
      surface: "video",
      provider: "atlascloud",
      model: "asset-library",
      operation: "asset_registration",
      subjectClass: REAL,
    });
    expect(real.allowed).toBe(false);
    expect(real).toMatchObject({
      reason: expect.stringContaining("never receive a real person's likeness"),
    });
  });

  it("surfaces BytePlus's own identity verification as a separate requirement", () => {
    const verdict = resolveLikenessRouting({
      surface: "video",
      provider: "byteplus",
      model: "asset-library",
      operation: "asset_registration",
      subjectClass: REAL,
    });
    expect(verdict).toEqual({ allowed: true, requiresVerifiedIdentity: true });
  });

  it("does not require provider verification for generated cast on BytePlus", () => {
    expect(
      resolveLikenessRouting({
        surface: "video",
        provider: "byteplus",
        model: "asset-library",
        operation: "asset_registration",
        subjectClass: GENERATED,
      }).allowed,
    ).toBe(true);
  });

  it("builds a stable recipient label", () => {
    expect(
      recipientScopeLabel({ operation: "outfit", providerLabel: "OpenAI", model: "gpt-image-1" }),
    ).toBe("outfit|OpenAI / gpt-image-1");
  });
});
