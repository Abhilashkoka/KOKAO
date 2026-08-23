import { useState } from "react";
import {
  getListAdminVideoTemplatesQueryKey,
  useCreateAdminVideoTemplate,
  useDeleteAdminVideoTemplate,
  useListAdminVideoTemplates,
  type VideoStyleProfile,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Film, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

type AspectRatio = "9:16" | "16:9" | "1:1";
type CaptionStyle = "classic" | "dynamic";
type VisualsSource = "stock" | "ai" | "ai_video" | "character";
type StockSource = "auto" | "pexels" | "pixabay" | "wikimedia";

const PRESENTER_SLOT = {
  kind: "presenter_video" as const,
  required: true,
  label: "A take of you talking to camera",
  hint:
    "60–90 seconds, one continuous take, head and shoulders in the lower two-thirds of frame so the overlay has room above you.",
};

const CHARACTER_SLOT = {
  kind: "character" as const,
  required: true,
  label: "A saved character",
  hint: "Choose the character who should appear in the generated scenes.",
};

/**
 * Superadmins create published formats here. Deliberately no edit action:
 * changing a selected format under customers is surprising, while create +
 * delete makes each format's defaults immutable.
 */
export function VideoTemplatesTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: templates, isLoading } = useListAdminVideoTemplates();
  const createTemplate = useCreateAdminVideoTemplate();
  const deleteTemplate = useDeleteAdminVideoTemplate();

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<VideoStyleProfile | null>(null);
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>("dynamic");
  const [visualsSource, setVisualsSource] = useState<VisualsSource>("stock");
  const [stockSource, setStockSource] = useState<StockSource>("auto");
  const [shotCount, setShotCount] = useState("3");
  const [paragraphCount, setParagraphCount] = useState("1");
  const [subtitles, setSubtitles] = useState(true);
  const [requiresPresenter, setRequiresPresenter] = useState(false);

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: getListAdminVideoTemplatesQueryKey(),
    });

  const resetForm = () => {
    setName("");
    setSummary("");
    setAspectRatio("9:16");
    setCaptionStyle("dynamic");
    setVisualsSource("stock");
    setStockSource("auto");
    setShotCount("3");
    setParagraphCount("1");
    setSubtitles(true);
    setRequiresPresenter(false);
  };

  const openCreate = () => {
    resetForm();
    setCreateOpen(true);
  };

  const submitCreate = () => {
    const parsedShotCount = Number(shotCount);
    const parsedParagraphCount = Number(paragraphCount);
    if (!name.trim()) {
      toast({
        variant: "destructive",
        title: "Name the template",
        description: "Give this KOKAO format a clear name.",
      });
      return;
    }
    if (
      !Number.isInteger(parsedShotCount) ||
      parsedShotCount < 1 ||
      parsedShotCount > 10 ||
      !Number.isInteger(parsedParagraphCount) ||
      parsedParagraphCount < 1 ||
      parsedParagraphCount > 3
    ) {
      toast({
        variant: "destructive",
        title: "Check the format defaults",
        description: "Use 1–10 shots and 1–3 script paragraphs.",
      });
      return;
    }

    createTemplate.mutate(
      {
        data: {
          name: name.trim(),
          summary: summary.trim() || null,
          slots: [
            ...(requiresPresenter ? [PRESENTER_SLOT] : []),
            ...(visualsSource === "character" ? [CHARACTER_SLOT] : []),
          ],
          jobDefaults: {
            aspectRatio,
            captionStyle,
            visualsSource,
            stockSource,
            shotCount: parsedShotCount,
            paragraphCount: parsedParagraphCount,
            subtitles,
          },
        },
      },
      {
        onSuccess: () => {
          refresh();
          setCreateOpen(false);
          toast({
            title: "Template published",
            description: "It is now available in Video Studio for every workspace.",
          });
        },
        onError: (error) =>
          toast({
            variant: "destructive",
            title: "Could not create template",
            description: apiErrorMessage(error, "Please try again."),
          }),
      },
    );
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    deleteTemplate.mutate(
      { templateId: deleteTarget.id },
      {
        onSuccess: () => {
          refresh();
          toast({ title: "Template deleted" });
          setDeleteTarget(null);
        },
        onError: (error) =>
          toast({
            variant: "destructive",
            title: "Could not delete template",
            description: apiErrorMessage(error, "Please try again."),
          }),
      },
    );
  };

  return (
    <div className="space-y-6" data-testid="admin-video-templates">
      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Film className="h-5 w-5" />
              Video templates
            </CardTitle>
            <CardDescription className="mt-1">
              Platform-wide KOKAO formats. New templates are published immediately; replace a
              format rather than changing it after customers select it.
            </CardDescription>
          </div>
          <Button onClick={openCreate} data-testid="create-video-template">
            <Plus className="mr-2 h-4 w-4" />
            Add template
          </Button>
        </CardHeader>
      </Card>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : templates?.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          {templates.map((template) => (
            <Card key={template.id} data-testid={`video-template-${template.id}`}>
              <CardHeader className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-lg">{template.name}</CardTitle>
                    {template.summary ? (
                      <CardDescription className="mt-1">{template.summary}</CardDescription>
                    ) : null}
                  </div>
                  <Badge>Published</Badge>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge variant="secondary">{template.estimatedUnits} unit{template.estimatedUnits === 1 ? "" : "s"}</Badge>
                  {template.slots.map((slot) => (
                    <Badge key={`${template.id}-${slot.kind}`} variant="outline">
                      {slot.required ? "Requires " : "Optional "}
                      {slot.label}
                    </Badge>
                  ))}
                </div>
              </CardHeader>
              <CardContent className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setDeleteTarget(template)}
                  data-testid={`delete-video-template-${template.id}`}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="py-10 text-center">
            <Film className="mx-auto h-8 w-8 text-muted-foreground" />
            <h2 className="mt-3 font-semibold">No video templates yet</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Add the first KOKAO format to make it available in Video Studio.
            </p>
          </CardContent>
        </Card>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add video template</DialogTitle>
            <DialogDescription>
              This publishes a reusable format, never a workspace’s footage, brand kit, or
              other private assets.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-5 py-2">
            <div className="grid gap-2">
              <Label htmlFor="video-template-name">Name</Label>
              <Input
                id="video-template-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                placeholder="e.g. Quick B-roll explainer"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="video-template-summary">What does this format do?</Label>
              <Textarea
                id="video-template-summary"
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                maxLength={240}
                placeholder="A short, practical description shown to customers."
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>Aspect ratio</Label>
                <Select value={aspectRatio} onValueChange={(value) => setAspectRatio(value as AspectRatio)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="9:16">Vertical (9:16)</SelectItem>
                    <SelectItem value="16:9">Landscape (16:9)</SelectItem>
                    <SelectItem value="1:1">Square (1:1)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Caption treatment</Label>
                <Select value={captionStyle} onValueChange={(value) => setCaptionStyle(value as CaptionStyle)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dynamic">Dynamic</SelectItem>
                    <SelectItem value="classic">Classic</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Visuals</Label>
                <Select value={visualsSource} onValueChange={(value) => setVisualsSource(value as VisualsSource)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stock">Stock footage</SelectItem>
                    <SelectItem value="ai">AI images</SelectItem>
                    <SelectItem value="ai_video">Animated AI B-roll</SelectItem>
                    <SelectItem value="character">Saved character</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Stock source</Label>
                <Select value={stockSource} onValueChange={(value) => setStockSource(value as StockSource)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Automatic</SelectItem>
                    <SelectItem value="pexels">Pexels</SelectItem>
                    <SelectItem value="pixabay">Pixabay</SelectItem>
                    <SelectItem value="wikimedia">Wikimedia</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="video-template-shots">Shot count</Label>
                <Input
                  id="video-template-shots"
                  type="number"
                  min={1}
                  max={10}
                  value={shotCount}
                  onChange={(event) => setShotCount(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="video-template-paragraphs">Script paragraphs</Label>
                <Input
                  id="video-template-paragraphs"
                  type="number"
                  min={1}
                  max={3}
                  value={paragraphCount}
                  onChange={(event) => setParagraphCount(event.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="video-template-subtitles">Burn in subtitles</Label>
                <p className="text-xs text-muted-foreground">Make captions part of every output.</p>
              </div>
              <Switch id="video-template-subtitles" checked={subtitles} onCheckedChange={setSubtitles} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="video-template-presenter">Requires a presenter recording</Label>
                <p className="text-xs text-muted-foreground">
                  Shows the framing requirement before a customer chooses this format.
                </p>
              </div>
              <Switch
                id="video-template-presenter"
                checked={requiresPresenter}
                onCheckedChange={setRequiresPresenter}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={submitCreate} disabled={createTemplate.isPending}>
              {createTemplate.isPending ? "Publishing…" : "Publish template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this template?</DialogTitle>
            <DialogDescription>
              {deleteTarget ? `"${deleteTarget.name}" will disappear from Video Studio for every workspace.` : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleteTemplate.isPending}
            >
              {deleteTemplate.isPending ? "Deleting…" : "Delete template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}