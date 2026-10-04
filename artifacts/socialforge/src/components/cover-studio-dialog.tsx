import { useEffect, useMemo, useRef, useState } from "react";
import { useCreateCover, useDraftCoverCopy } from "@workspace/api-client-react";
import type { CoverRequestAccent, CoverRequestHeadlineStyle, CoverRequestPosition, CoverRequestTheme, CoverResult } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { Sparkles, Wand2, Info } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

export interface CoverApplyResult { imagePath: string; b64: string; layers: Record<string, unknown>; }
interface CoverStudioDialogProps {
  open: boolean; onOpenChange: (open: boolean) => void; imagePath: string; imageB64?: string | null;
  topic: string; brandKitId?: number; contentId?: number; onApply: (result: CoverApplyResult) => void;
}
interface LastRun {
  sourcePath: string; grade: boolean; position: CoverRequestPosition; result: CoverResult;
}
function Choice<T extends string>({ label, value, onChange, options, testId }: {
  label: string; value: T; onChange: (v: NoInfer<T>) => void; options: Array<{ value: NoInfer<T>; label: string }>; testId: string;
}) {
  return <div className="space-y-1.5">
    <Label className="text-xs text-muted-foreground">{label}</Label>
    <ToggleGroup type="single" value={value} onValueChange={(v) => v && onChange(v as T)}
      className="justify-start flex-wrap" data-testid={testId}>
      {options.map(o => <ToggleGroupItem key={o.value} value={o.value} size="sm" className="rounded-full px-3">{o.label}</ToggleGroupItem>)}
    </ToggleGroup>
  </div>;
}
export function CoverStudioDialog({ open, onOpenChange, imagePath, imageB64, topic, brandKitId, contentId, onApply }: CoverStudioDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createCover = useCreateCover();
  const draftCopy = useDraftCoverCopy();
  const [kicker, setKicker] = useState("");
  const [headline, setHeadline] = useState("");
  const [subline, setSubline] = useState("");
  const [behind, setBehind] = useState(true);
  const [grade, setGrade] = useState(true);
  const [position, setPosition] = useState<CoverRequestPosition>("top");
  const [headlineStyle, setHeadlineStyle] = useState<CoverRequestHeadlineStyle>("condensed");
  const [theme, setTheme] = useState<CoverRequestTheme>("auto");
  const [accent, setAccent] = useState<CoverRequestAccent>("sparkle");
  const [last, setLast] = useState<LastRun | null>(null);
  const sourceRef = useRef(imagePath);
  sourceRef.current = imagePath;
  const writingRef = useRef(false);
  const runningRef = useRef(false);
  const textRevision = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setLast(prev => prev && prev.sourcePath !== imagePath && prev.result.imagePath !== imagePath ? null : prev);
  }, [imagePath]);
  const draft = () => {
    if (writingRef.current) return;
    if (!topic.trim()) {
      toast({ title: "Add a brief first", description: "Cover text is written from your studio brief." }); return;
    }
    writingRef.current = true;
    const revision = textRevision.current, source = imagePath;
    draftCopy.mutate({ data: { topic: topic.trim(), brandKitId: brandKitId || undefined } }, {
      onSuccess: r => {
        if (!mounted.current || sourceRef.current !== source || textRevision.current !== revision) return;
        setKicker(r.kicker); setHeadline(r.headline); setSubline(r.subline);
        if (r.source === "fallback") toast({ title: "Drafted from your brief", description: "AI writing was unavailable; review this simple text draft." });
      },
      onError: err => {
        if (mounted.current && sourceRef.current === source)
          toast({ variant: "destructive", title: "Couldn't write cover text", description: apiErrorMessage(err, "Try again.") });
      },
      onSettled: () => { writingRef.current = false; },
    });
  };
  useEffect(() => {
    if (open && !headline && topic.trim() && !draftCopy.isPending) draft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const sameSource = !!last && (last.sourcePath === imagePath || last.result.imagePath === imagePath);
  const canReuse = useMemo(() => {
    if (!last || !sameSource || last.grade !== grade) return false;
    return behind ? last.result.subjectPath !== null : true;
  }, [last, sameSource, grade, behind]);
  const costsCredit = behind && !canReuse;
  const run = () => {
    if (runningRef.current) return;
    if (!headline.trim()) { toast({ title: "Add a headline", description: "One to three words reads best." }); return; }
    runningRef.current = true;
    const source = imagePath;
    const originalPath = sameSource && last ? last.sourcePath : imagePath;
    createCover.mutate({
      data: {
        ...(canReuse && last ? { reuse: { basePath: last.result.basePath, subjectPath: last.result.subjectPath } } : { imagePath: originalPath }),
        copy: { kicker, headline, subline }, layout: behind ? "behind" : "over",
        position, headlineStyle, theme, accent, grade: grade ? "editorial" : "none", contentId: contentId ?? null,
      },
    }, {
      onSuccess: result => {
        queryClient.invalidateQueries();
        if (!mounted.current || sourceRef.current !== source) return;
        setLast({ sourcePath: originalPath, grade, position, result });
        if (result.notice) toast({ title: "Heads up", description: result.notice });
      },
      onError: err => {
        if (mounted.current && sourceRef.current === source)
          toast({ variant: "destructive", title: "Couldn't create the cover", description: apiErrorMessage(err, "Try again.") });
      },
      onSettled: () => { runningRef.current = false; },
    });
  };
  const preview = sameSource && last ? `data:image/png;base64,${last.result.b64Json}` : null;
  const original = imageB64 ? `data:image/png;base64,${imageB64}` : `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/storage${imagePath}`;
  return <Dialog open={open} onOpenChange={v => { if (!createCover.isPending) onOpenChange(v); }}>
    <DialogContent className="max-w-4xl max-h-[90dvh] overflow-y-auto" data-testid="dialog-cover-studio">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4" /> Cover Studio</DialogTitle>
        <DialogDescription>Make it a magazine-style cover: a big headline behind the subject, an editorial colour grade, sized for Instagram (4:5).</DialogDescription>
      </DialogHeader>
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="relative mx-auto w-full max-w-[360px] aspect-[4/5] overflow-hidden rounded-xl border bg-muted">
          <img src={preview ?? original} alt={preview ? "Cover preview" : "Source photo"} className="h-full w-full object-cover" data-testid="img-cover-preview" />
          {createCover.isPending && <div className="absolute inset-0 grid place-items-center bg-background/60"><RippleSpinner className="h-8 w-8" /></div>}
        </div>
        <fieldset disabled={createCover.isPending} className="space-y-4 min-w-0">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Cover text</Label>
              <Button type="button" size="sm" variant="ghost" onClick={draft} disabled={draftCopy.isPending} data-testid="button-cover-draft">
                {draftCopy.isPending ? <RippleSpinner className="mr-2 h-4 w-4" /> : <Wand2 className="mr-2 h-4 w-4" />}Write it for me
              </Button>
            </div>
            <Input aria-label="Kicker" value={kicker} maxLength={24} onChange={e => { textRevision.current++; setKicker(e.target.value); }}
              placeholder="Small lead-in (e.g. My, The art of)" data-testid="input-cover-kicker" />
            <Input aria-label="Headline" value={headline} maxLength={28} onChange={e => { textRevision.current++; setHeadline(e.target.value); }}
              placeholder="Headline — 1 to 3 words" className="text-base font-semibold" data-testid="input-cover-headline" />
            <Input aria-label="Subline" value={subline} maxLength={48} onChange={e => { textRevision.current++; setSubline(e.target.value); }}
              placeholder="Subline (optional)" data-testid="input-cover-subline" />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div><Label htmlFor="cover-behind">Headline behind the person</Label>
              <p className="text-xs text-muted-foreground">{costsCredit ? "Uses one image-edit operation from your plan or credits." : "Free — no new cutout needed."}</p></div>
            <Switch id="cover-behind" checked={behind} onCheckedChange={setBehind} data-testid="switch-cover-behind" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Choice label="Position" value={position} onChange={setPosition} testId="toggle-cover-position"
              options={[{ value: "top", label: "Top" }, { value: "bottom", label: "Bottom" }]} />
            <Choice label="Headline style" value={headlineStyle} onChange={setHeadlineStyle} testId="toggle-cover-style"
              options={[{ value: "condensed", label: "Bold caps" }, { value: "grotesk", label: "Clean" }]} />
            <Choice label="Text colour" value={theme} onChange={setTheme} testId="toggle-cover-theme"
              options={[{ value: "auto", label: "Auto" }, { value: "light", label: "White" }, { value: "dark", label: "Ink" }]} />
            <Choice label="Accent" value={accent} onChange={setAccent} testId="toggle-cover-accent"
              options={[{ value: "sparkle", label: "✦" }, { value: "arrow", label: "Arrow" }, { value: "none", label: "None" }]} />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div><Label htmlFor="cover-grade">Editorial grade</Label><p className="text-xs text-muted-foreground">Muted film look with grain, so your grid matches.</p></div>
            <Switch id="cover-grade" checked={grade} onCheckedChange={setGrade} data-testid="switch-cover-grade" />
          </div>
          {last && last.grade !== grade && behind && <p className="text-xs text-muted-foreground">Changing the grade rebuilds from the original photo and uses a new cutout.</p>}
          <p className="flex gap-2 text-xs text-muted-foreground"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Avoid celebrities, film or TV characters and other brands' logos. For clinics: no cure claims, prices or before/after promises.</p>
        </fieldset>
      </div>
      <DialogFooter className="gap-2">
        <Button type="button" variant="secondary" onClick={run} disabled={createCover.isPending || !headline.trim()} data-testid="button-cover-create">
          {preview ? "Update cover" : "Create cover"}{costsCredit ? " · image operation" : ""}
        </Button>
        <Button type="button" disabled={!preview || createCover.isPending} onClick={() => {
          if (!last || !sameSource) return;
          onApply({ imagePath: last.result.imagePath, b64: last.result.b64Json, layers: last.result.layers as Record<string, unknown> });
          onOpenChange(false);
        }} data-testid="button-cover-apply">Use this cover</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}