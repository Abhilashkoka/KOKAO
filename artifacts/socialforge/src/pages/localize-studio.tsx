import { useMemo, useState } from "react";
import { Download, Languages, Loader2, TriangleAlert } from "lucide-react";

import { useLocalizeScript } from "@workspace/api-client-react";
import type { LocalizeScriptResult, LocalizedTrack } from "@workspace/api-client-react";
import {
  LOCALE_POLICIES,
  TARGET_LOCALES,
  estimateEnglishSyllables,
  parseSubtitleFile,
  type SubtitleCue,
  type TargetLocale,
} from "@workspace/localization";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

/** Fallback total runtime, in seconds, when a pasted script has no timings. */
const DEFAULT_RUNTIME_SECONDS = 30;

type SourceMode = "paste" | "subtitle";

const REGISTER_OPTIONS = [
  {
    value: "conversational",
    label: "Conversational",
    description: "Natural, everyday language",
  },
  {
    value: "professional",
    label: "Professional",
    description: "Polished and business-ready",
  },
  {
    value: "formal",
    label: "Formal",
    description: "Respectful and official",
  },
  {
    value: "warm",
    label: "Warm",
    description: "Friendly and encouraging",
  },
  {
    value: "energetic",
    label: "Energetic",
    description: "Upbeat and motivating",
  },
  {
    value: "reassuring",
    label: "Reassuring",
    description: "Calm and supportive",
  },
  {
    value: "playful",
    label: "Playful",
    description: "Light and expressive",
  },
] as const;

type RegisterOption = (typeof REGISTER_OPTIONS)[number]["value"];

/**
 * Turn a pasted script into a timing spine.
 *
 * With no timecodes to work from, each line gets a share of the runtime
 * proportional to its syllable count — the same assumption the narration
 * pipeline makes, and close enough to find the lines that will not fit. A
 * real SRT is always better; this exists so a writer can sanity-check a draft
 * before the edit is locked.
 */
