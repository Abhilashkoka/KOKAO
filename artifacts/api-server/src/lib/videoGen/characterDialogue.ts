import { createHash } from "crypto";

export type CharacterDialogueLocale = {
  code: string;
  label: string;
  endonym: string;
  bcp47: string;
  direction: "ltr" | "rtl";
  modelId: "eleven_v3";
  script: string;
  fontCandidates: string[];
};

const locale = (
  code: string, label: string, endonym: string, bcp47: string, script = "Latin",
  direction: "ltr" | "rtl" = "ltr",
): CharacterDialogueLocale => ({
  code, label, endonym, bcp47, direction, modelId: "eleven_v3", script,
  fontCandidates:
    script === "Japanese" ? ["Noto Sans CJK JP", "Noto Sans JP"]
    : script === "Han" ? ["Noto Sans CJK SC", "Noto Sans SC"]
    : script === "Korean" ? ["Noto Sans CJK KR", "Noto Sans KR"]
    : script === "Latin" ? ["Noto Sans", "DejaVu Sans"]
    : script === "Arabic" ? ["Noto Sans Arabic", "Noto Naskh Arabic"]
    : script === "Hebrew" ? ["Noto Sans Hebrew", "Noto Serif Hebrew"]
    : [`Noto Sans ${script}`, `Noto Serif ${script}`],
});

