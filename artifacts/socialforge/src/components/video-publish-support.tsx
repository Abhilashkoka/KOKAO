import { useState } from "react";
import {
  useGetMe,
  useListVideoPublishSupport,
  getListVideoPublishSupportQueryKey,
  getListContentQueryKey,
  getListVideoPublishesQueryKey,
  reconcileVideoPublishSupport,
  resolveVideoPublishSupport,
  type VideoPublishSupportRecord,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { VIDEO_DESTINATION_LABELS, VIDEO_PUBLISH_STATE_LABELS } from "@/lib/videoPublish";
import { AlertCircle, ChevronDown, ChevronUp, LifeBuoy, RotateCw, Search, ShieldCheck } from "lucide-react";

type Outcome = "published" | "failed";
type ReconcileResult = { outcome: "published" | "failed" | "unresolved" } | { error: string };
type Saved = { rowId: number; contentItemId: number; platform: string; outcome: Outcome; at: string };

const destLabel = (p: string) => VIDEO_DESTINATION_LABELS[p as keyof typeof VIDEO_DESTINATION_LABELS] ?? p;
const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString() : "Not recorded");

function IdLine({ label, value, testId }: { label: string; value: string | null; testId: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono break-all text-foreground" data-testid={testId}>
        {value ?? <span className="font-sans text-muted-foreground">none recorded</span>}
      </dd>
    </div>
  );
}

