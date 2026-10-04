import { useEffect, useMemo, useState } from "react";
import {
  useCheckComplianceText,
  useDetectComplianceProfession,
  useListComplianceRulePacks,
  type BrandCompliance,
  type BrandComplianceFacts,
  type BrandKitPayload,
  type ComplianceReport,
} from "@workspace/api-client-react";
import { ShieldCheck, ShieldAlert, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

type Profession = "medical" | "chartered_accountant";
type Choice = "auto" | Profession | "none";

const LABELS: Record<Profession, string> = {
  medical: "Doctor (NMC)",
  chartered_accountant: "Chartered Accountant (ICAI)",
};

const REG_LABELS: Record<Profession, { number: string; body: string; bodyHint: string }> = {
  medical: {
    number: "Medical registration number",
    body: "Registering council",
    bodyHint: "e.g. Telangana State Medical Council / NMC",
  },
  chartered_accountant: {
    number: "ICAI membership / firm registration number",
    body: "Registering body",
    bodyHint: "ICAI",
  },
};

export function emptyComplianceFacts(): BrandComplianceFacts {
  return {
    practitioner_name: "",
    registration_number: "",
    registering_body: "",
    qualifications: [],
    services: [],
    practice_address: "",
    verified_claims: [],
  };
}

const lines = (value: string) =>
  value
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean);

/** Textarea bound to a string[] (one entry per line) that keeps blank lines while typing. */
function LinesField({
  label,
  hint,
  value,
  onChange,
  testId,
}: {
  label: string;
  hint?: string;
  value: string[];
  onChange: (next: string[]) => void;
  testId: string;
}) {
  const [text, setText] = useState(value.join("\n"));
  useEffect(() => {
    if (lines(text).join("\n") !== value.join("\n")) setText(value.join("\n"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.join("\n")]);
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">
        {label} <span className="text-muted-foreground font-normal">(one per line)</span>
      </label>
      <Textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(lines(e.target.value));
        }}
        className="resize-none min-h-[72px]"
        placeholder={hint}
        data-testid={testId}
      />
    </div>
  );
}

/**
 * Brand Kit → Compliance tab. Picks the regulated profession (auto-detected
 * from Business/Industry, confirmable / overridable), captures the verified
 * facts the AI may state, extra never-use terms, shows the rule pack, and
 * lets the user test any text against it.
 */
