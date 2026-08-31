import type { VideoGeneration } from "@workspace/db";
import { recordServerEvent } from "../analytics";

type FundingRail = "quota" | "credit" | "wallet";

export type StudioLipSyncOutcome =
  | "enabled"
  | "disabled"
  | "accepted"
  | "eligible"
  | "ineligible"
  | "succeeded"
  | "failed"
  | "recovered";

export function studioLipSyncSceneCountBucket(count: number): string {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 3) return "2_3";
  if (count <= 6) return "4_6";
  return "7_plus";
}

export function studioLipSyncWorkflow(
  job: Pick<VideoGeneration, "engine" | "options">,
): string {
  if (job.options?.guidedStory) return "guided_story";
  if (job.engine === "topic_to_video") return "topic_character";
  if (job.engine === "text_to_video") return "text_to_video";
  if (job.engine === "image_to_video") return "animate_photo";
  return "other";
}

export function recordStudioLipSyncEvent(args: {
  name: string;
  tenantId: number;
  workflow: string;
  fundingRail: FundingRail;
  sceneCount: number;
  outcome: StudioLipSyncOutcome;
}): void {
  void recordServerEvent({
    name: args.name,
    tenantId: args.tenantId,
    params: {
      workflow: args.workflow,
      funding_rail: args.fundingRail,
      scene_count_bucket: studioLipSyncSceneCountBucket(args.sceneCount),
      outcome: args.outcome,
    },
  });
}