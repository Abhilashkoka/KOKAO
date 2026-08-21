/**
 * Shared localization rules for the KOKAO video pipeline.
 *
 * Everything here is pure and dependency-free so the web app, the mobile app
 * and the API server all validate a transcreated line the same way. The server
 * uses it to build prompts and gate a render; the web app uses it to warn a
 * writer while they are still typing.
 */

export {
  TARGET_LOCALES,
  SOURCE_LOCALES,
  LOCALE_POLICIES,
  SCRIPT_RANGES,
  isTargetLocale,
  localePolicy,
  type TargetLocale,
  type SourceLocale,
  type IndicScript,
  type MixTolerance,
  type AvoidedTerm,
  type LocalePolicy,
} from "./locales";

export {
  estimateEnglishSyllables,
  estimateIndicSyllables,
  estimateSyllables,
  syllableBudget,
  syllablesPerSecond,
} from "./syllables";

export {
  SUBTITLE_LIMITS,
  cueCharCount,
  cueDurationMs,
  charsPerSecond,
  validateCue,
  validateCues,
  wrapCueText,
  formatSrtTime,
  formatVttTime,
  toSrt,
  toVtt,
  parseSubtitleFile,
  type SubtitleCue,
  type CueIssue,
  type CueIssueCode,
  type ValidateCueOptions,
} from "./subtitles";

export {
  COMMON_ENGLISH_TERMS,
  DEFAULT_VOICE_PROFILE,
  untranslatableTerms,
  describeVoiceProfile,
  type BrandVoiceProfile,
  type VoiceStance,
} from "./voiceProfile";

export {
  lintLocalizedText,
  lintUntranslatables,
  hasBlockingIssue,
  type LocalizationIssue,
  type LocalizationIssueCode,
  type LintOptions,
} from "./lint";
