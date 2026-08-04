import { useState } from "react";
import {
  useListPromptCases,
  useListPromptTemplates,
  useCreatePromptTemplate,
  useUpdatePromptTemplate,
  useClonePromptTemplate,
  getListPromptTemplatesQueryKey,
  type PromptTemplate,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import {
  BlockEditor,
  type BlockDraft,
  blocksToApi,
  hasValidMandatoryBlock,
  newBlockDraft,
} from "./block-editor";
import { VersionsSection } from "./versions-section";

function statusVariant(
  status: PromptTemplate["status"],
): "default" | "secondary" | "outline" {
  if (status === "active") return "default";
  if (status === "draft") return "secondary";
  return "outline";
}

export function TemplatesSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data: cases } = useListPromptCases({ includeArchived: true });
  const { data: templates, isLoading } = useListPromptTemplates({
    includeArchived,
  });
  const createTemplate = useCreatePromptTemplate();
  const updateTemplate = useUpdatePromptTemplate();
  const cloneTemplate = useClonePromptTemplate();

  const [expanded, setExpanded] = useState<number | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [caseTypeId, setCaseTypeId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [blocks, setBlocks] = useState<BlockDraft[]>([newBlockDraft(true)]);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<PromptTemplate | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");

  const caseName = (id: number) =>
    cases?.find((c) => c.id === id)?.name ?? `Case #${id}`;

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: getListPromptTemplatesQueryKey(),
    });

  const openCreate = () => {
    setCaseTypeId(cases && cases.length > 0 ? String(cases[0]!.id) : "");
    setTitle("");
    setDescription("");
    setBlocks([newBlockDraft(true)]);
    setCreateOpen(true);
  };

  const submitCreate = () => {
    const caseId = Number(caseTypeId);
    if (!caseId || !title.trim()) {
      toast({
        variant: "destructive",
        title: "Check the fields",
        description: "Pick a case type and enter a title.",
      });
      return;
    }
    if (!hasValidMandatoryBlock(blocks)) {
      toast({
        variant: "destructive",
        title: "Check the blocks",
        description: "At least one mandatory block needs a title and content.",
      });
      return;
    }
    createTemplate.mutate(
      {
        data: {
          caseTypeId: caseId,
          title: title.trim(),
          description: description.trim() || null,
          blocks: blocksToApi(blocks),
        },
      },
      {
        onSuccess: () => {
          refresh();
          setCreateOpen(false);
          toast({ title: "Template created" });
        },
        onError: (err) =>
          toast({
            variant: "destructive",
            title: "Could not create template",
            description: apiErrorMessage(err, "Please try again."),
          }),
      },
    );
  };

  const openEdit = (t: PromptTemplate) => {
    setEditing(t);
    setEditTitle(t.title);
    setEditDescription(t.description ?? "");
    setEditOpen(true);
  };

  const submitEdit = () => {
    if (!editing || !editTitle.trim()) return;
    updateTemplate.mutate(
      {
        templateId: editing.id,
        data: {
          title: editTitle.trim(),
          description: editDescription.trim() || null,
        },
      },
      {
        onSuccess: () => {
          refresh();
          setEditOpen(false);
          toast({ title: "Template saved" });
        },
        onError: (err) =>
          toast({
            variant: "destructive",
            title: "Could not save template",
            description: apiErrorMessage(err, "Please try again."),
          }),
      },
    );
  };

  const clone = (t: PromptTemplate) => {
    cloneTemplate.mutate(
      { templateId: t.id },
      {
        onSuccess: () => {
          refresh();
          toast({ title: "Template cloned into a new draft" });
        },
        onError: (err) =>
          toast({
            variant: "destructive",
            title: "Could not clone template",
            description: apiErrorMessage(err, "Please try again."),
          }),
      },
    );
  };

  const archive = (t: PromptTemplate) => {
    updateTemplate.mutate(
      {
        templateId: t.id,
        data: { status: t.status === "archived" ? "active" : "archived" },
      },
      {
        onSuccess: () => {
          refresh();
          toast({
            title:
              t.status === "archived" ? "Template restored" : "Template archived",
          });
        },
        onError: (err) =>
          toast({
            variant: "destructive",
            title: "Could not archive template",
            description: apiErrorMessage(
              err,
              "A template serving live production traffic cannot be archived.",
            ),
          }),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Templates</CardTitle>
            <CardDescription>
              Governed prompt templates per case type. Expand a template to
              manage its versions and lifecycle.
            </CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch
                checked={includeArchived}
                onCheckedChange={setIncludeArchived}
                aria-label="Show archived templates"
                data-testid="switch-templates-include-archived"
              />
              <span className="text-sm text-muted-foreground">Archived</span>
            </div>
            <Button
              onClick={openCreate}
              disabled={!cases || cases.length === 0}
              data-testid="button-create-template"
            >
              <Plus className="h-4 w-4 mr-1" /> New template
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading || !templates ? (
          <Skeleton className="h-40 w-full" />
        ) : templates.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No templates yet.
          </p>
        ) : (
          templates.map((t) => {
            const isOpen = expanded === t.id;
            return (
              <div
                key={t.id}
                className="rounded-lg border border-border"
                data-testid={`template-${t.id}`}
              >
                <div className="flex items-start justify-between gap-4 p-4">
                  <button
                    type="button"
                    className="flex items-start gap-2 text-left"
                    onClick={() => setExpanded(isOpen ? null : t.id)}
                    data-testid={`button-toggle-template-${t.id}`}
                  >
                    {isOpen ? (
                      <ChevronDown className="h-5 w-5 mt-0.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-5 w-5 mt-0.5 text-muted-foreground" />
                    )}
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{t.title}</span>
                        <Badge
                          variant={statusVariant(t.status)}
                          data-testid={`badge-template-status-${t.id}`}
                        >
                          {t.status}
                        </Badge>
                        <Badge variant="outline">{caseName(t.caseTypeId)}</Badge>
                      </div>
                      {t.description && (
                        <p className="text-sm text-muted-foreground">
                          {t.description}
                        </p>
                      )}
                      <div className="flex items-center gap-2 text-xs">
                        {t.activeProductionVersionId ? (
                          <Badge
                            variant="default"
                            data-testid={`badge-prod-version-${t.id}`}
                          >
                            Prod v{t.productionVersionNo ?? "?"}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">
                            No production version
                          </span>
                        )}
                        {t.activeStagingVersionId && (
                          <Badge
                            variant="secondary"
                            data-testid={`badge-staging-version-${t.id}`}
                          >
                            Staging active
                          </Badge>
                        )}
                        {typeof t.usageRequests === "number" && (
                          <span className="text-muted-foreground">
                            {t.usageRequests} requests · {t.usageTenants ?? 0}{" "}
                            workspaces
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEdit(t)}
                      data-testid={`button-edit-template-${t.id}`}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => clone(t)}
                      disabled={cloneTemplate.isPending}
                      data-testid={`button-clone-template-${t.id}`}
                    >
                      Clone
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => archive(t)}
                      disabled={updateTemplate.isPending}
                      data-testid={`button-archive-template-${t.id}`}
                    >
                      {t.status === "archived" ? "Restore" : "Archive"}
                    </Button>
                  </div>
                </div>
                {isOpen && (
                  <div className="border-t border-border p-4">
                    <VersionsSection template={t} />
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[640px] max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New template</DialogTitle>
            <DialogDescription>
              Creates the template with its first draft version.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Case type</label>
              <Select value={caseTypeId} onValueChange={setCaseTypeId}>
                <SelectTrigger data-testid="select-template-case">
                  <SelectValue placeholder="Pick a case type" />
                </SelectTrigger>
                <SelectContent>
                  {cases?.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Title</label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                data-testid="input-template-title"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Description</label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                data-testid="input-template-description"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Blocks</label>
              <BlockEditor
                blocks={blocks}
                onChange={setBlocks}
                disabled={createTemplate.isPending}
                testIdPrefix="template-block"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={createTemplate.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={submitCreate}
              disabled={createTemplate.isPending}
              data-testid="button-save-template"
            >
              {createTemplate.isPending ? "Creating..." : "Create template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Edit template</DialogTitle>
            <DialogDescription>
              Update the template metadata. Blocks are versioned separately.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Title</label>
              <Input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                data-testid="input-edit-template-title"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Description</label>
              <Textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={2}
                data-testid="input-edit-template-description"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditOpen(false)}
              disabled={updateTemplate.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={submitEdit}
              disabled={updateTemplate.isPending}
              data-testid="button-save-edit-template"
            >
              {updateTemplate.isPending ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