function spineFromPlainText(script: string, runtimeSeconds: number): SubtitleCue[] {
  const lines = script
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return [];

  const weights = lines.map((line) => Math.max(1, estimateEnglishSyllables(line)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const totalMs = Math.max(1000, Math.round(runtimeSeconds * 1000));

  let cursor = 0;
  return lines.map((line, i) => {
    const share = Math.round((weights[i]! / totalWeight) * totalMs);
    const startMs = cursor;
    // The last cue absorbs the rounding remainder so the track ends exactly on
    // the stated runtime rather than a few milliseconds short.
    const endMs = i === lines.length - 1 ? totalMs : startMs + share;
    cursor = endMs;
    return { index: i + 1, startMs, endMs, text: line };
  });
}

function downloadText(filename: string, contents: string): void {
  // Explicitly UTF-8 and without a byte-order mark: a BOM is the most common
  // reason a player renders the first cue as garbage.
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function TrackCard({ track }: { track: LocalizedTrack }) {
  const policy = LOCALE_POLICIES[track.locale as TargetLocale];
  const errorCount = track.cues.reduce(
    (sum, cue) =>
      sum +
      cue.issues.filter((issue) => issue.severity === "error").length +
      cue.cueIssues.filter((issue) => issue.severity === "error").length,
    0,
  );
  const warningCount = track.cues.reduce(
    (sum, cue) =>
      sum +
      cue.issues.filter((issue) => issue.severity === "warning").length +
      cue.cueIssues.filter((issue) => issue.severity === "warning").length,
    0,
  );

  return (
    <Card data-testid={`card-track-${track.locale}`}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            {track.label}
            <span className="text-muted-foreground font-normal">{policy?.endonym}</span>
          </CardTitle>
          <CardDescription>
            {errorCount > 0
              ? `${errorCount} line${errorCount === 1 ? "" : "s"} need a fix before this ships.`
              : warningCount > 0
                ? `Clean, with ${warningCount} thing${warningCount === 1 ? "" : "s"} worth a look.`
                : "Clean. Still get a native speaker to watch the render."}
          </CardDescription>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadText(`script.${track.locale}.srt`, track.srt)}
            data-testid={`button-download-srt-${track.locale}`}
          >
            <Download className="mr-2 h-4 w-4" /> SRT
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadText(`script.${track.locale}.vtt`, track.vtt)}
            data-testid={`button-download-vtt-${track.locale}`}
          >
            <Download className="mr-2 h-4 w-4" /> VTT
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {track.trackIssues.length > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            {track.trackIssues.map((issue, i) => (
              <p key={i} className="text-destructive">
                {issue.message}
              </p>
            ))}
          </div>
        )}

        {track.cues.map((cue) => {
          const overBudget = cue.syllables > cue.syllableBudget;
          const allIssues = [...cue.issues, ...cue.cueIssues];
          return (
            <div
              key={cue.index}
              className="grid gap-2 rounded-md border p-3 md:grid-cols-[4rem_1fr_1fr]"
              data-testid={`cue-${track.locale}-${cue.index}`}
            >
              <div className="text-muted-foreground text-xs tabular-nums">
                <div>{formatTimecode(cue.startMs)}</div>
                <div className={overBudget ? "text-destructive" : ""}>
                  {cue.syllables}/{cue.syllableBudget} syl
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-base leading-relaxed whitespace-pre-line">{cue.text}</p>
                {allIssues.length > 0 && (
                  <ul className="space-y-1">
                    {allIssues.map((issue, i) => (
                      <li
                        key={i}
                        className={`flex items-start gap-1.5 text-xs ${
                          issue.severity === "error" ? "text-destructive" : "text-muted-foreground"
                        }`}
                      >
                        <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>{issue.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="text-muted-foreground space-y-1 text-sm">
                <p className="text-xs uppercase tracking-wide">Back-translation</p>
                <p className="italic">{cue.backTranslation || "—"}</p>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/**
 * Script localization: turn a timed English script into Telugu, Tamil, or
 * Hindi that fits the same cut.
 *
 * The result is deliberately not presented as finished. Every line ships with
 * the syllable count against its budget, a blind back-translation, and any
 * mechanical problems found — because the thing that ruins a dub is not a bad
 * word choice, it is a line nobody checked against the picture.
 */
export function LocalizeStudioPage() {
  const { toast } = useToast();
  const localize = useLocalizeScript();

  const [sourceMode, setSourceMode] = useState<SourceMode>("paste");
  const [script, setScript] = useState("");
  const [subtitleText, setSubtitleText] = useState("");
  const [subtitleName, setSubtitleName] = useState("");
  const [runtime, setRuntime] = useState(String(DEFAULT_RUNTIME_SECONDS));
  const [locales, setLocales] = useState<TargetLocale[]>(["te", "ta", "hi"]);

  const [brandName, setBrandName] = useState("kokao");
  const [registerOptions, setRegisterOptions] = useState<RegisterOption[]>([]);
  const [customRegisterNote, setCustomRegisterNote] = useState("");
  const [stance, setStance] = useState<"peer" | "guide" | "authority">("peer");
  const [uiStrings, setUiStrings] = useState("");
  const [uiIsLocalized, setUiIsLocalized] = useState(false);
  const [childrenContent, setChildrenContent] = useState(false);

  const [result, setResult] = useState<LocalizeScriptResult | null>(null);

  const cues = useMemo<SubtitleCue[]>(() => {
    if (sourceMode === "subtitle") return parseSubtitleFile(subtitleText);
    const seconds = Number(runtime);
    return spineFromPlainText(script, Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_RUNTIME_SECONDS);
  }, [sourceMode, script, subtitleText, runtime]);

  const canGenerate = cues.length > 0 && locales.length > 0 && !localize.isPending;

  const toggleLocale = (locale: TargetLocale) => {
    setLocales((current) =>
      current.includes(locale) ? current.filter((l) => l !== locale) : [...current, locale],
    );
  };

  const toggleRegisterOption = (option: RegisterOption) => {
    setRegisterOptions((current) =>
      current.includes(option) ? current.filter((value) => value !== option) : [...current, option],
    );
  };

  const handleSubtitleFile = async (file: File) => {
    const text = await file.text();
    setSubtitleText(text);
    setSubtitleName(file.name);
  };

  const handleGenerate = () => {
    localize.mutate(
      {
        data: {
          cues: cues.map((cue) => ({
            index: cue.index,
            startMs: cue.startMs,
            endMs: cue.endMs,
            text: cue.text.replace(/\n/g, " "),
          })),
          locales,
          childrenContent,
          voiceProfile: {
            brandName: brandName.trim() || undefined,
            register: [
              ...REGISTER_OPTIONS.filter((option) => registerOptions.includes(option.value)).map(
                (option) => option.label,
              ),
              customRegisterNote.trim(),
            ]
              .filter(Boolean)
              .join(". ") || undefined,
            stance,
            uiStrings: uiStrings
              .split(/[\n,]/)
              .map((s) => s.trim())
              .filter(Boolean),
            uiIsLocalized,
          },
        },
      },
      {
        onSuccess: (data) => {
          setResult(data);
          const blocked = data.tracks.filter((track) => track.blocked).length;
          toast({
            title: `Localized into ${data.tracks.length} language${data.tracks.length === 1 ? "" : "s"}`,
            description:
              blocked > 0
                ? `${blocked} track${blocked === 1 ? " needs" : "s need"} a fix before shipping.`
                : "Review the back-translations before you record.",
          });
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Could not localize this script",
            description: apiErrorMessage(err, "Please try again."),
          });
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Script</CardTitle>
          <CardDescription>
            An SRT keeps the real timings, which is what the syllable budget is measured against.
            Pasting plain text estimates them from the runtime — good enough to draft with, not to
            record against.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={sourceMode} onValueChange={(value) => setSourceMode(value as SourceMode)}>
            <TabsList data-testid="localize-source-tabs">
              <TabsTrigger value="paste" data-testid="tab-localize-paste">
                Paste script
              </TabsTrigger>
              <TabsTrigger value="subtitle" data-testid="tab-localize-subtitle">
                Upload SRT / VTT
              </TabsTrigger>
            </TabsList>

            <TabsContent value="paste" className="mt-4 space-y-3">
              <Textarea
                value={script}
                onChange={(event) => setScript(event.target.value)}
                placeholder={"One line per cue.\nEverything you need, in one place."}
                rows={8}
                data-testid="input-localize-script"
              />
              <div className="flex items-center gap-2">
                <Label htmlFor="localize-runtime" className="shrink-0">
                  Total runtime
                </Label>
                <Input
                  id="localize-runtime"
                  type="number"
                  min={1}
                  value={runtime}
                  onChange={(event) => setRuntime(event.target.value)}
                  className="w-24"
                  data-testid="input-localize-runtime"
                />
                <span className="text-muted-foreground text-sm">seconds</span>
              </div>
            </TabsContent>

            <TabsContent value="subtitle" className="mt-4 space-y-3">
              <Input
                type="file"
                accept=".srt,.vtt,text/plain"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleSubtitleFile(file);
                }}
                data-testid="input-localize-subtitle-file"
              />
              {subtitleName && (
                <p className="text-muted-foreground text-sm">
                  {subtitleName} — {cues.length} cue{cues.length === 1 ? "" : "s"}
                </p>
              )}
            </TabsContent>
          </Tabs>

          <p className="text-muted-foreground text-sm" data-testid="text-localize-cue-count">
            {cues.length} line{cues.length === 1 ? "" : "s"} on the timing spine.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Languages</CardTitle>
          <CardDescription>One caption credit per language.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-4">
            {TARGET_LOCALES.map((locale) => (
              <label key={locale} className="flex items-center gap-2">
                <Checkbox
                  checked={locales.includes(locale)}
                  onCheckedChange={() => toggleLocale(locale)}
                  data-testid={`checkbox-locale-${locale}`}
                />
                <span>{LOCALE_POLICIES[locale].label}</span>
                <span className="text-muted-foreground">{LOCALE_POLICIES[locale].endonym}</span>
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={childrenContent}
              onCheckedChange={setChildrenContent}
              data-testid="switch-children-content"
            />
            <Label>Children&rsquo;s content (18 characters per second instead of 22)</Label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Brand voice</CardTitle>
          <CardDescription>
            What has to survive into every language. The words change; these do not.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="localize-brand">Brand name</Label>
            <Input
              id="localize-brand"
              value={brandName}
              onChange={(event) => setBrandName(event.target.value)}
              data-testid="input-localize-brand"
            />
            <p className="text-muted-foreground text-xs">
              Never translated and never transliterated — that would fragment the brand and break
              store search.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="localize-stance">Speaks as a</Label>
            <Select value={stance} onValueChange={(value) => setStance(value as typeof stance)}>
              <SelectTrigger id="localize-stance" data-testid="select-localize-stance">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="peer">Peer</SelectItem>
                <SelectItem value="guide">Guide</SelectItem>
                <SelectItem value="authority">Authority</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2 md:col-span-2">
            <Label>Tone &amp; style</Label>
            <p className="text-muted-foreground text-xs">
              Select one or more that match this script. We use these choices to make the
              translation sound right for its audience.
            </p>
            <div className="flex flex-wrap gap-2" aria-label="Tone and style choices">
              {REGISTER_OPTIONS.map((option) => {
                const selected = registerOptions.includes(option.value);
                return (
                  <Button
                    key={option.value}
                    type="button"
                    variant={selected ? "default" : "outline"}
                    size="sm"
                    aria-pressed={selected}
                    onClick={() => toggleRegisterOption(option.value)}
                    data-testid={`button-register-${option.value}`}
                    className="h-auto min-h-10 px-3 py-2 text-left"
                  >
                    <span className="flex flex-col items-start">
                      <span>{option.label}</span>
                      <span
                        className={
                          selected ? "text-primary-foreground/75 text-xs" : "text-muted-foreground text-xs"
                        }
                      >
                        {option.description}
                      </span>
                    </span>
                  </Button>
                );
              })}
            </div>
            <Input
              id="localize-register"
              value={customRegisterNote}
              onChange={(event) => setCustomRegisterNote(event.target.value)}
              placeholder="Optional: add any other tone direction, such as “short and direct.”"
              data-testid="input-localize-register-note"
            />
          </div>

          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="localize-ui-strings">Interface labels</Label>
            <Textarea
              id="localize-ui-strings"
              value={uiStrings}
              onChange={(event) => setUiStrings(event.target.value)}
              placeholder="Continue, Get started, Share"
              rows={2}
              data-testid="input-localize-ui-strings"
            />
            <div className="flex items-center gap-2">
              <Switch
                checked={uiIsLocalized}
                onCheckedChange={setUiIsLocalized}
                data-testid="switch-ui-localized"
              />
              <Label>The app&rsquo;s own interface is already in these languages</Label>
            </div>
            <p className="text-muted-foreground text-xs">
              While the app is English-only, the narration has to say these labels in English — or
              the viewer hunts for a button that does not exist.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={handleGenerate} disabled={!canGenerate} data-testid="button-localize">
          {localize.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Languages className="mr-2 h-4 w-4" />
          )}
          Localize script
        </Button>
        {cues.length === 0 && (
          <span className="text-muted-foreground text-sm">Add a script to get started.</span>
        )}
      </div>

      {result && (
        <div className="space-y-4">
          {result.tracks.map((track) => (
            <TrackCard key={track.locale} track={track} />
          ))}
          <p className="text-muted-foreground text-sm">
            Before you sign this off: read the back-translations for meaning drift, and have a
            native speaker watch the <em>render</em> rather than the script. Clipped glyphs and
            awkward stresses only exist in the video.
          </p>
          {result.tracks.some((track) => track.blocked) && (
            <Badge variant="destructive" data-testid="badge-localize-blocked">
              Some tracks have blocking issues
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}

export default LocalizeStudioPage;
