import { useState } from "react";
import {
  useListPromptCases,
  useCreatePromptCase,
  useUpdatePromptCase,
  getListPromptCasesQueryKey,
  type PromptCaseType,
  type PromptCaseTypeInput,
  type PromptCaseTypeUpdate,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { Plus } from "lucide-react";

type FlowKey =
  | "caption"
  | "image"
  | "campaign"
  | "video_script"
  | "video_scene_image";
type RiskLevel = "low" | "high";

const FLOW_KEYS: FlowKey[] = [
  "caption",
  "image",
  "campaign",
  "video_script",
  "video_scene_image",
];

interface CaseDraft {
  name: string;
  slug: string;
  description: string;
  flowKey: FlowKey;
  riskLevel: RiskLevel;
  approvalRequired: boolean;
}

const EMPTY_CASE: CaseDraft = {
  name: "",
  slug: "",
  description: "",
  flowKey: "caption",
  riskLevel: "low",
  approvalRequired: false,
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function CasesSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data: cases, isLoading } = useListPromptCases({ includeArchived });
  const createCase = useCreatePromptCase();
  const updateCase = useUpdatePromptCase();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PromptCaseType | null>(null);
  const [draft, setDraft] = useState<CaseDraft>(EMPTY_CASE);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getListPromptCasesQueryKey() });

  const openCreate = () => {
    setEditing(null);
    setDraft(EMPTY_CASE);
    setDialogOpen(true);
  };

  const openEdit = (c: PromptCaseType) => {
    setEditing(c);
    setDraft({
      name: c.name,
      slug: c.slug,
      description: c.description ?? "",
      flowKey: (c.flowKey as FlowKey) ?? "caption",
      riskLevel: c.riskLevel,
      approvalRequired: c.approvalRequired,
    });
    setDialogOpen(true);
  };

  const onError = (err: unknown) =>
    toast({
      variant: "destructive",
      title: "Could not save case type",
      description: apiErrorMessage(err, "Please try again."),
    });

  const handleSubmit = () => {
    if (!draft.name.trim()) {
      toast({
        variant: "destructive",
        title: "Check the fields",
        description: "A case type needs a name.",
      });
      return;
    }
    if (editing) {
      const data: PromptCaseTypeUpdate = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        flowKey: draft.flowKey,
        riskLevel: draft.riskLevel,
        approvalRequired: draft.approvalRequired,
      };
      updateCase.mutate(
        { caseId: editing.id, data },
        {
          onSuccess: () => {
            refresh();
            setDialogOpen(false);
            toast({ title: "Case type saved" });
          },
          onError,
        },
      );
    } else {
      const slug = draft.slug.trim() || slugify(draft.name);
      const data: PromptCaseTypeInput = {
        name: draft.name.trim(),
        slug,
        description: draft.description.trim() || null,
        flowKey: draft.flowKey,
        riskLevel: draft.riskLevel,
        approvalRequired: draft.approvalRequired,
      };
      createCase.mutate(
        { data },
        {
          onSuccess: () => {
            refresh();
            setDialogOpen(false);
            toast({ title: "Case type created" });
          },
          onError,
        },
      );
    }
  };

  const toggleArchive = (c: PromptCaseType) => {
    updateCase.mutate(
      {
        caseId: c.id,
        data: { status: c.status === "archived" ? "active" : "archived" },
      },
      {
        onSuccess: () => {
          refresh();
          toast({
            title: c.status === "archived" ? "Case restored" : "Case archived",
          });
        },
        onError,
      },
    );
  };

  const saving = createCase.isPending || updateCase.isPending;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Case types</CardTitle>
            <CardDescription>
              The kinds of prompts users can customize. Each maps to a flow and
              carries a risk level and approval policy.
            </CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch
                checked={includeArchived}
                onCheckedChange={setIncludeArchived}
                aria-label="Show archived case types"
                data-testid="switch-cases-include-archived"
              />
              <span className="text-sm text-muted-foreground">Archived</span>
            </div>
            <Button onClick={openCreate} data-testid="button-create-case">
              <Plus className="h-4 w-4 mr-1" /> New case
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading || !cases ? (
          <Skeleton className="h-40 w-full" />
        ) : cases.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No case types yet. Create one to get started.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Slug</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Flow</TableHead>
                <TableHead>Risk</TableHead>
                <TableHead>Approval</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cases.map((c) => (
                <TableRow key={c.id} data-testid={`row-case-${c.id}`}>
                  <TableCell className="font-mono text-xs">{c.slug}</TableCell>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{c.flowKey ?? "—"}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={c.riskLevel === "high" ? "destructive" : "secondary"}
                      data-testid={`badge-risk-${c.id}`}
                    >
                      {c.riskLevel}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {c.approvalRequired ? (
                      <Badge variant="secondary">Required</Badge>
                    ) : (
                      <span className="text-sm text-muted-foreground">No</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={c.status === "archived" ? "outline" : "secondary"}
                      data-testid={`badge-case-status-${c.id}`}
                    >
                      {c.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right space-x-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEdit(c)}
                      data-testid={`button-edit-case-${c.id}`}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleArchive(c)}
                      disabled={updateCase.isPending}
                      data-testid={`button-archive-case-${c.id}`}
                    >
                      {c.status === "archived" ? "Restore" : "Archive"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit case type" : "New case type"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Update this case type's metadata."
                : "Create a new prompt case type."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Name</label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="e.g. Instagram caption"
                data-testid="input-case-name"
              />
            </div>
            {!editing && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Slug</label>
                <Input
                  value={draft.slug}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, slug: e.target.value }))
                  }
                  placeholder={draft.name ? slugify(draft.name) : "auto from name"}
                  data-testid="input-case-slug"
                />
                <p className="text-xs text-muted-foreground">
                  Lowercase letters, numbers, and hyphens. Leave blank to derive
                  from the name.
                </p>
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">Description</label>
              <Textarea
                value={draft.description}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, description: e.target.value }))
                }
                rows={2}
                data-testid="input-case-description"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Flow</label>
                <Select
                  value={draft.flowKey}
                  onValueChange={(v) =>
                    setDraft((d) => ({ ...d, flowKey: v as FlowKey }))
                  }
                >
                  <SelectTrigger data-testid="select-case-flow">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FLOW_KEYS.map((f) => (
                      <SelectItem key={f} value={f}>
                        {f}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Risk level</label>
                <Select
                  value={draft.riskLevel}
                  onValueChange={(v) =>
                    setDraft((d) => ({ ...d, riskLevel: v as RiskLevel }))
                  }
                >
                  <SelectTrigger data-testid="select-case-risk">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">low</SelectItem>
                    <SelectItem value="high">high</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={draft.approvalRequired}
                onCheckedChange={(on) =>
                  setDraft((d) => ({ ...d, approvalRequired: on }))
                }
                aria-label="Approval required"
                data-testid="switch-case-approval"
              />
              <span className="text-sm text-muted-foreground">
                Require review approval before production
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={saving}
              data-testid="button-save-case"
            >
              {saving ? "Saving..." : editing ? "Save changes" : "Create case"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