function SupportRow({
  row,
  onResolved,
}: {
  row: VideoPublishSupportRecord;
  onResolved: (s: Saved) => void;
}) {
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<ReconcileResult | null>(null);
  const [outcome, setOutcome] = useState<Outcome | "">("");
  const [ownerChecked, setOwnerChecked] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const hasIds = !!(row.externalId || row.containerId);
  const m = row.metadata;

  const runCheck = async () => {
    setChecking(true);
    setCheck(null);
    try {
      const res = await reconcileVideoPublishSupport(row.tenantId, row.id);
      setCheck({ outcome: res.outcome });
    } catch (err) {
      setCheck({ error: apiErrorMessage(err, "The check could not be completed.") });
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    if (!outcome || !ownerChecked) return;
    setConfirmOpen(false);
    setSaving(true);
    setSaveError(null);
    try {
      await resolveVideoPublishSupport(row.tenantId, row.id, {
        expectedUpdatedAt: row.updatedAt,
        outcome,
        ownerCheckedDestination: true,
      });
      onResolved({ rowId: row.id, contentItemId: row.contentItemId, platform: row.platform, outcome, at: new Date().toISOString() });
      queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListVideoPublishesQueryKey(row.contentItemId) });
      queryClient.invalidateQueries({
        predicate: (q) => String(q.queryKey[0] ?? "").startsWith(String(getListVideoPublishSupportQueryKey()[0])),
      });
    } catch (err) {
      setSaveError(apiErrorMessage(err, "Could not save. The record may have changed; reload and check again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="rounded-lg border border-border bg-muted/20 p-3 sm:p-4 space-y-3" data-testid={`row-video-support-${row.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-sm">{destLabel(row.platform)}</span>
        <Badge variant="secondary" data-testid={`status-video-support-${row.id}`}>
          {VIDEO_PUBLISH_STATE_LABELS[row.state] ?? row.state}
        </Badge>
        <span className="text-xs text-muted-foreground">Content #{row.contentItemId}</span>
        {row.hasSession && <span className="text-xs text-muted-foreground">Upload session recorded</span>}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <dl className="space-y-1">
          <IdLine label="Record" value={String(row.id)} testId={`text-support-id-${row.id}`} />
          <IdLine label="Workspace" value={String(row.tenantId)} testId={`text-support-tenant-${row.id}`} />
          <IdLine label="Platform post ID" value={row.externalId} testId={`text-support-external-${row.id}`} />
          <IdLine label="Container ID" value={row.containerId} testId={`text-support-container-${row.id}`} />
          <IdLine label="Account ID" value={row.accountId} testId={`text-support-account-${row.id}`} />
          <IdLine label="Last attempt" value={fmt(row.lastAttemptAt)} testId={`text-support-attempt-${row.id}`} />
          <IdLine label="Last update" value={fmt(row.updatedAt)} testId={`text-support-updated-${row.id}`} />
        </dl>
        <div className="rounded-md border border-border bg-background/60 p-2.5 text-xs space-y-1" data-testid={`text-support-metadata-${row.id}`}>
          <p className="font-medium text-muted-foreground">Reviewed snapshot (read-only)</p>
          <p className="font-medium break-words">{m.title}</p>
          <p className="whitespace-pre-wrap break-words text-muted-foreground max-h-24 overflow-y-auto">{m.description || "No description"}</p>
          <p className="text-muted-foreground">
            {destLabel(m.destination)} · {m.privacy} · {m.madeForKids ? "made for kids" : "not made for kids"}
          </p>
        </div>
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={runCheck} disabled={checking || !hasIds} data-testid={`button-support-reconcile-${row.id}`}>
            {checking ? <RippleSpinner className="mr-2 h-4 w-4" /> : <Search className="mr-2 h-4 w-4" />}
            Check exact IDs
          </Button>
          <span className="text-xs text-muted-foreground">Read-only lookup. It does not change this record and never uploads.</span>
        </div>
        {!hasIds && (
          <p className="text-xs text-muted-foreground" data-testid={`text-support-noids-${row.id}`}>
            No platform IDs were recorded, so this cannot be checked automatically. Open the {destLabel(row.platform)} account
            directly, look for a post matching the reviewed title above, then record what you found below.
          </p>
        )}
        {check && (
          <p
            role="status"
            className={`text-xs ${"error" in check ? "text-destructive" : "text-foreground"}`}
            data-testid={`text-support-reconcile-result-${row.id}`}
          >
            {"error" in check
              ? check.error
              : check.outcome === "published"
                ? "The platform reports these IDs as published. Nothing was changed; confirm below to record it."
                : check.outcome === "failed"
                  ? "The platform reports these IDs as failed. Nothing was changed; confirm below to record it."
                  : "Unresolved: the platform gave no definite answer. Check the destination account yourself before recording an outcome."}
          </p>
        )}
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs">What did you find on {destLabel(row.platform)}?</Label>
            <Select value={outcome} onValueChange={(v) => setOutcome(v as Outcome)} disabled={saving}>
              <SelectTrigger className="w-[200px]" data-testid={`select-support-outcome-${row.id}`}>
                <SelectValue placeholder="Choose outcome" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="failed">Not published</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            onClick={() => setConfirmOpen(true)}
            disabled={!outcome || !ownerChecked || saving}
            data-testid={`button-support-resolve-${row.id}`}
          >
            {saving ? <RippleSpinner className="mr-2 h-4 w-4" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
            Record outcome
          </Button>
        </div>
        <label className="flex items-start gap-2 text-xs cursor-pointer">
          <Checkbox
            checked={ownerChecked}
            onCheckedChange={(v) => setOwnerChecked(v === true)}
            disabled={saving}
            data-testid={`checkbox-support-owner-checked-${row.id}`}
          />
          <span>I confirm the workspace owner checked the {destLabel(row.platform)} destination account.</span>
        </label>
        <p className="text-xs text-muted-foreground">Recording an outcome only updates this status. It never creates another upload.</p>
        {saveError && (
          <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive" data-testid={`text-support-error-${row.id}`}>
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {saveError}
          </p>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Record as {outcome === "published" ? "published" : "not published"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Content #{row.contentItemId} on {destLabel(row.platform)} will be marked{" "}
              {outcome === "published" ? "published" : "not published (failed)"}. This is a status update only: nothing is
              uploaded, and no new upload will be created for this destination.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`button-support-confirm-cancel-${row.id}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={save} data-testid={`button-support-confirm-save-${row.id}`}>Record outcome</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

export function VideoPublishSupport() {
  const { data: me } = useGetMe();
  const isSuper = !!me?.isSuperadmin;
  const allowed = !!me && (me.team?.role === "owner" || isSuper);
  const [open, setOpen] = useState(false);
  const [wsInput, setWsInput] = useState("");
  const [wsApplied, setWsApplied] = useState<number | undefined>(undefined);
  const [saved, setSaved] = useState<Saved[]>([]);

  const params = isSuper && wsApplied ? { tenantId: wsApplied } : undefined;
  const { data, isLoading, isError, error, refetch, isFetching } = useListVideoPublishSupport(params, {
    query: { queryKey: getListVideoPublishSupportQueryKey(params), enabled: allowed && open },
  });

  if (!allowed) return null;
  const rows = data ?? [];
  const wsValid = wsInput.trim() === "" || /^[1-9]\d*$/.test(wsInput.trim());

  return (
    <Card data-testid="card-video-publish-support">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <LifeBuoy className="h-4 w-4 text-primary" /> Video publishing support
            </CardTitle>
            <CardDescription>
              Videos whose upload outcome is uncertain. Check exact IDs or record what you saw. Nothing here retries or re-uploads.
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="video-support-body"
            data-testid="button-toggle-video-support"
          >
            {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            <span className="ml-1">{open ? "Hide" : "Show"}</span>
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent id="video-support-body" className="space-y-4">
          {isSuper && (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!wsValid) return;
                setWsApplied(wsInput.trim() ? Number(wsInput.trim()) : undefined);
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="video-support-ws" className="text-xs">Workspace ID (superadmin)</Label>
                <Input
                  id="video-support-ws"
                  inputMode="numeric"
                  className="w-[180px]"
                  placeholder={`Current: ${me?.tenant?.id ?? ""}`}
                  value={wsInput}
                  onChange={(e) => setWsInput(e.target.value)}
                  aria-invalid={!wsValid}
                  data-testid="input-video-support-workspace"
                />
              </div>
              <Button size="sm" type="submit" variant="outline" disabled={!wsValid} data-testid="button-video-support-workspace">
                Load
              </Button>
              <span className="text-xs text-muted-foreground" data-testid="text-video-support-workspace">
                Showing workspace {wsApplied ?? me?.tenant?.id ?? "current"}
              </span>
              {!wsValid && <span className="w-full text-xs text-destructive">Enter a positive whole number.</span>}
            </form>
          )}

          {saved.length > 0 && (
            <ul className="space-y-1" aria-live="polite">
              {saved.map((s) => (
                <li key={`${s.rowId}-${s.at}`} className="flex items-start gap-1.5 rounded-md bg-primary/10 px-3 py-2 text-xs" data-testid={`text-support-saved-${s.rowId}`}>
                  <ShieldCheck className="h-3.5 w-3.5 mt-0.5 shrink-0 text-primary" />
                  Content #{s.contentItemId} on {destLabel(s.platform)} recorded as {s.outcome === "published" ? "published" : "not published"} at{" "}
                  {new Date(s.at).toLocaleTimeString()}. No upload was created.
                </li>
              ))}
            </ul>
          )}

          {isLoading ? (
            <div className="space-y-2" data-testid="loading-video-support">
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-28 w-full" />
            </div>
          ) : isError ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive" data-testid="error-video-support">
              <AlertCircle className="h-4 w-4" /> {apiErrorMessage(error, "Could not load support records.")}
              <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching} data-testid="button-video-support-retry-load">
                <RotateCw className="mr-2 h-4 w-4" /> Try again
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="empty-video-support">
              No failed or attention-required video uploads in this workspace.
            </p>
          ) : (
            <ul className="space-y-3">
              {rows.map((r) => (
                <SupportRow key={r.id} row={r} onResolved={(s) => setSaved((p) => [s, ...p])} />
              ))}
            </ul>
          )}
        </CardContent>
      )}
    </Card>
  );
}
