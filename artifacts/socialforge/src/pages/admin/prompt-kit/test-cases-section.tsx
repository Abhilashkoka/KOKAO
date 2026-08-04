import { useState } from "react";
import {
  useListPromptCases,
  useListPromptTestCases,
  useCreatePromptTestCase,
  useUpdatePromptTestCase,
  getListPromptTestCasesQueryKey,
  type PromptTestCase,
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { Plus } from "lucide-react";

export function TestCasesSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: cases } = useListPromptCases();
  const [caseId, setCaseId] = useState<string>("");
  const numericCaseId = Number(caseId);
  const { data: testCases, isLoading } = useListPromptTestCases(
    numericCaseId || 0,
    {
      query: {
        queryKey: getListPromptTestCasesQueryKey(numericCaseId || 0),
        enabled: numericCaseId > 0,
      },
    },
  );
  const createTestCase = useCreatePromptTestCase();
  const updateTestCase = useUpdatePromptTestCase();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PromptTestCase | null>(null);
  const [title, setTitle] = useState("");
  const [inputJson, setInputJson] = useState("");
  const [expectedNotes, setExpectedNotes] = useState("");

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: getListPromptTestCasesQueryKey(numericCaseId),
    });

  const openCreate = () => {
    setEditing(null);
    setTitle("");
    setInputJson("{}");
    setExpectedNotes("");
    setDialogOpen(true);
  };

  const openEdit = (tc: PromptTestCase) => {
    setEditing(tc);
    setTitle(tc.title);
    setInputJson(JSON.stringify(tc.input, null, 2));
    setExpectedNotes(tc.expectedNotes ?? "");
    setDialogOpen(true);
  };

  const parseInput = (): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(inputJson.trim() || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  };

  const onError = (err: unknown) =>
    toast({
      variant: "destructive",
      title: "Could not save test case",
      description: apiErrorMessage(err, "Please try again."),
    });

  const submit = () => {
    if (!title.trim()) {
      toast({
        variant: "destructive",
        title: "Check the fields",
        description: "A test case needs a title.",
      });
      return;
    }
    const input = parseInput();
    if (!input) {
      toast({
        variant: "destructive",
        title: "Invalid input",
        description: "Input must be a valid JSON object.",
      });
      return;
    }
    if (editing) {
      updateTestCase.mutate(
        {
          testCaseId: editing.id,
          data: {
            title: title.trim(),
            input,
            expectedNotes: expectedNotes.trim() || null,
          },
        },
        {
          onSuccess: () => {
            refresh();
            setDialogOpen(false);
            toast({ title: "Test case saved" });
          },
          onError,
        },
      );
    } else {
      createTestCase.mutate(
        {
          caseId: numericCaseId,
          data: {
            title: title.trim(),
            input,
            expectedNotes: expectedNotes.trim() || null,
          },
        },
        {
          onSuccess: () => {
            refresh();
            setDialogOpen(false);
            toast({ title: "Test case created" });
          },
          onError,
        },
      );
    }
  };

  const archive = (tc: PromptTestCase) => {
    updateTestCase.mutate(
      { testCaseId: tc.id, data: { archived: !tc.archivedAt } },
      {
        onSuccess: () => {
          refresh();
          toast({ title: tc.archivedAt ? "Test case restored" : "Test case archived" });
        },
        onError,
      },
    );
  };

  const saving = createTestCase.isPending || updateTestCase.isPending;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Test cases</CardTitle>
            <CardDescription>
              Reusable sample inputs per case type for the playground.
            </CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <Select value={caseId} onValueChange={setCaseId}>
              <SelectTrigger
                className="w-56"
                data-testid="select-testcases-case"
              >
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
            <Button
              onClick={openCreate}
              disabled={!numericCaseId}
              data-testid="button-create-testcase"
            >
              <Plus className="h-4 w-4 mr-1" /> New test case
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!numericCaseId ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            Pick a case type to see its test cases.
          </p>
        ) : isLoading || !testCases ? (
          <Skeleton className="h-32 w-full" />
        ) : testCases.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No test cases yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Input</TableHead>
                <TableHead>Expectations</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {testCases.map((tc) => (
                <TableRow key={tc.id} data-testid={`row-testcase-${tc.id}`}>
                  <TableCell className="font-medium">
                    {tc.title}
                    {tc.archivedAt && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        (archived)
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-xs">
                    <code className="text-xs text-muted-foreground line-clamp-2 block">
                      {JSON.stringify(tc.input)}
                    </code>
                  </TableCell>
                  <TableCell className="max-w-xs text-sm text-muted-foreground">
                    {tc.expectedNotes ?? "—"}
                  </TableCell>
                  <TableCell className="text-right space-x-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEdit(tc)}
                      data-testid={`button-edit-testcase-${tc.id}`}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => archive(tc)}
                      disabled={updateTestCase.isPending}
                      data-testid={`button-archive-testcase-${tc.id}`}
                    >
                      {tc.archivedAt ? "Restore" : "Archive"}
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
            <DialogTitle>{editing ? "Edit test case" : "New test case"}</DialogTitle>
            <DialogDescription>
              Saved sample input for playground runs.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Title</label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                data-testid="input-testcase-title"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Input (JSON)</label>
              <Textarea
                value={inputJson}
                onChange={(e) => setInputJson(e.target.value)}
                rows={5}
                className="font-mono text-xs"
                placeholder='{"userInput": "..."}'
                data-testid="input-testcase-input"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Expectations</label>
              <Textarea
                value={expectedNotes}
                onChange={(e) => setExpectedNotes(e.target.value)}
                rows={2}
                data-testid="input-testcase-expected"
              />
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
              onClick={submit}
              disabled={saving}
              data-testid="button-save-testcase"
            >
              {saving ? "Saving..." : editing ? "Save changes" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
