import { useState } from "react";
import {
  useListCampaigns,
  useCreateCampaign,
  useUpdateCampaign,
  useDeleteCampaign,
  useGetCampaignReport,
  getListCampaignsQueryKey,
  getGetCampaignReportQueryKey,
  type CampaignView,
  type CampaignUpdateStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LogoLoader } from "@/components/logo-loader";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  Pencil,
  Trash2,
  Target,
  Heart,
  MessageCircle,
  Share2,
  Eye,
  BarChart3,
} from "lucide-react";
import { format } from "date-fns";

const GOALS = [
  { value: "awareness", label: "Awareness" },
  { value: "engagement", label: "Engagement" },
  { value: "traffic", label: "Traffic" },
  { value: "leads", label: "Leads" },
  { value: "sales", label: "Sales" },
  { value: "other", label: "Other" },
];

const STATUS_STYLES: Record<string, string> = {
  active: "bg-green-500/10 text-green-700 border-green-500/30",
  completed: "bg-blue-500/10 text-blue-700 border-blue-500/30",
  archived: "bg-muted text-muted-foreground",
};

interface FormState {
  name: string;
  goal: string;
  goalTarget: string;
  description: string;
  startsAt: string;
  endsAt: string;
  status: CampaignUpdateStatus;
}

const EMPTY_FORM: FormState = {
  name: "",
  goal: "engagement",
  goalTarget: "",
  description: "",
  startsAt: "",
  endsAt: "",
  status: "active",
};