/** Server-owned Eleven v3 language snapshot. Do not derive this from provider UI. */
export const ELEVEN_V3_LOCALES: readonly CharacterDialogueLocale[] = [
  locale("af","Afrikaans","Afrikaans","af-ZA"),locale("ar","Arabic","العربية","ar","Arabic","rtl"),
  locale("hy","Armenian","Հայերեն","hy-AM","Armenian"),locale("as","Assamese","অসমীয়া","as-IN","Bengali"),
  locale("az","Azerbaijani","Azərbaycanca","az-AZ"),locale("be","Belarusian","Беларуская","be-BY","Cyrillic"),
  locale("bn","Bengali","বাংলা","bn-BD","Bengali"),locale("bs","Bosnian","Bosanski","bs-BA"),
  locale("bg","Bulgarian","Български","bg-BG","Cyrillic"),locale("ca","Catalan","Català","ca-ES"),
  locale("ceb","Cebuano","Cebuano","ceb-PH"),locale("ny","Chichewa","Chichewa","ny-MW"),
  locale("hr","Croatian","Hrvatski","hr-HR"),locale("cs","Czech","Čeština","cs-CZ"),
  locale("da","Danish","Dansk","da-DK"),locale("nl","Dutch","Nederlands","nl-NL"),
  locale("en","English","English","en-US"),locale("et","Estonian","Eesti","et-EE"),
  locale("fil","Filipino","Filipino","fil-PH"),locale("fi","Finnish","Suomi","fi-FI"),
  locale("fr","French","Français","fr-FR"),locale("gl","Galician","Galego","gl-ES"),
  locale("ka","Georgian","ქართული","ka-GE","Georgian"),locale("de","German","Deutsch","de-DE"),
  locale("el","Greek","Ελληνικά","el-GR","Greek"),locale("gu","Gujarati","ગુજરાતી","gu-IN","Gujarati"),
  locale("ha","Hausa","Hausa","ha-NG"),locale("he","Hebrew","עברית","he-IL","Hebrew","rtl"),
  locale("hi","Hindi","हिन्दी","hi-IN","Devanagari"),locale("hu","Hungarian","Magyar","hu-HU"),
  locale("is","Icelandic","Íslenska","is-IS"),locale("id","Indonesian","Bahasa Indonesia","id-ID"),
  locale("ga","Irish","Gaeilge","ga-IE"),locale("it","Italian","Italiano","it-IT"),
  locale("ja","Japanese","日本語","ja-JP","Japanese"),locale("jv","Javanese","Basa Jawa","jv-ID"),
  locale("kn","Kannada","ಕನ್ನಡ","kn-IN","Kannada"),locale("kk","Kazakh","Қазақша","kk-KZ","Cyrillic"),
  locale("ky","Kyrgyz","Кыргызча","ky-KG","Cyrillic"),locale("ko","Korean","한국어","ko-KR","Korean"),
  locale("lv","Latvian","Latviešu","lv-LV"),locale("ln","Lingala","Lingála","ln-CD"),
  locale("lt","Lithuanian","Lietuvių","lt-LT"),locale("lb","Luxembourgish","Lëtzebuergesch","lb-LU"),
  locale("mk","Macedonian","Македонски","mk-MK","Cyrillic"),locale("ms","Malay","Bahasa Melayu","ms-MY"),
  locale("ml","Malayalam","മലയാളം","ml-IN","Malayalam"),locale("zh","Chinese","中文","zh-CN","Han"),
  locale("mr","Marathi","मराठी","mr-IN","Devanagari"),locale("ne","Nepali","नेपाली","ne-NP","Devanagari"),
  locale("no","Norwegian","Norsk","nb-NO"),locale("ps","Pashto","پښتو","ps-AF","Arabic","rtl"),
  locale("fa","Persian","فارسی","fa-IR","Arabic","rtl"),locale("pl","Polish","Polski","pl-PL"),
  locale("pt","Portuguese","Português","pt-BR"),locale("pa","Punjabi","ਪੰਜਾਬੀ","pa-IN","Gurmukhi"),
  locale("ro","Romanian","Română","ro-RO"),locale("ru","Russian","Русский","ru-RU","Cyrillic"),
  locale("sr","Serbian","Српски","sr-RS","Cyrillic"),locale("sd","Sindhi","سنڌي","sd-PK","Arabic","rtl"),
  locale("sk","Slovak","Slovenčina","sk-SK"),locale("sl","Slovenian","Slovenščina","sl-SI"),
  locale("so","Somali","Soomaali","so-SO"),locale("es","Spanish","Español","es-ES"),
  locale("sw","Swahili","Kiswahili","sw-KE"),locale("sv","Swedish","Svenska","sv-SE"),
  locale("ta","Tamil","தமிழ்","ta-IN","Tamil"),locale("te","Telugu","తెలుగు","te-IN","Telugu"),
  locale("th","Thai","ไทย","th-TH","Thai"),locale("tr","Turkish","Türkçe","tr-TR"),
  locale("uk","Ukrainian","Українська","uk-UA","Cyrillic"),locale("ur","Urdu","اردو","ur-PK","Arabic","rtl"),
  locale("vi","Vietnamese","Tiếng Việt","vi-VN"),locale("cy","Welsh","Cymraeg","cy-GB"),
] as const;

export function characterDialogueLocale(code: string): CharacterDialogueLocale | null {
  return ELEVEN_V3_LOCALES.find((item) => item.code === code) ?? null;
}

export interface CharacterDialogueScenePlan {
  id: string; text: string; visualPrompt: string; estimatedDurationSec: number;
}

/**
 * Sync Labs' lip-sync models infer a speaker's mouth style from the source
 * footage. A still or deliberately closed mouth can therefore stay closed even
 * when the audio is correct. Keep every generated source plate silent, but make
 * the face visibly perform natural talking motion for the lip-sync pass to
 * retarget.
 */
export function lipSyncSourcePlatePrompt(prompt: string): string {
  return (
    `${prompt.trim().replace(/[.;\s]+$/u, "")}; ` +
    "silent source plate with the person visibly talking naturally throughout, " +
    "clear varied mouth shapes, regular open-and-close lip motion, and a relaxed moving jaw; " +
    "no audible dialogue; exactly one unobstructed front-facing face remains large in frame throughout"
  );
}

const GRAPHEME_BUDGET = 80;
const WORD_BUDGET = 32;
const sentenceEnd = /[.!?。！？]/u;

