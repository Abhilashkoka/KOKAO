import { useEffect, useState } from "react";
import {
  useAdminGetCreditRates,
  useAdminUpdateCreditRates,
  useAdminGetCreditMeterReport,
  useAdminPlanCreditMigration,
  useAdminRunCreditMigration,
  getAdminGetCreditRatesQueryKey,
  getAdminGetCreditMeterReportQueryKey,
  getAdminPlanCreditMigrationQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
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
import { useToast } from "@/hooks/use-toast";
import { Coins, Gauge, Plus, Trash2, ArrowRightLeft } from "lucide-react";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

/**
 * The credit rate card.
 *
 * This is what replaces per-plan quotas. Instead of "how many images does this
 * plan include", a superadmin sets what one unit of each billable action COSTS
 * in credits — per image, per caption, per second of video, per second of
 * voice, per second of lip sync — and every workspace draws from the same card.
 *
 * The anchor is 1 credit = 1 second of standard-resolution video. Every other
 * rate is set relative to that, which is what keeps a number like "0.2"
 * meaningful rather than arbitrary.
 */

type RateUnit = "item" | "second";
type MeterMode = "off" | "shadow" | "enforce";

interface RateRow {
  key: string;
  label: string;
  unit: RateUnit;
  credits: string;
  active: boolean;
  sortOrder: number;
  notes: string | null;
}

const KEY_PATTERN = /^[a-z0-9_]+$/;

const MODE_COPY: Record<MeterMode, { title: string; detail: string }> = {
  off: {
    title: "Meter off",
    detail: "Nothing is recorded and nothing is charged.",
  },
  shadow: {
    title: "Recording only",
    detail:
      "Every provider call is priced against this card and recorded — retries and failed renders included — and nobody is charged. Start here.",
  },
  enforce: {
    title: "Charging workspaces",
    detail:
      "Credits are debited before each provider call and refunded if it fails. Only switch to this once the meter totals match a provider invoice.",
  },
};

export function CreditRatesCard() {
  const { data, isLoading } = useAdminGetCreditRates();
  const update = useAdminUpdateCreditRates();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [mode, setMode] = useState<MeterMode>("shadow");
  const [rows, setRows] = useState<RateRow[]>([]);

  useEffect(() => {
    if (!data) return;
    setMode((data.mode as MeterMode) ?? "shadow");
    setRows(
      data.rates.map((r) => ({
        key: r.key,
        label: r.label,
        unit: r.unit === "second" ? "second" : "item",
        credits: String(r.credits),
        active: r.active,
        sortOrder: r.sortOrder,
        notes: r.notes ?? null,
      })),
    );
  }, [data]);

  const patchRow = (index: number, patch: Partial<RateRow>) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const removeRow = (index: number) => setRows((prev) => prev.filter((_, i) => i !== index));

  const addRow = () =>
    setRows((prev) => [
      ...prev,
      {
        key: "",
        label: "",
        unit: "item" as RateUnit,
        credits: "0",
        active: true,
        sortOrder: prev.reduce((max, r) => Math.max(max, r.sortOrder), 0) + 10,
        notes: null,
      },
    ]);

  const handleSave = () => {
    const cleaned = rows.map((r) => ({ ...r, key: r.key.trim(), label: r.label.trim() }));

    if (cleaned.some((r) => !KEY_PATTERN.test(r.key))) {
      toast({
        title: "Check the keys",
        description:
          "A key is what the meter looks up in code. Lowercase letters, digits and underscores only.",
        variant: "destructive",
      });
      return;
    }
    if (cleaned.some((r) => r.label.length === 0)) {
      toast({
        title: "Every rate needs a label",
        description: "The label is what you'll read on this screen later.",
        variant: "destructive",
      });
      return;
    }
    const keys = cleaned.map((r) => r.key);
    const duplicate = keys.find((k, i) => keys.indexOf(k) !== i);
    if (duplicate) {
      toast({
        title: "Duplicate key",
        description: `"${duplicate}" appears more than once. Each key can only be priced once.`,
        variant: "destructive",
      });
      return;
    }

    update.mutate(
      {
        data: {
          mode,
          rates: cleaned.map((r) => ({
            key: r.key,
            label: r.label,
            unit: r.unit,
            credits: Math.max(0, Number(r.credits) || 0),
            active: r.active,
            sortOrder: r.sortOrder,
            notes: r.notes,
          })),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Rate card saved" });
          queryClient.invalidateQueries({ queryKey: getAdminGetCreditRatesQueryKey() });
        },
        onError: (error) =>
          toast({
            title: "Could not save",
            description: apiErrorMessage(error, "Please try again."),
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Card className="border-border shadow-sm" data-testid="card-credit-rates">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Coins className="h-5 w-5 text-primary" /> Credit rate card
        </CardTitle>
        <CardDescription>
          What one unit of each billable action costs in credits — per image,
          per caption, per second of video, voice or lip sync. The anchor is 1
          credit = 1 second of standard-resolution video; price everything else
          relative to that. Add a row for any new cost centre; the meter starts
          using it as soon as code passes the matching key.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <>
            <div className="space-y-2 rounded-md border border-border p-3">
              <Label htmlFor="meter-mode">Meter mode</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as MeterMode)}>
                <SelectTrigger id="meter-mode" className="max-w-xs" data-testid="select-meter-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="shadow">Record only (shadow)</SelectItem>
                  <SelectItem value="enforce">Charge workspaces (enforce)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-sm font-medium">{MODE_COPY[mode].title}</p>
              <p className="text-sm text-muted-foreground">{MODE_COPY[mode].detail}</p>
            </div>

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[150px]">Action</TableHead>
                    <TableHead className="min-w-[110px]">Key</TableHead>
                    <TableHead className="min-w-[110px]">Per</TableHead>
                    <TableHead className="min-w-[110px]">Credits</TableHead>
                    <TableHead className="min-w-[70px]">On</TableHead>
                    <TableHead className="w-[52px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, index) => (
                    <TableRow key={`${row.key}-${index}`}>
                      <TableCell>
                        <Input
                          aria-label="Action label"
                          value={row.label}
                          onChange={(e) => patchRow(index, { label: e.target.value })}
                          data-testid={`input-rate-label-${index}`}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          aria-label="Rate key"
                          value={row.key}
                          onChange={(e) => patchRow(index, { key: e.target.value })}
                          className="font-mono text-xs"
                          data-testid={`input-rate-key-${index}`}
                        />
                      </TableCell>
                      <TableCell>
                        <Select
                          value={row.unit}
                          onValueChange={(v) => patchRow(index, { unit: v as RateUnit })}
                        >
                          <SelectTrigger data-testid={`select-rate-unit-${index}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="item">item</SelectItem>
                            <SelectItem value="second">second</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Input
                          aria-label="Credits per unit"
                          type="number"
                          min={0}
                          step="0.01"
                          value={row.credits}
                          onChange={(e) => patchRow(index, { credits: e.target.value })}
                          data-testid={`input-rate-credits-${index}`}
                        />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={row.active}
                          onCheckedChange={(v) => patchRow(index, { active: v })}
                          data-testid={`switch-rate-active-${index}`}
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeRow(index)}
                          aria-label={`Remove ${row.label || "rate"}`}
                          data-testid={`button-remove-rate-${index}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={addRow} data-testid="button-add-rate">
                <Plus className="mr-2 h-4 w-4" /> Add a cost centre
              </Button>
              <Button
                onClick={handleSave}
                disabled={update.isPending}
                data-testid="button-save-credit-rates"
              >
                {update.isPending ? "Saving..." : "Save rate card"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * What the meter has actually seen.
 *
 * Read the failed column first: those are provider calls that were billed and
 * then threw — a rejected render, a retried keyframe. Nothing else in the app
 * records them, because usage is only written on success.
 *
 * The provider token and USD columns are what make this reconcilable against
 * an invoice. Atlas bills Seedance by output token, and one clip's token count
 * swings by an order of magnitude with resolution — invisible if you only
 * record duration.
 */
export function CreditMeterReportCard() {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useAdminGetCreditMeterReport({ days });
  const queryClient = useQueryClient();

  const rows = data?.rows ?? [];

  return (
    <Card className="border-border shadow-sm" data-testid="card-credit-meter-report">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-primary" /> What the meter recorded
        </CardTitle>
        <CardDescription>
          Every metered provider call, priced against the rate card and grouped
          by action, provider and model. Compare the totals against a provider
          invoice before switching the meter to enforce.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="meter-days">Window (days)</Label>
            <Input
              id="meter-days"
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) =>
                setDays(Math.min(365, Math.max(1, Number(e.target.value) || 30)))
              }
              className="w-28"
              data-testid="input-meter-days"
            />
          </div>
          <Button
            variant="outline"
            onClick={() =>
              queryClient.invalidateQueries({
                queryKey: getAdminGetCreditMeterReportQueryKey({ days }),
              })
            }
            data-testid="button-refresh-meter"
          >
            Refresh
          </Button>
          {data ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={data.mode === "off" ? "secondary" : "default"}>
                meter {data.mode}
              </Badge>
              <Badge variant="secondary" data-testid="badge-meter-total-credits">
                {data.totalCredits.toFixed(2)} credits
              </Badge>
              {typeof data.totalProviderUsd === "number" ? (
                <Badge variant="secondary" data-testid="badge-meter-provider-usd">
                  ${data.totalProviderUsd.toFixed(2)} reported by providers
                </Badge>
              ) : null}
              <Badge
                variant={data.failedCalls > 0 ? "destructive" : "secondary"}
                data-testid="badge-meter-failed"
              >
                {data.failedCalls} failed of {data.totalCalls}
              </Badge>
            </div>
          ) : null}
        </div>

        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-meter-empty">
            Nothing recorded in this window yet. Generate something with the
            meter on and it will show up here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Units</TableHead>
                  <TableHead className="text-right">Credits</TableHead>
                  <TableHead className="text-right">Provider tokens</TableHead>
                  <TableHead className="text-right">Provider $</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, i) => (
                  <TableRow key={`${row.rateKey}-${row.provider ?? ""}-${row.model ?? ""}-${i}`}>
                    <TableCell className="font-mono text-xs">{row.rateKey}</TableCell>
                    <TableCell className="text-muted-foreground">{row.provider ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{row.model ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.calls}</TableCell>
                    <TableCell
                      className={
                        row.failedCalls > 0
                          ? "text-right tabular-nums text-destructive"
                          : "text-right tabular-nums"
                      }
                    >
                      {row.failedCalls}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.quantity.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.credits.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {typeof row.providerTokens === "number"
                        ? row.providerTokens.toLocaleString()
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {typeof row.providerUsd === "number"
                        ? `$${row.providerUsd.toFixed(2)}`
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Move every existing workspace onto credits.
 *
 * The dry run writes nothing and is the only safe way to read what a migration
 * will do. Conversion rounds up and lands in the never-expiring bucket: these
 * people bought under different terms, and attaching a new deadline after the
 * fact would be changing the deal.
 */
export function CreditMigrationCard() {
  const { data, isLoading } = useAdminPlanCreditMigration();
  const run = useAdminRunCreditMigration();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmed, setConfirmed] = useState(false);

  const rows = data?.rows ?? [];

  return (
    <Card className="border-border shadow-sm" data-testid="card-credit-migration">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArrowRightLeft className="h-5 w-5 text-primary" /> Migrate workspaces to credits
        </CardTitle>
        <CardDescription>
          Converts quota, credit-pack and rupee-wallet workspaces onto one
          credit balance. Rounds up, never expires, and skips any workspace that
          already has an account — so a partial run can simply be repeated.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-migration-empty">
            Nothing left to migrate. Every workspace either has a credit account
            already or holds no convertible balance.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" data-testid="badge-migration-workspaces">
                {data?.workspaces ?? rows.length} workspaces
              </Badge>
              <Badge variant="default" data-testid="badge-migration-credits">
                {(data?.totalCredits ?? 0).toFixed(2)} credits would be granted
              </Badge>
            </div>
            <div className="max-h-72 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workspace</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>Holding</TableHead>
                    <TableHead className="text-right">Credits</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.tenantId}>
                      <TableCell className="tabular-nums">#{row.tenantId}</TableCell>
                      <TableCell>{row.plan}</TableCell>
                      <TableCell className="font-mono text-xs">{row.source}</TableCell>
                      <TableCell className="text-muted-foreground">{row.detail}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.credits.toFixed(2)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center gap-3">
              <Switch
                checked={confirmed}
                onCheckedChange={setConfirmed}
                data-testid="switch-confirm-migration"
              />
              <span className="text-sm">
                I have read the plan above and want to grant these credits
              </span>
            </div>
            <Button
              disabled={!confirmed || run.isPending}
              onClick={() =>
                run.mutate(undefined, {
                  onSuccess: (result) => {
                    toast({
                      title: "Migration complete",
                      description: `${result.migrated.length} workspaces, ${result.totalCreditsGranted.toFixed(2)} credits granted.`,
                    });
                    queryClient.invalidateQueries({
                      queryKey: getAdminPlanCreditMigrationQueryKey(),
                    });
                  },
                  onError: (error) =>
                    toast({
                      title: "Migration failed",
                      description: apiErrorMessage(error, "Please try again."),
                      variant: "destructive",
                    }),
                })
              }
              data-testid="button-run-migration"
            >
              {run.isPending ? "Migrating..." : "Run migration"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
