import { useState } from "react";
import {
  useAdminListAuditLogs,
  getAdminListAuditLogsQueryKey,
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { localDayStartISO, localDayEndISO } from "@/lib/auditDateRange";
import { PLAN_LABELS } from "./shared";

const AUDIT_ACTION_LABELS: Record<string, string> = {
  plan_change: "Plan change",
  superadmin_grant: "Superadmin granted",
  superadmin_revoke: "Superadmin revoked",
  plan_edit: "Plan limits edited",
  plan_create: "Plan created",
  plan_delete: "Plan deleted",
  notification_policy_change: "Notification policy changed",
  credential_change: "Platform credentials saved",
  app_brand_change: "App branding changed",
  landing_content_change: "Landing page content changed",
  email_settings_change: "Email settings changed",
  asr_provider_change: "Speech-to-text provider changed",
  asr_key_change: "Speech-to-text key changed",
  voice_clone_provider_change: "Voice-cloning provider changed",
  voice_clone_key_change: "Voice-cloning key changed",
  textgen_provider_change: "Text generation provider changed",
  custom_ai_provider_change: "Custom AI provider changed",
  textgen_key_change: "Text generation key changed",
  email_test_send: "Test email sent",
  sweep_run: "Manual sweep run",
  promo_code_change: "Promo code changed",
  ai_spend_settings_change: "AI spend rates changed",
  signup_credit_settings_change: "Signup credits changed",
  ai_cost_change: "AI cost pricing changed",
  wallet_settings_change: "Wallet settings changed",
  billing_mode_change: "Billing mode changed",
  wallet_adjust: "Wallet balance adjusted",
  prompt_case_change: "Prompt case type changed",
  prompt_template_change: "Prompt template changed",
  prompt_version_change: "Prompt version changed",
  prompt_review_decision: "Prompt review decision",
  prompt_promotion: "Prompt promoted to production",
  prompt_rollback: "Prompt rolled back",
  prompt_kit_import: "Prompt Kit bundle imported",
};
function formatAuditValue(action: string, value: string | null): string {
  if (value === null || value === "") return "—";
  if (action === "plan_change") return PLAN_LABELS[value] ?? value;
  if (action === "notification_policy_change") {
    try {
      const parsed = JSON.parse(value) as {
        type?: string;
        enabled?: boolean;
        emailPolicy?: string;
      };
      const parts: string[] = [];
      if (parsed.type) parts.push(parsed.type.replace(/_/g, " "));
      parts.push(parsed.enabled ? "enabled" : "disabled");
      if (parsed.emailPolicy) parts.push(`email: ${parsed.emailPolicy}`);
      return parts.join(", ");
    } catch {
      return value;
    }
  }
  if (action === "app_brand_change") {
    try {
      const parsed = JSON.parse(value) as {
        appName?: string | null;
        logoUrl?: string | null;
        iconUrl?: string | null;
        primaryColor?: string | null;
        backgroundColor?: string | null;
      };
      const parts: string[] = [];
      parts.push(`name: ${parsed.appName ?? "default"}`);
      parts.push(`logo: ${parsed.logoUrl ? "custom" : "default"}`);
      parts.push(`icon: ${parsed.iconUrl ? "custom" : "default"}`);
      parts.push(`primary: ${parsed.primaryColor ?? "default"}`);
      parts.push(`background: ${parsed.backgroundColor ?? "default"}`);
      return parts.join(", ");
    } catch {
      return value;
    }
  }
  if (action === "email_settings_change") {
    try {
      const parsed = JSON.parse(value) as {
        sendingEnabled?: boolean;
        fromEmail?: string | null;
        apiKeyMasked?: string | null;
      };
      const parts: string[] = [];
      parts.push(parsed.sendingEnabled ? "sending enabled" : "sending paused");
      if (parsed.fromEmail) parts.push(`from: ${parsed.fromEmail}`);
      if (parsed.apiKeyMasked) parts.push(`key: ${parsed.apiKeyMasked}`);
      return parts.join(", ");
    } catch {
      return value;
    }
  }
  if (action === "email_test_send") {
    try {
      const parsed = JSON.parse(value) as {
        recipient?: string;
        outcome?: string;
        error?: string | null;
      };
      const parts: string[] = [];
      if (parsed.recipient) parts.push(`to: ${parsed.recipient}`);
      if (parsed.outcome) parts.push(parsed.outcome);
      if (parsed.error) parts.push(parsed.error);
      return parts.join(", ") || value;
    } catch {
      return value;
    }
  }
  if (action === "sweep_run") {
    try {
      const parsed = JSON.parse(value) as { started?: boolean };
      return parsed.started
        ? "sweep completed"
        : "skipped (already running)";
    } catch {
      return value;
    }
  }
  if (action === "credential_change") {
    try {
      const parsed = JSON.parse(value) as {
        provider?: string;
        idMasked?: string | null;
      };
      const provider =
        parsed.provider === "twitter" ? "X (Twitter)" : parsed.provider;
      return [provider, parsed.idMasked].filter(Boolean).join(" ");
    } catch {
      return value;
    }
  }
  if (value === "true") return "Yes";
  if (value === "false") return "No";
  return value;
}

const AUDIT_PAGE_SIZE = 50;

export function AuditLogCard() {
  const { toast } = useToast();
  const [actionFilter, setActionFilter] = useState("all");
  const [actorInput, setActorInput] = useState("");
  const [targetInput, setTargetInput] = useState("");
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const [applied, setApplied] = useState<{
    action?: string;
    actor?: string;
    target?: string;
    from?: string;
    to?: string;
  }>({});
  const [offset, setOffset] = useState(0);

  const params = {
    limit: AUDIT_PAGE_SIZE,
    offset,
    ...(applied.action ? { action: applied.action as never } : {}),
    ...(applied.actor ? { actor: applied.actor } : {}),
    ...(applied.target ? { target: applied.target } : {}),
    ...(applied.from ? { from: applied.from } : {}),
    ...(applied.to ? { to: applied.to } : {}),
  };

  const { data, isLoading, isFetching } = useAdminListAuditLogs(params, {
    query: {
      queryKey: getAdminListAuditLogsQueryKey(params),
      placeholderData: (prev) => prev,
    },
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const hasFilters =
    actionFilter !== "all" || actorInput || targetInput || fromInput || toInput;

  const applyFilters = () => {
    setOffset(0);
    setApplied({
      action: actionFilter === "all" ? undefined : actionFilter,
      actor: actorInput.trim() || undefined,
      target: targetInput.trim() || undefined,
      from: fromInput ? localDayStartISO(fromInput) : undefined,
      to: toInput ? localDayEndISO(toInput) : undefined,
    });
  };

  const clearFilters = () => {
    setActionFilter("all");
    setActorInput("");
    setTargetInput("");
    setFromInput("");
    setToInput("");
    setOffset(0);
    setApplied({});
  };

  // Streams the export straight to disk via a browser-native download
  // (anchor navigation + server Content-Disposition) instead of buffering
  // the whole CSV into an in-memory Blob, which could freeze the tab for
  // very large audit histories. A HEAD preflight validates auth and filters
  // first so a rejected request surfaces as a toast instead of the browser
  // saving a JSON error body as a .csv file.
  const [exporting, setExporting] = useState(false);
  const downloadCsv = async () => {
    const search = new URLSearchParams();
    if (applied.action) search.set("action", applied.action);
    if (applied.actor) search.set("actor", applied.actor);
    if (applied.target) search.set("target", applied.target);
    if (applied.from) search.set("from", applied.from);
    if (applied.to) search.set("to", applied.to);
    const qs = search.toString();
    const url = `/api/admin/audit-logs/export${qs ? `?${qs}` : ""}`;

    setExporting(true);
    try {
      const preflight = await fetch(url, {
        method: "HEAD",
        credentials: "include",
      });
      if (!preflight.ok) {
        toast({
          title: "Export failed",
          description:
            preflight.status === 401 || preflight.status === 403
              ? "You no longer have access to the audit log. Try signing in again."
              : preflight.status === 400
                ? "The current filters are invalid. Adjust them and try again."
                : `The server rejected the export (error ${preflight.status}). Try again.`,
          variant: "destructive",
        });
        return;
      }
    } catch {
      toast({
        title: "Export failed",
        description: "Could not reach the server. Check your connection and try again.",
        variant: "destructive",
      });
      return;
    } finally {
      setExporting(false);
    }

    const link = document.createElement("a");
    link.href = url;
    link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit trail</CardTitle>
        <CardDescription>
          Append-only record of privileged actions: plan overrides, superadmin
          grants/revokes, notification policy changes, and platform credential
          saves. Filter by action, actor, target, or date, and page through
          the full history.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Action</p>
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger className="w-[180px]" data-testid="select-audit-action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All actions</SelectItem>
                {Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Actor</p>
            <Input
              className="w-[180px]"
              placeholder="Email or tenant #"
              value={actorInput}
              onChange={(e) => setActorInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyFilters()}
              data-testid="input-audit-actor"
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Target</p>
            <Input
              className="w-[180px]"
              placeholder="Email or tenant #"
              value={targetInput}
              onChange={(e) => setTargetInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyFilters()}
              data-testid="input-audit-target"
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">From</p>
            <Input
              type="date"
              className="w-[150px]"
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
              data-testid="input-audit-from"
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">To</p>
            <Input
              type="date"
              className="w-[150px]"
              value={toInput}
              onChange={(e) => setToInput(e.target.value)}
              data-testid="input-audit-to"
            />
          </div>
          <Button size="sm" onClick={applyFilters} data-testid="button-audit-apply">
            Apply
          </Button>
          {hasFilters && (
            <Button
              size="sm"
              variant="ghost"
              onClick={clearFilters}
              data-testid="button-audit-clear"
            >
              Clear
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={downloadCsv}
            disabled={total === 0 || exporting}
            data-testid="button-audit-export"
          >
            Download CSV
          </Button>
        </div>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {Object.keys(applied).some(
              (k) => applied[k as keyof typeof applied],
            )
              ? "No audit records match these filters."
              : "No admin actions have been recorded yet."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {AUDIT_ACTION_LABELS[log.action] ?? log.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {log.actorEmail ?? `#${log.actorTenantId}`}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {log.targetEmail ??
                        (log.targetTenantId != null
                          ? `#${log.targetTenantId}`
                          : "—")}
                    </TableCell>
                    <TableCell>
                      {formatAuditValue(log.action, log.oldValue ?? null)}
                    </TableCell>
                    <TableCell>
                      {formatAuditValue(log.action, log.newValue ?? null)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {!isLoading && total > 0 && (
          <div className="mt-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground" data-testid="text-audit-range">
              Showing {total === 0 ? 0 : offset + 1}–
              {Math.min(offset + AUDIT_PAGE_SIZE, total)} of {total}
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0 || isFetching}
                onClick={() => setOffset(Math.max(0, offset - AUDIT_PAGE_SIZE))}
                data-testid="button-audit-prev"
              >
                Newer
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + AUDIT_PAGE_SIZE >= total || isFetching}
                onClick={() => setOffset(offset + AUDIT_PAGE_SIZE)}
                data-testid="button-audit-next"
              >
                Older
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function AuditTab() {
  return <AuditLogCard />;
}
