import { useRef, useState } from "react";
import {
  useAdminListFeatureFlags,
  useAdminUpdateFeatureFlag,
  getAdminListFeatureFlagsQueryKey,
  getListFeatureFlagsQueryKey,
  useAdminGetCreatorSettings,
  useAdminUpdateCreatorSettings,
  getAdminGetCreatorSettingsQueryKey,
} from "@workspace/api-client-react";
import type {
  CreatorSettingsView,
  CreatorSettingsUpdate,
  CreatorCommissionSlab,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, CircleDashed, Plus, RotateCcw, Trash2 } from "lucide-react";

export const CREATOR_FEATURE_KEY = "creatorProgram";

/* ---------------- conversions & validation (pure, exported for tests) --------------- */

/** Parses a decimal string with at most 2 fractional digits into an integer of hundredths. */
function toHundredths(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const n = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return Number.isSafeInteger(n) ? n : null;
}
export const percentToBps = toHundredths;
export const rupeesToPaise = toHundredths;
export function fromHundredths(n: number): string {
  const whole = Math.floor(n / 100);
  const frac = n % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0")}`;
}
export const bpsToPercent = fromHundredths;
export const paiseToRupees = fromHundredths;
export function parseIntStrict(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

type Unit = "percent" | "rupees" | "int";
type NumericKey =
  | "buyerBonusBps" | "buyerBonusExpiryDays" | "holdDays" | "consumptionThresholdBps"
  | "reserveBps" | "reserveReleaseDays" | "minPayoutPaise" | "earningExpiryDays"
  | "attributionDays" | "tdsRateBps" | "riskHoldThreshold" | "newCreatorReviewCount";

interface FieldSpec { key: NumericKey; label: string; unit: Unit; min: number; max: number; help: string; suffix: string }

export const FIELDS: FieldSpec[] = [
  { key: "buyerBonusBps", label: "Buyer bonus", unit: "percent", min: 0, max: 10000, suffix: "%", help: "Bonus credits a buyer gets on a purchase with a creator code." },
  { key: "buyerBonusExpiryDays", label: "Buyer bonus expiry", unit: "int", min: 1, max: 3650, suffix: "days", help: "Shares the promotional-credit bucket; not an exact per-grant expiry." },
  { key: "attributionDays", label: "Attribution window", unit: "int", min: 1, max: 3650, suffix: "days", help: "How long a code stays attached to a buyer." },
  { key: "holdDays", label: "Hold period", unit: "int", min: 0, max: 365, suffix: "days", help: "Commission stays pending at least this long." },
  { key: "consumptionThresholdBps", label: "Consumption threshold", unit: "percent", min: 0, max: 10000, suffix: "%", help: "Share of purchased credits the buyer must spend (cumulative net spend)." },
  { key: "reserveBps", label: "Reserve", unit: "percent", min: 0, max: 10000, suffix: "%", help: "Portion held back against refunds." },
  { key: "reserveReleaseDays", label: "Reserve release", unit: "int", min: 1, max: 3650, suffix: "days", help: "When the reserve becomes payable." },
  { key: "earningExpiryDays", label: "Earning expiry", unit: "int", min: 1, max: 3650, suffix: "days", help: "Unclaimed earnings expire after this." },
  { key: "minPayoutPaise", label: "Minimum payout", unit: "rupees", min: 0, max: 2000000000, suffix: "INR", help: "Balance needed before a creator is included in a manual batch." },
  { key: "tdsRateBps", label: "TDS rate", unit: "percent", min: 0, max: 10000, suffix: "%", help: "Withheld on payouts. Confirm with your accountant." },
  { key: "riskHoldThreshold", label: "Risk hold threshold", unit: "int", min: 0, max: 100, suffix: "score", help: "Risk score at or above which commissions are held for review." },
  { key: "newCreatorReviewCount", label: "New creator review count", unit: "int", min: 0, max: 100, suffix: "sales", help: "First N commissions for a new creator are reviewed manually." },
];

export function toDisplay(unit: Unit, v: number | undefined | null): string {
  if (v == null) return "";
  return unit === "int" ? String(v) : fromHundredths(v);
}

export function parseField(spec: FieldSpec, raw: string): { value?: number; error?: string } {
  const n = spec.unit === "int" ? parseIntStrict(raw) : toHundredths(raw);
  if (n === null) {
    return { error: spec.unit === "int" ? "Enter a whole number." : "Enter a number with up to 2 decimals." };
  }
  if (n < spec.min || n > spec.max) {
    const f = (x: number) => toDisplay(spec.unit, x);
    return { error: `Must be between ${f(spec.min)} and ${f(spec.max)}.` };
  }
  return { value: n };
}

export interface SlabDraft { minReferrals: string; commissionPercent: string }

export function parseSlabs(rows: SlabDraft[]): { value?: CreatorCommissionSlab[]; errors: string[] } {
  const errors: string[] = rows.map(() => "");
  const out: CreatorCommissionSlab[] = [];
  rows.forEach((r, i) => {
    const min = parseIntStrict(r.minReferrals);
    const bps = toHundredths(r.commissionPercent);
    if (min === null || min > 1000000) errors[i] = "Qualifying purchases must be a whole number up to 1,000,000.";
    else if (bps === null || bps > 10000) errors[i] = "Commission must be 0 to 100% with up to 2 decimals.";
    else if (i === 0 && min !== 0) errors[i] = "The first tier must start at 0 qualifying purchases.";
    else if (i > 0 && out[i - 1] && min <= out[i - 1].minReferrals) errors[i] = "Each tier must start above the previous one.";
    if (min !== null && bps !== null) out.push({ minReferrals: min, commissionBps: bps });
  });
  if (rows.length === 0) errors.push("Add at least one tier.");
  return errors.some(Boolean) ? { errors } : { value: out, errors };
}

export interface Draft {
  fields: Record<NumericKey, string>;
  slabs: SlabDraft[];
  triggerMode: string;
  autoApproveCreators: boolean;
}

export function draftFrom(s: CreatorSettingsView): Draft {
  const fields = {} as Record<NumericKey, string>;
  for (const f of FIELDS) fields[f.key] = toDisplay(f.unit, s[f.key]);
  return {
    fields,
    slabs: (s.commissionSlabs ?? []).map((r) => ({
      minReferrals: String(r.minReferrals),
      commissionPercent: fromHundredths(r.commissionBps),
    })),
    triggerMode: s.triggerMode ?? "first_purchase",
    autoApproveCreators: Boolean(s.autoApproveCreators),
  };
}

/**
 * Builds a partial update containing only fields that differ from the
 * server baseline. Never includes programEnabled or payoutCadence.
 */
export function buildPatch(
  base: CreatorSettingsView,
  draft: Draft,
): { patch?: CreatorSettingsUpdate; fieldErrors: Partial<Record<NumericKey, string>>; slabErrors: string[] } {
  const patch: CreatorSettingsUpdate = {};
  const fieldErrors: Partial<Record<NumericKey, string>> = {};
  const baseDraft = draftFrom(base);
  for (const f of FIELDS) {
    if (draft.fields[f.key] === baseDraft.fields[f.key]) continue;
    const r = parseField(f, draft.fields[f.key]);
    if (r.error) fieldErrors[f.key] = r.error;
    else if (r.value !== base[f.key]) patch[f.key] = r.value;
  }
  let slabErrors: string[] = [];
  if (JSON.stringify(draft.slabs) !== JSON.stringify(baseDraft.slabs)) {
    const r = parseSlabs(draft.slabs);
    slabErrors = r.errors;
    if (r.value && JSON.stringify(r.value) !== JSON.stringify(base.commissionSlabs ?? [])) {
      patch.commissionSlabs = r.value;
    }
  }
  if (draft.triggerMode !== baseDraft.triggerMode) {
    patch.triggerMode = draft.triggerMode as CreatorSettingsUpdate["triggerMode"];
  }
  if (draft.autoApproveCreators !== baseDraft.autoApproveCreators) {
    patch.autoApproveCreators = draft.autoApproveCreators;
  }
  const invalid = Object.keys(fieldErrors).length > 0 || slabErrors.some(Boolean);
  return { patch: invalid ? undefined : patch, fieldErrors, slabErrors };
}

/* ------------------------------------ UI ------------------------------------ */

type PendingEnable = "flag" | "settings" | null;

export function CreatorProgramTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const flagsQ = useAdminListFeatureFlags();
  const settingsQ = useAdminGetCreatorSettings();
  const updateFlag = useAdminUpdateFeatureFlag();
  const updateSettings = useAdminUpdateCreatorSettings();
  const [confirm, setConfirm] = useState<PendingEnable>(null);
  const writing = useRef(false);

  const flag = (flagsQ.data ?? []).find((f) => f.feature === CREATOR_FEATURE_KEY);
  const settings = settingsQ.data;
  const flagOn = flag?.enabled === true;
  const programOn = settings?.programEnabled === true;
  const effective = flagOn && programOn;

  const invalidateFlags = () => {
    queryClient.invalidateQueries({ queryKey: getAdminListFeatureFlagsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListFeatureFlagsQueryKey() });
  };

  const setFlag = (enabled: boolean) => {
    if (writing.current || updateFlag.isPending) return;
    writing.current = true;
    updateFlag.mutate(
      { feature: CREATOR_FEATURE_KEY, data: { enabled } },
      {
        onSuccess: () => {
          invalidateFlags();
          toast({ title: enabled ? "Module switch on" : "Module switch off" });
        },
        onError: () => {
          toast({ variant: "destructive", title: "Could not update the module switch", description: "Nothing changed. Please try again." });
        },
        onSettled: () => { writing.current = false; },
      },
    );
  };

  const setProgram = (enabled: boolean) => {
    if (writing.current || updateSettings.isPending) return;
    writing.current = true;
    updateSettings.mutate(
      { data: { programEnabled: enabled } },
      {
        onSuccess: (next) => {
          queryClient.setQueryData(getAdminGetCreatorSettingsQueryKey(), next);
          queryClient.invalidateQueries({ queryKey: getAdminGetCreatorSettingsQueryKey() });
          invalidateFlags();
          toast({ title: enabled ? "Program switch on" : "Program switch off" });
        },
        onError: () => {
          toast({ variant: "destructive", title: "Could not update the program switch", description: "Nothing changed. Please try again." });
        },
        onSettled: () => { writing.current = false; },
      },
    );
  };

  const busy = updateFlag.isPending || updateSettings.isPending;

  return (
    <div className="space-y-6" data-testid="creator-program-tab">
      <Card className="overflow-hidden">
        <CardHeader className="border-b bg-muted/30">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle className="text-xl">Creator Program activation</CardTitle>
              <CardDescription className="max-w-2xl mt-1">
                Two independent switches must both be on. The module switch controls whether
                tenants see creator routes at all; the program switch controls whether new
                purchases accrue commissions. Either one off keeps the program inactive.
              </CardDescription>
            </div>
            <div
              data-testid="status-effective"
              className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                effective
                  ? "border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
                  : "border-border bg-background text-muted-foreground"
              }`}
            >
              {flagsQ.isError || settingsQ.isError
                ? "Status unknown"
                : effective ? "Effectively active" : "Inactive"}
            </div>
          </div>
        </CardHeader>
        <CardContent className="divide-y p-0">
          <SwitchRow
            title="Module switch"
            code={`feature flag: ${CREATOR_FEATURE_KEY}`}
            description="Shows creator pages and unblocks creator API routes for every tenant."
            loading={flagsQ.isLoading}
            error={flagsQ.isError}
            onRetry={() => flagsQ.refetch()}
            missing={!flagsQ.isLoading && !flagsQ.isError && !flag}
            checked={flagOn}
            disabled={busy}
            onChange={(v) => (v ? setConfirm("flag") : setFlag(false))}
            testId="flag"
          />
          <SwitchRow
            title="Program switch"
            code="settings: programEnabled"
            description="Allows new qualifying purchases to accrue commissions and buyer bonuses."
            loading={settingsQ.isLoading}
            error={settingsQ.isError}
            onRetry={() => settingsQ.refetch()}
            missing={false}
            checked={programOn}
            disabled={busy}
            onChange={(v) => (v ? setConfirm("settings") : setProgram(false))}
            testId="program"
          />
          {!effective && (flagOn || programOn) && (
            <div className="flex items-start gap-2 px-6 py-3 text-sm text-amber-700 dark:text-amber-400" data-testid="text-partial-state">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              Only the {flagOn ? "module" : "program"} switch is on. The program stays inactive until both are on.
            </div>
          )}
        </CardContent>
      </Card>

      <ReadinessCard />

      {settingsQ.isLoading ? (
        <Card><CardContent className="space-y-3 pt-6">
          <Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" />
        </CardContent></Card>
      ) : settingsQ.isError || !settings ? (
        <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6" data-testid="error-settings">
          <span className="text-sm text-destructive">Could not load creator settings. No values are shown until they load.</span>
          <Button variant="outline" size="sm" onClick={() => settingsQ.refetch()} data-testid="button-retry-settings">
            <RotateCcw className="h-4 w-4 mr-1" /> Retry
          </Button>
        </CardContent></Card>
      ) : (
        <SettingsForm key={settings.id} settings={settings} />
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent data-testid="dialog-confirm-enable">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Turn on the {confirm === "flag" ? "module" : "program"} switch?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  {confirm === "flag"
                    ? "Creator pages and API routes become available to every tenant."
                    : "New qualifying purchases start accruing creator commissions and buyer bonuses."}
                </p>
                <p>
                  Commissions are accounting entries only. Payouts are prepared and paid manually by
                  an operator; nothing here sends money or triggers an automated bank transfer.
                </p>
                <p>
                  The program is live only when both switches are on. Turning either switch off
                  later takes effect immediately and is always safe.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-enable">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-enable"
              onClick={() => {
                if (confirm === "flag") setFlag(true);
                else if (confirm === "settings") setProgram(true);
                setConfirm(null);
              }}
            >
              Turn on
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SwitchRow(props: {
  title: string; code: string; description: string; loading: boolean; error: boolean;
  onRetry: () => void; missing: boolean; checked: boolean; disabled: boolean;
  onChange: (v: boolean) => void; testId: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{props.title}</span>
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{props.code}</code>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">{props.description}</p>
      </div>
      {props.loading ? (
        <Skeleton className="h-6 w-11" />
      ) : props.error ? (
        <Button size="sm" variant="outline" onClick={props.onRetry} data-testid={`button-retry-${props.testId}`}>
          <RotateCcw className="h-4 w-4 mr-1" /> Could not load. Retry
        </Button>
      ) : props.missing ? (
        <span className="text-sm text-muted-foreground" data-testid={`text-missing-${props.testId}`}>Flag not registered on server</span>
      ) : (
        <Switch
          checked={props.checked}
          disabled={props.disabled}
          onCheckedChange={props.onChange}
          aria-label={`Toggle ${props.title}`}
          data-testid={`switch-${props.testId}`}
        />
      )}
    </div>
  );
}

const READINESS = [
  { id: "pii-pepper", title: "Privacy hashing key (CREATOR_PII_PEPPER)", body: "Must be set through the secure secrets flow and never rotated once identities exist. This screen cannot see or verify it; do not paste it here." },
  { id: "tds", title: "TDS treatment approved by your CA", body: "Rate, thresholds and filing need written confirmation from your accountant." },
  { id: "agreement", title: "Creator agreement published", body: "Terms covering commissions, holds, reversals and manual payout must be accepted by creators." },
];

function ReadinessCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Launch readiness</CardTitle>
        <CardDescription>
          Not checked automatically. Each item stays unverified here; confirm it yourself before turning the program on.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {READINESS.map((r) => (
          <div key={r.id} className="flex items-start gap-3 rounded-md border border-dashed p-3" data-testid={`readiness-${r.id}`}>
            <CircleDashed className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-sm">{r.title}</span>
                <Badge variant="outline" className="text-amber-700 border-amber-600/40 dark:text-amber-400">Unverified</Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{r.body}</p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function SettingsForm({ settings }: { settings: CreatorSettingsView }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useAdminUpdateCreatorSettings();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(settings));
  const [errors, setErrors] = useState<{ fields: Partial<Record<NumericKey, string>>; slabs: string[] }>({ fields: {}, slabs: [] });
  const [saveError, setSaveError] = useState<string | null>(null);
  const saving = useRef(false);

  const preview = buildPatch(settings, draft);
  const dirty = !preview.patch || Object.keys(preview.patch).length > 0;

  const setField = (k: NumericKey, v: string) => {
    setDraft((d) => ({ ...d, fields: { ...d.fields, [k]: v } }));
    const spec = FIELDS.find((f) => f.key === k)!;
    setErrors((e) => ({ ...e, fields: { ...e.fields, [k]: parseField(spec, v).error } }));
  };
  const setSlabs = (slabs: SlabDraft[]) => {
    setDraft((d) => ({ ...d, slabs }));
    setErrors((e) => ({ ...e, slabs: parseSlabs(slabs).errors }));
  };

  const save = () => {
    if (saving.current || update.isPending) return;
    const r = buildPatch(settings, draft);
    setErrors({ fields: r.fieldErrors, slabs: r.slabErrors });
    if (!r.patch || Object.keys(r.patch).length === 0) return;
    saving.current = true;
    setSaveError(null);
    update.mutate(
      { data: r.patch },
      {
        onSuccess: (next) => {
          queryClient.setQueryData(getAdminGetCreatorSettingsQueryKey(), next);
          queryClient.invalidateQueries({ queryKey: getAdminGetCreatorSettingsQueryKey() });
          toast({ title: "Creator settings saved" });
        },
        onError: () => {
          setSaveError("Save failed. Your edits are kept; try again.");
          toast({ variant: "destructive", title: "Could not save creator settings" });
        },
        onSettled: () => { saving.current = false; },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Program rules</CardTitle>
        <CardDescription>Only fields you change are sent. Activation switches above are saved separately.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Commission tiers</h3>
            <Button
              size="sm" variant="outline" data-testid="button-add-slab"
              onClick={() => {
                const last = draft.slabs[draft.slabs.length - 1];
                const nextMin = last ? (parseIntStrict(last.minReferrals) ?? 0) + 1 : 0;
                setSlabs([...draft.slabs, { minReferrals: String(nextMin), commissionPercent: last?.commissionPercent ?? "0" }]);
              }}
            >
              <Plus className="h-4 w-4 mr-1" /> Add tier
            </Button>
          </div>
          <div className="rounded-md border divide-y">
            <div className="grid grid-cols-[1fr_1fr_40px] gap-3 px-3 py-2 text-xs font-medium text-muted-foreground">
              <span>From qualifying purchases</span><span>Commission %</span><span />
            </div>
            {draft.slabs.map((s, i) => (
              <div key={i} className="px-3 py-2">
                <div className="grid grid-cols-[1fr_1fr_40px] gap-3 items-center">
                  <Input
                    inputMode="numeric" value={s.minReferrals} aria-label={`Tier ${i + 1} qualifying purchases`}
                    data-testid={`input-slab-min-${i}`}
                    onChange={(e) => setSlabs(draft.slabs.map((x, j) => (j === i ? { ...x, minReferrals: e.target.value } : x)))}
                  />
                  <Input
                    inputMode="decimal" value={s.commissionPercent} aria-label={`Tier ${i + 1} commission percent`}
                    data-testid={`input-slab-percent-${i}`}
                    onChange={(e) => setSlabs(draft.slabs.map((x, j) => (j === i ? { ...x, commissionPercent: e.target.value } : x)))}
                  />
                  <Button
                    size="icon" variant="ghost" aria-label={`Remove tier ${i + 1}`} data-testid={`button-remove-slab-${i}`}
                    disabled={draft.slabs.length <= 1}
                    onClick={() => setSlabs(draft.slabs.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                {errors.slabs[i] && <p className="text-xs text-destructive mt-1" data-testid={`error-slab-${i}`}>{errors.slabs[i]}</p>}
              </div>
            ))}
            {draft.slabs.length === 0 && (
              <p className="px-3 py-3 text-sm text-muted-foreground">No tiers configured. Add one starting at 0.</p>
            )}
          </div>
        </section>

        <section className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-1">
              <Label htmlFor={`cp-${f.key}`}>{f.label}</Label>
              <div className="relative">
                <Input
                  id={`cp-${f.key}`}
                  inputMode={f.unit === "int" ? "numeric" : "decimal"}
                  value={draft.fields[f.key]}
                  onChange={(e) => setField(f.key, e.target.value)}
                  aria-invalid={Boolean(errors.fields[f.key])}
                  className="pr-14"
                  data-testid={`input-${f.key}`}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{f.suffix}</span>
              </div>
              {errors.fields[f.key]
                ? <p className="text-xs text-destructive" data-testid={`error-${f.key}`}>{errors.fields[f.key]}</p>
                : <p className="text-xs text-muted-foreground">{f.help}</p>}
            </div>
          ))}
          <div className="space-y-1">
            <Label>Commission trigger</Label>
            <Select value={draft.triggerMode} onValueChange={(v) => setDraft((d) => ({ ...d, triggerMode: v }))}>
              <SelectTrigger data-testid="select-triggerMode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="first_purchase">First purchase only</SelectItem>
                <SelectItem value="every_purchase">Every purchase in window</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Which buyer purchases earn commission.</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cp-auto-approve">Auto-approve creators</Label>
            <div className="flex h-10 items-center">
              <Switch
                id="cp-auto-approve" checked={draft.autoApproveCreators}
                onCheckedChange={(v) => setDraft((d) => ({ ...d, autoApproveCreators: v }))}
                data-testid="switch-autoApproveCreators"
              />
            </div>
            <p className="text-xs text-muted-foreground">Skip manual review of new applications.</p>
          </div>
          <div className="space-y-1">
            <Label>Payout review cadence (administrative label)</Label>
            <div className="flex h-10 items-center text-sm" data-testid="text-payoutCadence">
              {settings.payoutCadence ?? "Not set"}
            </div>
            <p className="text-xs text-muted-foreground">Metadata only. Payouts are never automatic; an operator runs each manual batch.</p>
          </div>
        </section>

        <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4">
          {saveError && <span className="text-sm text-destructive mr-auto" data-testid="error-save">{saveError}</span>}
          <Button
            variant="ghost" disabled={!dirty || update.isPending} data-testid="button-reset-settings"
            onClick={() => { setDraft(draftFrom(settings)); setErrors({ fields: {}, slabs: [] }); setSaveError(null); }}
          >
            Discard changes
          </Button>
          <Button onClick={save} disabled={!dirty || update.isPending} data-testid="button-save-settings">
            {update.isPending ? "Saving..." : "Save rules"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