export function BrandComplianceSection({
  kitId,
  draft,
  onChange,
}: {
  kitId: number | null;
  draft: BrandKitPayload;
  onChange: (next: BrandCompliance | null) => void;
}) {
  const saved = draft.compliance ?? null;
  const packs = useListComplianceRulePacks();
  const detect = useDetectComplianceProfession();
  const check = useCheckComplianceText();
  const [detected, setDetected] = useState<Profession | null>(null);
  const [detecting, setDetecting] = useState(true);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [testText, setTestText] = useState("");
  const [report, setReport] = useState<ComplianceReport | null | undefined>(undefined);
  const [checkError, setCheckError] = useState<string | null>(null);

  const industry = draft.identity.industry;
  const description = draft.identity.description;
  useEffect(() => {
    let cancelled = false;
    setDetecting(true);
    setDetectError(null);
    const handle = window.setTimeout(() => {
      if (!industry.trim() && !description.trim()) {
        setDetected(null);
        setDetecting(false);
        return;
      }
      detect.mutate(
        { data: { industry, description } },
        {
          onSuccess: (r) => {
            if (cancelled) return;
            setDetected((r.profession as Profession | null) ?? null);
            setDetecting(false);
          },
          onError: (error) => {
            if (cancelled) return;
            setDetectError(apiErrorMessage(error, "Could not detect the profession. Choose it manually or reopen this tab to retry."));
            setDetecting(false);
          },
        },
      );
    }, 400);
    return () => { cancelled = true; window.clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [industry, description]);

  const choice: Choice = !saved
    ? "auto"
    : saved.profession === "none"
      ? saved.source === "manual"
        ? "none"
        : "auto"
      : saved.source === "manual"
        ? saved.profession
        : "auto";
  const effective: Profession | null =
    choice === "none"
      ? null
      : choice === "auto"
        ? saved && saved.profession !== "none"
          ? saved.profession
          : detected
        : choice;
  const confirmed = Boolean(saved?.confirmed_at) && saved?.profession === effective;
  const pack = useMemo(
    () => packs.data?.find((p) => p.profession === effective) ?? null,
    [packs.data, effective],
  );

  const base = (): BrandCompliance =>
    saved ?? {
      profession: "none",
      source: "auto",
      confirmed_at: null,
      facts: emptyComplianceFacts(),
      extra_negative_terms: [],
    };
  const setChoice = (next: Choice) => {
    const current = base();
    if (next === "auto") {
      onChange({ ...current, profession: "none", source: "auto", confirmed_at: null });
    } else {
      onChange({
        ...current,
        profession: next,
        source: "manual",
        confirmed_at: next === "none" ? null : new Date().toISOString(),
      });
    }
  };
  const confirm = () => {
    if (!effective) return;
    onChange({ ...base(), profession: effective, source: choice === "auto" ? "auto" : "manual", confirmed_at: new Date().toISOString() });
  };
  const patchFacts = (patch: Partial<BrandComplianceFacts>) => {
    const current = base();
    onChange({
      ...current,
      profession: current.profession === "none" && effective ? effective : current.profession,
      facts: { ...current.facts, ...patch },
    });
  };
  const facts = saved?.facts ?? emptyComplianceFacts();

  const runCheck = () => {
    setCheckError(null);
    check.mutate(
      {
        data: {
          text: testText,
          brandKitId: kitId,
          industry,
          restrictedTerms: draft.brand_controls.restricted_terms,
          compliance: saved,
          field: "caption",
        },
      },
      {
        onSuccess: (r) => setReport(r ?? null),
        onError: (e) => setCheckError(apiErrorMessage(e, "Could not check this text.")),
      },
    );
  };

  return (
    <div className="space-y-5" data-testid="brand-compliance">
      <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-4 space-y-3 dark:border-violet-900 dark:bg-violet-950/30">
        <div className="flex items-start gap-3">
          {effective ? (
            <ShieldCheck className="h-5 w-5 text-violet-600 mt-0.5 shrink-0" />
          ) : (
            <ShieldAlert className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
          )}
          <div className="space-y-1 text-sm">
            {effective ? (
              <>
                <p className="font-medium">
                  {LABELS[effective]} rules apply to supported content-generation workflows.
                </p>
                <p className="text-muted-foreground">
                  {choice === "auto"
                    ? `Detected from Business/Industry “${industry || description.slice(0, 40)}”.`
                    : "Set manually."}{" "}
                  {confirmed ? "Confirmed." : "Please confirm."}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">
                {choice === "none"
                  ? "Marked as not a regulated profession. No NMC / ICAI rules are applied."
                  : detecting
                    ? "Checking Business/Industry for professional rules…"
                    : detectError ?? "No regulated profession detected. Enter “Doctor” or “Chartered Accountant” in Industry, or pick one below."}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={choice} onValueChange={(v) => setChoice(v as Choice)}>
            <SelectTrigger className="w-[260px] bg-background" data-testid="select-compliance-profession">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">
                Auto-detect{detected ? ` (${LABELS[detected]})` : ""}
              </SelectItem>
              <SelectItem value="medical">{LABELS.medical}</SelectItem>
              <SelectItem value="chartered_accountant">{LABELS.chartered_accountant}</SelectItem>
              <SelectItem value="none">Not a regulated profession</SelectItem>
            </SelectContent>
          </Select>
          {effective && !confirmed && (
            <Button size="sm" onClick={confirm} data-testid="button-confirm-compliance">
              Confirm {LABELS[effective]}
            </Button>
          )}
        </div>
      </div>

      {effective && (
        <>
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium">Verified facts</p>
              <p className="text-xs text-muted-foreground">
                Provide only facts you have verified. These guide the AI; automated checks
                flag common unsupported claims but cannot verify every credential or fact.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {effective === "medical" ? "Doctor's name" : "Member / firm name"}
                </label>
                <Input
                  value={facts.practitioner_name}
                  onChange={(e) => patchFacts({ practitioner_name: e.target.value })}
                  data-testid="input-compliance-name"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{REG_LABELS[effective].number}</label>
                <Input
                  value={facts.registration_number}
                  onChange={(e) => patchFacts({ registration_number: e.target.value })}
                  data-testid="input-compliance-registration"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{REG_LABELS[effective].body}</label>
                <Input
                  value={facts.registering_body}
                  placeholder={REG_LABELS[effective].bodyHint}
                  onChange={(e) => patchFacts({ registering_body: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Practice address</label>
                <Input
                  value={facts.practice_address}
                  onChange={(e) => patchFacts({ practice_address: e.target.value })}
                />
              </div>
            </div>
            <LinesField
              label="Recognised qualifications"
              hint={effective === "medical" ? "MBBS\nMD (Dermatology)" : "FCA\nDISA (ICAI)"}
              value={facts.qualifications}
              onChange={(next) => patchFacts({ qualifications: next })}
              testId="input-compliance-qualifications"
            />
            <LinesField
              label="Services offered"
              value={facts.services}
              onChange={(next) => patchFacts({ services: next })}
              testId="input-compliance-services"
            />
            <LinesField
              label="Other verified claims"
              hint="12 years of experience"
              value={facts.verified_claims}
              onChange={(next) => patchFacts({ verified_claims: next })}
              testId="input-compliance-claims"
            />
            <LinesField
              label="Never use these words"
              hint={"miracle\npainless"}
              value={saved?.extra_negative_terms ?? []}
              onChange={(next) => onChange({ ...base(), extra_negative_terms: next })}
              testId="input-compliance-negative"
            />
          </div>

          {pack && (
            <div className="rounded-xl border border-border">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 p-3 text-left text-sm font-medium"
                onClick={() => setShowRules((v) => !v)}
                data-testid="button-toggle-compliance-rules"
              >
                <span>
                  {pack.rules.length} rules from {pack.regulator}{" "}
                  <span className="text-muted-foreground font-normal">· v{pack.version}</span>
                </span>
                {showRules ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              {showRules && (
                <div className="border-t border-border p-3 space-y-3 text-sm">
                  <p className="text-muted-foreground">{pack.summary}</p>
                  <ul className="space-y-2">
                    {pack.rules.map((rule) => (
                      <li key={rule.id} className="flex items-start gap-2">
                        <Badge
                          variant="outline"
                          className={
                            rule.severity === "block"
                              ? "border-rose-200 bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"
                              : "border-amber-200 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                          }
                        >
                          {rule.severity === "block" ? "Blocks" : "Review"}
                        </Badge>
                        <div>
                          <p className="font-medium">{rule.title}</p>
                          <p className="text-xs text-muted-foreground">{rule.source}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="text-xs text-muted-foreground space-y-1">
                    {pack.sources.map((s) => (
                      <p key={s.title}>
                        {s.url ? (
                          <a href={s.url} target="_blank" rel="noreferrer" className="underline">
                            {s.title}
                          </a>
                        ) : (
                          s.title
                        )}
                        {s.note ? ` — ${s.note}` : ""}
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <p className="text-sm font-medium">Test a caption or script</p>
            <Textarea
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
              placeholder="Paste text to check it against these rules"
              className="resize-none min-h-[80px]"
              data-testid="input-compliance-test"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={runCheck}
              disabled={!testText.trim() || check.isPending}
              data-testid="button-run-compliance-check"
            >
              {check.isPending && <RippleSpinner className="h-4 w-4 mr-2" />}
              Check
            </Button>
            {checkError && <p className="text-sm text-destructive">{checkError}</p>}
            {report !== undefined && !checkError && (
              <ComplianceFindingsList report={report} emptyLabel="No issues found." />
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            These rules reduce risk; they cannot guarantee that AI output is compliant. Review
            every video and post before publishing. This is not legal advice.
          </p>
        </>
      )}
    </div>
  );
}

/** Shared findings list (Brand Kit test box and storyboard review). */
export function ComplianceFindingsList({
  report,
  emptyLabel,
}: {
  report: ComplianceReport | null;
  emptyLabel: string;
}) {
  if (!report || report.findings.length === 0) {
    return <p className="text-sm text-emerald-700 dark:text-emerald-400">{emptyLabel}</p>;
  }
  return (
    <ul className="space-y-2 text-sm" data-testid="compliance-findings">
      {report.findings.map((f, i) => (
        <li
          key={`${f.ruleId}-${f.location}-${f.match}-${i}`}
          className={
            f.severity === "block"
              ? "rounded-lg border border-rose-200 bg-rose-50/70 p-2.5 dark:border-rose-900 dark:bg-rose-950/30"
              : "rounded-lg border border-amber-200 bg-amber-50/70 p-2.5 dark:border-amber-900 dark:bg-amber-950/30"
          }
        >
          <p className="font-medium">
            {f.severity === "block" ? "Must fix" : "Review"} · {f.title}
          </p>
          <p className="text-xs text-muted-foreground">
            {f.location} — “{f.match}” in “{f.excerpt}”
          </p>
        </li>
      ))}
    </ul>
  );
}