function graphemes(text: string, locale: CharacterDialogueLocale): string[] {
  return [...new Intl.Segmenter(locale.bcp47, { granularity: "grapheme" }).segment(text)]
    .map((part) => part.segment);
}

function planGraphemeScenes(
  text: string, visualPrompt: string, locale: CharacterDialogueLocale,
): CharacterDialogueScenePlan[] {
  const parts = graphemes(text, locale);
  const scenes: CharacterDialogueScenePlan[] = [];
  for (let offset = 0; offset < parts.length;) {
    const limit = Math.min(parts.length, offset + GRAPHEME_BUDGET);
    let end = limit;
    // Prefer the latest local sentence ending, but never split a grapheme.
    for (let i = limit - 1; i > offset; i--) {
      if (sentenceEnd.test(parts[i]!)) {
        end = i + 1;
        break;
      }
    }
    scenes.push(makeScene(scenes.length, parts.slice(offset, end).join(""), visualPrompt, 30, locale, true));
    offset = end;
  }
  return scenes;
}

/** Locale-aware conservative segmentation that preserves approved text exactly. */
export function planCharacterDialogueScenes(
  text: string, visualPrompt: string, locale: CharacterDialogueLocale,
): CharacterDialogueScenePlan[] {
  const maxSeconds = 30;
  // Han, Japanese, and Thai do not offer reliable word whitespace. Oversized
  // tokens (URLs and unspaced text in any locale) use the same safe path.
  if (locale.script === "Han" || locale.script === "Japanese" || locale.script === "Thai"
    || (text.match(/\S+/gu) ?? []).some((token) => graphemes(token, locale).length > GRAPHEME_BUDGET)) {
    return planGraphemeScenes(text, visualPrompt, locale);
  }
  // Preserve initial whitespace separately; each token retains its following
  // whitespace, so joining all frozen scene text is byte-for-byte identical.
  const leading = text.match(/^\s*/u)?.[0] ?? "";
  const tokens = text.slice(leading.length).match(/\S+\s*/gu) ?? [];
  const scenes: CharacterDialogueScenePlan[] = [];
  let offset = 0;
  while (offset < tokens.length) {
    const limit = Math.min(tokens.length, offset + WORD_BUDGET);
    let end = limit;
    for (let i = limit - 1; i > offset; i--) {
      if (sentenceEnd.test(tokens[i]!)) {
        end = i + 1;
        break;
      }
    }
    const chunk = `${offset === 0 ? leading : ""}${tokens.slice(offset, end).join("")}`;
    scenes.push(makeScene(scenes.length, chunk, visualPrompt, maxSeconds, locale));
    offset = end;
  }
  return scenes;
}

function makeScene(
  index: number, text: string, visualPrompt: string, maxSeconds: number,
  locale: CharacterDialogueLocale, useGraphemeTiming = false,
): CharacterDialogueScenePlan {
  const words = text.match(/\S+/gu)?.length ?? 1;
  const graphemeCount = graphemes(text, locale).length;
  const directions = [
    "tight medium close-up, centered frontal eye contact, steady camera",
    "close-up frontal framing, face unobstructed, minimal head movement",
    "medium close-up, direct frontal pose, stable lighting, natural blinking only",
    "close-up centered one-face composition, locked camera, relaxed jaw",
  ] as const;
  return { id: `cd_${createHash("sha256").update(`${index}\0${text}`).digest("hex").slice(0, 16)}`,
    text,
    visualPrompt: lipSyncSourcePlatePrompt(
      `${visualPrompt}. Scene ${index + 1}: ${directions[index % directions.length]}`,
    ),
    estimatedDurationSec: Math.min(maxSeconds, Math.max(3, Math.ceil(
      (useGraphemeTiming || locale.script === "Han" || locale.script === "Japanese" || locale.script === "Thai"
        ? graphemeCount / 4
        : words / 1.6) + 0.7,
    ))) };
}