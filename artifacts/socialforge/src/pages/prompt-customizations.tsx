import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListUserPromptCases,
  useListPromptCustomizations,
  useCreatePromptCustomization,
  useUpdatePromptCustomization,
  usePreviewPromptCustomization,
  getListPromptCustomizationsQueryKey,
  PromptCustomizationStatus,
  type UserPromptCase,
  type PromptCustomization,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import {
  Sparkles,
  Plus,
  MoreVertical,
  Pencil,
  Archive,
  RotateCcw,
  Eye,
  CheckCircle2,
} from "lucide-react";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * The customization auto-applied during generation is the MOST RECENT ACTIVE
 * one for a case. Sort active variants newest-first and pick the head.
 */
function appliedCustomizationId(
  customizations: PromptCustomization[],
): number | null {
  const active = customizations
    .filter((c) => c.status === PromptCustomizationStatus.active)
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  return active.length > 0 ? active[0].id : null;
}

type EditorState = {
  caseType: UserPromptCase;
  customization: PromptCustomization | null;
};

export function PromptCustomizationsPage() {
  const {
    data: cases,
    isLoading: casesLoading,
    error: casesError,
  } = useListUserPromptCases();
  const {
    data: customizations,
    isLoading: customizationsLoading,
  } = useListPromptCustomizations();
  const createCustomization = useCreatePromptCustomization();
  const updateCustomization = useUpdatePromptCustomization();
  const previewCustomization = usePreviewPromptCustomization();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getListPromptCustomizationsQueryKey(),
    });

  // Group the caller's customizations by case type.
  const byCaseType = useMemo(() => {
    const map = new Map<number, PromptCustomization[]>();
    for (const c of customizations ?? []) {
      const list = map.get(c.caseTypeId) ?? [];
      list.push(c);
      map.set(c.caseTypeId, list);
    }
    return map;
  }, [customizations]);

  // --- Editor dialog state ---
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [saving, setSaving] = useState(false);

  const openCreate = (caseType: UserPromptCase) => {
    setEditor({ caseType, customization: null });
    setTitle("");
    setInstruction("");
  };

  const openEdit = (caseType: UserPromptCase, customization: PromptCustomization) => {
    setEditor({ caseType, customization });
    setTitle(customization.title);
    setInstruction(customization.instructionBlock);
  };

  const closeEditor = () => {
    if (saving) return;
    setEditor(null);
  };

  const handleSave = async () => {
    if (!editor) return;
    const trimmedTitle = title.trim();
    const trimmedInstruction = instruction.trim();
    if (!trimmedTitle || !trimmedInstruction) return;
    setSaving(true);
    try {
      if (editor.customization) {
        await updateCustomization.mutateAsync({
          customizationId: editor.customization.id,
          data: { title: trimmedTitle, instructionBlock: trimmedInstruction },
        });
        toast({ title: "Style updated" });
      } else {
        await createCustomization.mutateAsync({
          data: {
            caseTypeId: editor.caseType.id,
            title: trimmedTitle,
            instructionBlock: trimmedInstruction,
          },
        });
        toast({
          title: "Style created",
          description:
            "This is now your newest active style and will be applied automatically.",
        });
      }
      await invalidate();
      setEditor(null);
    } catch (err) {
      toast({
        title: "Could not save style",
        description: apiErrorMessage(err, "Please try again."),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (
    customization: PromptCustomization,
    status: (typeof PromptCustomizationStatus)[keyof typeof PromptCustomizationStatus],
  ) => {
    try {
      await updateCustomization.mutateAsync({
        customizationId: customization.id,
        data: { status },
      });
      await invalidate();
      toast({
        title:
          status === PromptCustomizationStatus.archived
            ? "Style archived"
            : "Style reactivated",
        description:
          status === PromptCustomizationStatus.active
            ? "It's now your newest active style and will be applied automatically."
            : undefined,
      });
    } catch (err) {
      toast({
        title: "Could not update style",
        description: apiErrorMessage(err, "Please try again."),
        variant: "destructive",
      });
    }
  };

  // --- Preview dialog state ---
  const [previewCase, setPreviewCase] = useState<UserPromptCase | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [previewResult, setPreviewResult] = useState<string | null>(null);
  const [previewMissing, setPreviewMissing] = useState<string[]>([]);

  const openPreview = (caseType: UserPromptCase, seedInstruction: string) => {
    setPreviewCase(caseType);
    setPreviewText(seedInstruction);
    setPreviewResult(null);
    setPreviewMissing([]);
  };

  const closePreview = () => {
    if (previewCustomization.isPending) return;
    setPreviewCase(null);
  };

  const runPreview = async () => {
    if (!previewCase) return;
    try {
      const result = await previewCustomization.mutateAsync({
        data: {
          caseTypeId: previewCase.id,
          instructionBlock: previewText.trim() || null,
        },
      });
      setPreviewResult(result.preview);
      setPreviewMissing(result.missingPlaceholders ?? []);
    } catch (err) {
      toast({
        title: "Could not build preview",
        description: apiErrorMessage(err, "Please try again."),
        variant: "destructive",
      });
    }
  };

  if (casesLoading || customizationsLoading) {
    return (
      <div className="space-y-6" data-testid="page-ai-styles-loading">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="page-ai-styles">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">AI Styles</h1>
          <p className="text-sm text-muted-foreground">
            Add your personal style on top of the built-in AI prompts for each
            kind of content you generate.
          </p>
        </div>
      </div>

      {casesError ? (
        <Alert variant="destructive" data-testid="alert-ai-styles-error">
          <AlertTitle>Could not load AI styles</AlertTitle>
          <AlertDescription>
            {apiErrorMessage(casesError, "Please refresh and try again.")}
          </AlertDescription>
        </Alert>
      ) : (cases ?? []).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="rounded-full bg-muted p-4 mb-4">
              <Sparkles className="h-8 w-8 text-muted-foreground" />
            </div>
            <h2 className="text-lg font-semibold">No AI styles available yet</h2>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              There are no content flows to customize right now. Check back
              later.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {(cases ?? []).map((caseType) => {
            const list = byCaseType.get(caseType.id) ?? [];
            const visible = list
              .filter((c) => c.status !== PromptCustomizationStatus.archived)
              .concat(
                list.filter(
                  (c) => c.status === PromptCustomizationStatus.archived,
                ),
              );
            const appliedId = appliedCustomizationId(list);

            return (
              <Card
                key={caseType.id}
                data-testid={`card-case-${caseType.slug}`}
              >
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <CardTitle>{caseType.name}</CardTitle>
                        {caseType.hasLiveTemplate ? (
                          <Badge
                            variant="secondary"
                            data-testid={`badge-live-template-${caseType.slug}`}
                          >
                            Managed template
                          </Badge>
                        ) : null}
                      </div>
                      {caseType.description ? (
                        <CardDescription>
                          {caseType.description}
                        </CardDescription>
                      ) : null}
                      {caseType.adminSummary ? (
                        <p className="text-xs text-muted-foreground">
                          {caseType.adminSummary}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openPreview(caseType, "")}
                        data-testid={`button-preview-case-${caseType.slug}`}
                      >
                        <Eye className="h-4 w-4 mr-1.5" />
                        Preview
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => openCreate(caseType)}
                        data-testid={`button-new-style-${caseType.slug}`}
                      >
                        <Plus className="h-4 w-4 mr-1.5" />
                        New style
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Your newest active style is applied automatically when you
                    generate content. Archive it to stop using it.
                  </p>

                  {visible.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No styles yet. Create one to shape how this content is
                      generated for you.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {visible.map((customization) => {
                        const isApplied = customization.id === appliedId;
                        const isArchived =
                          customization.status ===
                          PromptCustomizationStatus.archived;
                        return (
                          <div
                            key={customization.id}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                            data-testid={`row-customization-${customization.id}`}
                          >
                            <div className="min-w-0 space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium truncate">
                                  {customization.title}
                                </span>
                                {isApplied ? (
                                  <Badge
                                    data-testid={`badge-applied-${customization.id}`}
                                  >
                                    <CheckCircle2 className="h-3 w-3 mr-1" />
                                    Applied
                                  </Badge>
                                ) : null}
                                <Badge
                                  variant="outline"
                                  className="capitalize"
                                  data-testid={`badge-status-${customization.id}`}
                                >
                                  {isArchived ? "archived" : "active"}
                                </Badge>
                              </div>
                              <p className="text-xs text-muted-foreground">
                                Updated {formatDate(customization.updatedAt)}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  openPreview(
                                    caseType,
                                    customization.instructionBlock,
                                  )
                                }
                                data-testid={`button-preview-customization-${customization.id}`}
                              >
                                <Eye className="h-4 w-4" />
                              </Button>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    data-testid={`button-menu-${customization.id}`}
                                  >
                                    <MoreVertical className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    onClick={() =>
                                      openEdit(caseType, customization)
                                    }
                                    data-testid={`menu-edit-${customization.id}`}
                                  >
                                    <Pencil className="h-4 w-4 mr-2" />
                                    Edit
                                  </DropdownMenuItem>
                                  {isArchived ? (
                                    <DropdownMenuItem
                                      onClick={() =>
                                        handleStatusChange(
                                          customization,
                                          PromptCustomizationStatus.active,
                                        )
                                      }
                                      data-testid={`menu-reactivate-${customization.id}`}
                                    >
                                      <RotateCcw className="h-4 w-4 mr-2" />
                                      Reactivate
                                    </DropdownMenuItem>
                                  ) : (
                                    <DropdownMenuItem
                                      onClick={() =>
                                        handleStatusChange(
                                          customization,
                                          PromptCustomizationStatus.archived,
                                        )
                                      }
                                      data-testid={`menu-archive-${customization.id}`}
                                    >
                                      <Archive className="h-4 w-4 mr-2" />
                                      Archive
                                    </DropdownMenuItem>
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
      >
        <DialogContent data-testid="dialog-style-editor">
          <DialogHeader>
            <DialogTitle>
              {editor?.customization ? "Edit style" : "New style"}
            </DialogTitle>
            <DialogDescription>
              {editor
                ? `Your personal amendment for ${editor.caseType.name}.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="style-title">Name</Label>
              <Input
                id="style-title"
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Playful and punchy"
                data-testid="input-style-title"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="style-instruction">Style instructions</Label>
              <Textarea
                id="style-instruction"
                value={instruction}
                maxLength={4000}
                rows={7}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="Describe the tone, wording, or details the AI should always apply for this content."
                data-testid="textarea-style-instruction"
              />
              <p className="text-xs text-muted-foreground">
                This is layered on top of the built-in prompt when you generate
                content.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeEditor}
              disabled={saving}
              data-testid="button-cancel-style"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !title.trim() || !instruction.trim()}
              data-testid="button-save-style"
            >
              {saving ? "Saving..." : "Save style"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview dialog */}
      <Dialog
        open={previewCase !== null}
        onOpenChange={(open) => {
          if (!open) closePreview();
        }}
      >
        <DialogContent data-testid="dialog-style-preview">
          <DialogHeader>
            <DialogTitle>Preview applied style</DialogTitle>
            <DialogDescription>
              {previewCase
                ? `See how your style layers onto the ${previewCase.name} prompt.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="preview-instruction">Your amendment</Label>
              <Textarea
                id="preview-instruction"
                value={previewText}
                maxLength={4000}
                rows={4}
                onChange={(e) => setPreviewText(e.target.value)}
                placeholder="Type or paste style instructions to preview."
                data-testid="textarea-preview-instruction"
              />
            </div>
            {previewResult !== null ? (
              <div className="space-y-2">
                <Label>Merged prompt</Label>
                <pre
                  className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted p-3 text-xs"
                  data-testid="text-preview-result"
                >
                  {previewResult}
                </pre>
                {previewMissing.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Placeholders filled at generation time:{" "}
                    {previewMissing.join(", ")}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Run the preview to see the mandatory built-in blocks and your
                amendment merged together.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={closePreview}
              disabled={previewCustomization.isPending}
              data-testid="button-close-preview"
            >
              Close
            </Button>
            <Button
              onClick={runPreview}
              disabled={previewCustomization.isPending}
              data-testid="button-run-preview"
            >
              {previewCustomization.isPending ? "Building..." : "Run preview"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
