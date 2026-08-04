import { useMemo, useState } from "react";
import {
  useListPromptCases,
  useListPromptTemplates,
  useListPromptVersions,
  useListPromptTestCases,
  useRunPromptPlayground,
  useListPromptTestRuns,
  useJudgePromptTestRun,
  getListPromptVersionsQueryKey,
  getListPromptTestCasesQueryKey,
  getListPromptTestRunsQueryKey,
  PromptTestRunJudgementPassFail,
  type PromptTestRun,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

function RunResult({ run }: { run: PromptTestRun }) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-4" data-testid="playground-result">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        {typeof run.latencyMs === "number" && (
          <span data-testid="text-run-latency">{run.latencyMs} ms</span>
        )}
        {typeof run.estimatedCostPaise === "number" && (
          <span>₹{(run.estimatedCostPaise / 100).toFixed(2)}</span>
        )}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">Compiled prompt</p>
        <pre className="max-h-60 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
          {run.compiledPrompt ?? "—"}
        </pre>
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">Model output</p>
        <pre className="max-h-60 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
          {run.outputText ?? "—"}
        </pre>
      </div>
    </div>
  );
}

export function PlaygroundSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: cases } = useListPromptCases();
  const { data: templates } = useListPromptTemplates();
  const runPlayground = useRunPromptPlayground();
  const judgeRun = useJudgePromptTestRun();

  const [templateId, setTemplateId] = useState<string>("");
  const [versionId, setVersionId] = useState<string>("");
  const [testCaseId, setTestCaseId] = useState<string>("");
  const [userInput, setUserInput] = useState("");
  const [placeholders, setPlaceholders] = useState("");
  const [lastRun, setLastRun] = useState<PromptTestRun | null>(null);

  const selectedTemplate = templates?.find((t) => String(t.id) === templateId);
  const { data: versions } = useListPromptVersions(selectedTemplate?.id ?? 0, {
    query: {
      queryKey: getListPromptVersionsQueryKey(selectedTemplate?.id ?? 0),
      enabled: Boolean(selectedTemplate),
    },
  });
  const { data: testCases } = useListPromptTestCases(
    selectedTemplate?.caseTypeId ?? 0,
    {
      query: {
        queryKey: getListPromptTestCasesQueryKey(
          selectedTemplate?.caseTypeId ?? 0,
        ),
        enabled: Boolean(selectedTemplate),
      },
    },
  );
  const numericVersionId = Number(versionId);
  const { data: pastRuns, isLoading: runsLoading } = useListPromptTestRuns(
    numericVersionId || 0,
    {
      query: {
        queryKey: getListPromptTestRunsQueryKey(numericVersionId || 0),
        enabled: numericVersionId > 0,
      },
    },
  );

  const parsedPlaceholders = useMemo(() => {
    const text = placeholders.trim();
    if (!text) return { ok: true as const, value: undefined };
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true as const, value: parsed as Record<string, unknown> };
      }
      return { ok: false as const };
    } catch {
      return { ok: false as const };
    }
  }, [placeholders]);

  const run = () => {
    if (!numericVersionId) {
      toast({
        variant: "destructive",
        title: "Pick a version",
        description: "Select a template and version to run.",
      });
      return;
    }
    if (!parsedPlaceholders.ok) {
      toast({
        variant: "destructive",
        title: "Invalid placeholders",
        description: "Placeholder values must be a valid JSON object.",
      });
      return;
    }
    const usingTestCase = testCaseId !== "";
    runPlayground.mutate(
      {
        data: {
          versionId: numericVersionId,
          testCaseId: usingTestCase ? Number(testCaseId) : null,
          input: usingTestCase
            ? undefined
            : {
                userInput,
                placeholders: parsedPlaceholders.value ?? {},
              },
        },
      },
      {
        onSuccess: (result) => {
          setLastRun(result);
          queryClient.invalidateQueries({
            queryKey: getListPromptTestRunsQueryKey(numericVersionId),
          });
          toast({ title: "Playground run complete" });
        },
        onError: (err) =>
          toast({
            variant: "destructive",
            title: "Run failed",
            description: apiErrorMessage(err, "Please try again."),
          }),
      },
    );
  };

  const judge = (runId: number, passFail: "pass" | "fail") => {
    judgeRun.mutate(
      { runId, data: { passFail } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListPromptTestRunsQueryKey(numericVersionId),
          });
          toast({ title: `Marked ${passFail}` });
        },
        onError: (err) =>
          toast({
            variant: "destructive",
            title: "Could not judge run",
            description: apiErrorMessage(err, "Please try again."),
          }),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Playground</CardTitle>
        <CardDescription>
          Run a version against sample input, inspect the compiled prompt and
          model output, and judge past runs.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Template</label>
            <Select
              value={templateId}
              onValueChange={(v) => {
                setTemplateId(v);
                setVersionId("");
                setTestCaseId("");
              }}
            >
              <SelectTrigger data-testid="select-playground-template">
                <SelectValue placeholder="Pick a template" />
              </SelectTrigger>
              <SelectContent>
                {templates?.map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>
                    {t.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Version</label>
            <Select
              value={versionId}
              onValueChange={setVersionId}
              disabled={!selectedTemplate}
            >
              <SelectTrigger data-testid="select-playground-version">
                <SelectValue placeholder="Pick a version" />
              </SelectTrigger>
              <SelectContent>
                {versions?.map((v) => (
                  <SelectItem key={v.id} value={String(v.id)}>
                    v{v.versionNo} · {v.lifecycleState}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Test case (optional)</label>
            <Select
              value={testCaseId || "none"}
              onValueChange={(v) => setTestCaseId(v === "none" ? "" : v)}
              disabled={!selectedTemplate}
            >
              <SelectTrigger data-testid="select-playground-testcase">
                <SelectValue placeholder="Ad-hoc input" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Ad-hoc input</SelectItem>
                {testCases?.map((tc) => (
                  <SelectItem key={tc.id} value={String(tc.id)}>
                    {tc.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {testCaseId === "" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Sample user input</label>
              <Textarea
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                rows={4}
                placeholder="What the user would type"
                data-testid="textarea-playground-input"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Placeholder values (JSON)
              </label>
              <Textarea
                value={placeholders}
                onChange={(e) => setPlaceholders(e.target.value)}
                rows={4}
                placeholder='{"brand": "KOKAO"}'
                data-testid="textarea-playground-placeholders"
              />
            </div>
          </div>
        )}

        <Button
          onClick={run}
          disabled={runPlayground.isPending || !numericVersionId}
          data-testid="button-run-playground"
        >
          {runPlayground.isPending ? "Running..." : "Run"}
        </Button>

        {lastRun && <RunResult run={lastRun} />}

        <div className="space-y-3">
          <p className="text-sm font-medium">Past runs</p>
          {!numericVersionId ? (
            <p className="text-sm text-muted-foreground">
              Pick a version to see its past runs.
            </p>
          ) : runsLoading || !pastRuns ? (
            <Skeleton className="h-20 w-full" />
          ) : pastRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <ul className="space-y-2">
              {pastRuns.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border p-2 text-sm"
                  data-testid={`run-${r.id}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-muted-foreground">
                      {new Date(r.createdAt).toLocaleString()}
                    </span>
                    {typeof r.latencyMs === "number" && (
                      <span className="text-muted-foreground">
                        {r.latencyMs} ms
                      </span>
                    )}
                    {r.passFail && (
                      <Badge
                        variant={
                          r.passFail === PromptTestRunJudgementPassFail.pass
                            ? "secondary"
                            : "destructive"
                        }
                        data-testid={`badge-run-passfail-${r.id}`}
                      >
                        {r.passFail}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => judge(r.id, "pass")}
                      disabled={judgeRun.isPending}
                      data-testid={`button-judge-pass-${r.id}`}
                    >
                      Pass
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => judge(r.id, "fail")}
                      disabled={judgeRun.isPending}
                      data-testid={`button-judge-fail-${r.id}`}
                    >
                      Fail
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
