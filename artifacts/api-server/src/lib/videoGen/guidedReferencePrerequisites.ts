/**
 * Stable route/worker entry point for the immutable Guided Story reference
 * preflight. The implementation lives beside the rest of the Guided Story
 * snapshot predicates so every caller shares exactly the same pure check.
 */
export {
  guidedStoryReferencePreflightError as guidedStoryboardReferenceError,
} from "./guidedStory";