function toDateInput(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

export function CampaignsPage() {
  const { data: campaigns, isLoading } = useListCampaigns();
  const createCampaign = useCreateCampaign();
  const updateCampaign = useUpdateCampaign();
  const deleteCampaign = useDeleteCampaign();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CampaignView | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState<CampaignView | null>(null);
  const [reportFor, setReportFor] = useState<CampaignView | null>(null);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (c: CampaignView) => {
    setEditing(c);
    setForm({
      name: c.name,
      goal: c.goal,
      goalTarget: c.goalTarget != null ? String(c.goalTarget) : "",
      description: c.description ?? "",
      startsAt: toDateInput(c.startsAt),
      endsAt: toDateInput(c.endsAt),
      status: c.status,
    });
    setDialogOpen(true);
  };

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });

  const submit = () => {
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    const goalTarget = form.goalTarget.trim()
      ? Number(form.goalTarget)
      : null;
    if (goalTarget !== null && (!Number.isFinite(goalTarget) || goalTarget < 0)) {
      toast({ title: "Target must be a positive number", variant: "destructive" });
      return;
    }
    const payload = {
      name: form.name.trim(),
      goal: form.goal,
      goalTarget,
      description: form.description.trim() || null,
      startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null,
      endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
    };
    if (editing) {
      updateCampaign.mutate(
        { id: editing.id, data: { ...payload, status: form.status } },
        {
          onSuccess: () => {
            setDialogOpen(false);
            refresh();
            toast({ title: "Campaign updated" });
          },
          onError: () =>
            toast({ title: "Could not update campaign", variant: "destructive" }),
        },
      );
    } else {
      createCampaign.mutate(
        { data: payload },
        {
          onSuccess: () => {
            setDialogOpen(false);
            refresh();
            toast({ title: "Campaign created" });
          },
          onError: () =>
            toast({ title: "Could not create campaign", variant: "destructive" }),
        },
      );
    }
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    deleteCampaign.mutate(
      { id: deleteTarget.id },
      {
        onSuccess: () => {
          setDeleteTarget(null);
          refresh();
          toast({ title: "Campaign deleted" });
        },
        onError: () => {
          setDeleteTarget(null);
          toast({ title: "Could not delete campaign", variant: "destructive" });
        },
      },
    );
  };

  const saving = createCampaign.isPending || updateCampaign.isPending;

  if (isLoading) {
    return (
      <div className="flex justify-center py-24">
        <LogoLoader />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="page-campaigns">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Campaigns</h1>
          <p className="text-sm text-muted-foreground">
            Group content around a goal and track how it performs.
          </p>
        </div>
        <Button onClick={openCreate} data-testid="button-new-campaign">
          <Plus className="h-4 w-4 mr-2" />
          New Campaign
        </Button>
      </div>

      {(campaigns ?? []).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="rounded-full bg-muted p-4 mb-4">
              <Target className="h-8 w-8 text-muted-foreground" />
            </div>
            <h2 className="text-lg font-semibold">No campaigns yet</h2>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              Create a campaign, then assign library content to it to see
              aggregated performance.
            </p>
            <Button className="mt-4" onClick={openCreate} data-testid="button-empty-new-campaign">
              <Plus className="h-4 w-4 mr-2" />
              Create your first campaign
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(campaigns ?? []).map((c) => (
            <Card key={c.id} data-testid={`campaign-card-${c.id}`}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base truncate">{c.name}</CardTitle>
                  <Badge variant="outline" className={STATUS_STYLES[c.status]}>
                    {c.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-sm text-muted-foreground">
                  Goal: <span className="capitalize">{c.goal}</span>
                  {c.goalTarget != null && <> · Target: {c.goalTarget}</>}
                </div>
                {(c.startsAt || c.endsAt) && (
                  <div className="text-xs text-muted-foreground">
                    {c.startsAt ? format(new Date(c.startsAt), "MMM d, yyyy") : "Open start"}
                    {" – "}
                    {c.endsAt ? format(new Date(c.endsAt), "MMM d, yyyy") : "Open end"}
                  </div>
                )}
                <div className="text-sm">
                  {c.contentCount ?? 0} content item{(c.contentCount ?? 0) === 1 ? "" : "s"}
                </div>
                <div className="flex gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setReportFor(c)}
                    data-testid={`button-report-${c.id}`}
                  >
                    <BarChart3 className="h-4 w-4 mr-1" />
                    Report
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => openEdit(c)}
                    data-testid={`button-edit-${c.id}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 text-destructive"
                    onClick={() => setDeleteTarget(c)}
                    data-testid={`button-delete-${c.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Campaign" : "New Campaign"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="campaign-name">Name</Label>
              <Input
                id="campaign-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Summer launch"
                data-testid="input-campaign-name"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Goal</Label>
                <Select
                  value={form.goal}
                  onValueChange={(v) => setForm({ ...form, goal: v })}
                >
                  <SelectTrigger data-testid="select-campaign-goal">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GOALS.map((g) => (
                      <SelectItem key={g.value} value={g.value}>
                        {g.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="campaign-target">Target (optional)</Label>
                <Input
                  id="campaign-target"
                  type="number"
                  min={0}
                  value={form.goalTarget}
                  onChange={(e) => setForm({ ...form, goalTarget: e.target.value })}
                  placeholder="500"
                  data-testid="input-campaign-target"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="campaign-start">Starts</Label>
                <Input
                  id="campaign-start"
                  type="date"
                  value={form.startsAt}
                  onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                  data-testid="input-campaign-start"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="campaign-end">Ends</Label>
                <Input
                  id="campaign-end"
                  type="date"
                  value={form.endsAt}
                  onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
                  data-testid="input-campaign-end"
                />
              </div>
            </div>
            {editing && (
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) =>
                    setForm({ ...form, status: v as CampaignUpdateStatus })
                  }
                >
                  <SelectTrigger data-testid="select-campaign-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="campaign-description">Notes (optional)</Label>
              <Textarea
                id="campaign-description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
                data-testid="input-campaign-description"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving} data-testid="button-save-campaign">
              {saving && <RippleSpinner className="mr-2 h-4 w-4" />}
              {editing ? "Save changes" : "Create campaign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete campaign?"
        description={`"${deleteTarget?.name ?? ""}" will be deleted. Content stays in your library; it just loses the campaign tag.`}
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
      />

      <CampaignReportDialog
        campaign={reportFor}
        onClose={() => setReportFor(null)}
      />
    </div>
  );
}

function CampaignReportDialog({
  campaign,
  onClose,
}: {
  campaign: CampaignView | null;
  onClose: () => void;
}) {
  const { data: report, isLoading } = useGetCampaignReport(campaign?.id ?? 0, {
    query: {
      queryKey: getGetCampaignReportQueryKey(campaign?.id ?? 0),
      enabled: !!campaign,
    },
  });

  return (
    <Dialog open={!!campaign} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{campaign?.name} — Performance</DialogTitle>
        </DialogHeader>
        {isLoading || !report ? (
          <div className="flex justify-center py-12">
            <LogoLoader />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatTile icon={Heart} label="Likes" value={report.totals.likes} />
              <StatTile icon={MessageCircle} label="Comments" value={report.totals.comments} />
              <StatTile icon={Share2} label="Shares" value={report.totals.shares} />
              <StatTile icon={Eye} label="Impressions" value={report.totals.impressions} />
            </div>
            <div className="text-sm text-muted-foreground">
              {report.totals.engagements} total engagements across{" "}
              {report.totals.trackedPosts} tracked post
              {report.totals.trackedPosts === 1 ? "" : "s"}.
              {campaign?.goalTarget != null && (
                <> Target: {report.totals.engagements} / {campaign.goalTarget}.</>
              )}
            </div>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {report.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No content is attached to this campaign yet. Assign items
                  from the Content Library.
                </p>
              ) : (
                report.items.map((item) => (
                  <div
                    key={item.contentItemId}
                    className="rounded-md border p-2.5 text-sm"
                    data-testid={`report-item-${item.contentItemId}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">
                        {item.title || "Untitled"}
                      </span>
                      <Badge variant="outline" className="capitalize">
                        {item.status}
                      </Badge>
                    </div>
                    {item.metrics.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-3 text-xs text-muted-foreground">
                        {item.metrics.map((m) => (
                          <span key={m.id} className="inline-flex items-center gap-1.5">
                            <span className="capitalize">{m.platform}:</span>
                            <Heart className="h-3 w-3" /> {m.likes}
                            <MessageCircle className="h-3 w-3" /> {m.comments}
                            <Share2 className="h-3 w-3" /> {m.shares}
                            <Eye className="h-3 w-3" /> {m.impressions}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Heart;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-md border p-3 text-center">
      <Icon className="h-4 w-4 mx-auto text-muted-foreground" />
      <div className="text-lg font-semibold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
