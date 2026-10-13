import type { GuidedStoryDraftState, GuidedStoryVideoCategory } from "@workspace/db";
import { resolveJobCompliance } from "../compliance";
import {
  freezeGuidedReferences,
  GuidedReferenceInputError,
  normalizeGuidedRequirements,
  normalizeReferenceHandle,
  unknownTopicHandles,
  type GuidedReferenceInput,
} from "./guidedReferences";

type Setup = NonNullable<GuidedStoryDraftState["setup"]>;

export class GuidedSetupExtrasError extends Error {}

const PROFESSION_LABEL: Record<"medical" | "chartered_accountant", string> = {
  medical: "Doctor (NMC)",
  chartered_accountant: "Chartered Accountant (ICAI)",
};

export interface GuidedSetupExtrasInput {
  category?: GuidedStoryVideoCategory;
  requirements?: {
    mustShow?: string[];
    mustSay?: string[];
    callToAction?: string | null;
    bannedWords?: string[];
  } | null;
  references?: GuidedReferenceInput[];
}

/**
 * Category, requirements and uploads for a saved setup. Omitted fields keep
 * the previous draft's values. Mutates and returns `setup`.
 *
 * Category: a Brand Kit (or workspace) that already resolves to a regulated
 * profession keeps it. Otherwise the user's answer decides; "general" means no
 * profession rules and no banned-words list.
 */
export async function resolveGuidedSetupExtras(params: {
  tenantId: number;
  setup: Setup;
  input: GuidedSetupExtrasInput;
  previous: Setup | null;
  deps?: {
    resolveCompliance?: typeof resolveJobCompliance;
    freezeReferences?: typeof freezeGuidedReferences;
  };
}): Promise<Setup> {
  const { setup, input, previous } = params;
  const base = await (params.deps?.resolveCompliance ?? resolveJobCompliance)(
    params.tenantId,
    setup.brandKitId,
  );
  let category: GuidedStoryVideoCategory;
  if (base) {
    if (input.category && input.category !== base.profession) {
      throw new GuidedSetupExtrasError(
        `This brand is set up as ${PROFESSION_LABEL[base.profession]}, so its videos always follow those advertising rules. To change that, edit the Brand Kit's Compliance tab.`,
      );
    }
    category = base.profession;
  } else {
    category = input.category ?? previous?.category ?? "general";
  }
  setup.category = category;

  const requirementsInput =
    input.requirements === undefined ? previous?.requirements ?? null : input.requirements;
  const requirements = normalizeGuidedRequirements(requirementsInput, category);
  if (requirements) setup.requirements = requirements;
  else delete setup.requirements;

  let references;
  try {
    references = await (params.deps?.freezeReferences ?? freezeGuidedReferences)({
      tenantId: params.tenantId,
      inputs: input.references,
      previous: previous?.references ?? null,
    });
  } catch (error) {
    if (error instanceof GuidedReferenceInputError) throw new GuidedSetupExtrasError(error.message);
    throw error;
  }
  if (references) setup.references = references;
  else delete setup.references;

  const unknown = unknownTopicHandles(setup.topic, references);
  if (unknown.length) {
    throw new GuidedSetupExtrasError(
      `The topic mentions ${unknown.map((handle) => `@${handle}`).join(", ")}, but no upload has that name. Upload it or rename the mention.`,
    );
  }
  const known = new Set(references?.items.map((item) => item.handle) ?? []);
  for (const item of requirements?.mustShow ?? []) {
    if (!item.startsWith("@")) continue;
    const handle = normalizeReferenceHandle(item);
    if (!handle || !known.has(handle)) {
      throw new GuidedSetupExtrasError(`"Must show" lists ${item}, but no upload has that name.`);
    }
  }
  return setup;
}
