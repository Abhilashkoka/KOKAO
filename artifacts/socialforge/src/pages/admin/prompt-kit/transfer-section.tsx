import { useRef, useState } from "react";
import {
  exportPromptKit,
  useImportPromptKit,
  useGetPromptKitDrift,
  getGetPromptKitDriftQueryKey,
  useDismissPromptKitDrift,
  type PromptKitBundle,
  type PromptKitImportResult,
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { AlertTriangle, Download, Upload, X } from "lucide-react";

/**
 * Superadmin environment replication: download the full Prompt Kit as a JSON
 * bundle here, upload it in the other environment. Compiled-prompt logs and
 * per-user customizations are never part of the bundle.
 */
export function TransferSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const importKit = useImportPromptKit();
  const dismissDrift = useDismissPromptKitDrift();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [exporting, setExporting] = useState(false);
  const [pendingBundle, setPendingBundle] = useState<PromptKitBundle | null>(
    null,
  );
  const [lastResult, setLastResult] = useState<PromptKitImportResult | null>(
    null,
  );
  const [snoozeDialogOpen, setSnoozeDialogOpen] = useState(false);

  const { data: driftStatus, refetch: refetchDrift } = useGetPromptKitDrift({
    query: {
      queryKey: getGetPromptKitDriftQueryKey(),
      refetchOnWindowFocus: false,
      retry: false,
    },
  });

  const handleExport = async () => {
    setExporting(true);
    try {
      const bundle = await exportPromptKit();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `prompt-kit-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({
        title: "Prompt Kit exported",
        description: `${bundle.cases.length} case type${bundle.cases.length === 1 ? "" : "s"} in the bundle.`,
      });
      // Refresh drift status — a fresh export resets the baseline.
      void refetchDrift();
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Export failed",
        description: apiErrorMessage(err, "Please try again."),
      });
    } finally {
      setExporting(false);
    }
  };

  const handleFilePicked = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as PromptKitBundle;
      if (parsed?.format !== "kokao-prompt-kit" || !Array.isArray(parsed.cases)) {
        throw new Error("not a bundle");
      }
      setPendingBundle(parsed);
    } catch {
      toast({
        variant: "destructive",
        title: "Not a Prompt Kit bundle",
        description: "Choose a JSON file exported from the Prompt Kit tab.",
      });
    }
  };

  const handleImport = () => {
    if (!pendingBundle) return;
    importKit.mutate(
      { data: pendingBundle },
      {
        onSuccess: (result) => {
          setPendingBundle(null);
          setLastResult(result);
          queryClient.invalidateQueries();
          toast({
            title: result.warnings.length
              ? "Import finished with warnings"
              : "Prompt Kit imported",
            description: `${result.casesCreated + result.casesUpdated} case type(s), ${result.versionsCreated + result.versionsUpdated} version(s), ${result.promotionsApplied} promotion(s) applied.`,
          });
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Import failed",
            description: apiErrorMessage(err, "Please check the bundle file."),
          });
        },
      },
    );
  };

  const handleDismiss = () => {
    dismissDrift.mutate(
      { data: {} },
      {
        onSuccess: () => void refetchDrift(),
        onError: (err) =>
          toast({
            variant: "destructive",
            title: "Could not dismiss",
            description: apiErrorMessage(err, "Please try again."),
          }),
      },
    );
  };

  const handleSnooze = (days: number) => {
    const snoozeUntil = new Date();
    snoozeUntil.setDate(snoozeUntil.getDate() + days);
    dismissDrift.mutate(
      { data: { snoozeUntil: snoozeUntil.toISOString() } },
      {
        onSuccess: () => {
          setSnoozeDialogOpen(false);
          void refetchDrift();
          toast({
            title: "Drift alert snoozed",
            description: `You won't be reminded again for ${days} day${days === 1 ? "" : "s"}.`,
          });
        },
        onError: (err) =>
          toast({
            variant: "destructive",
            title: "Could not snooze",
            description: apiErrorMessage(err, "Please try again."),
          }),
      },
    );
  };

  // Show the drift banner when there IS drift AND it's not currently snoozed/dismissed.
  const showDriftBanner =
    driftStatus != null &&
    !driftStatus.neverExported &&
    driftStatus.hasDrift &&
    !driftStatus.isSnoozed &&
    driftStatus.dismissedAt == null;

  const formattedExportedAt = driftStatus?.lastExportedAt
    ? new Date(driftStatus.lastExportedAt).toLocaleString()
    : null;

  return (
    <Card data-testid="prompt-kit-transfer">
      <CardHeader>
        <CardTitle>Export / import</CardTitle>
        <CardDescription>
          Move the entire Prompt Kit — case types, templates, versions, and
          production promotions — between environments. Download the bundle
          here, then upload it in the other environment. Re-importing updates
          in place and never duplicates. Usage logs and users&apos; personal
          customizations are not included.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {showDriftBanner && (
          <Alert
            variant="destructive"
            className="relative"
            data-testid="prompt-kit-drift-banner"
          >
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Prompt Kit out of sync</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                {driftStatus.driftItems.length} template
                {driftStatus.driftItems.length === 1 ? "" : "s"} changed since
                the last export
                {formattedExportedAt ? ` (${formattedExportedAt})` : ""}. Re‑export
                this bundle and import it into the other environment to keep
                production up to date.
              </p>
              {driftStatus.driftItems.length > 0 && (
                <ul className="list-disc list-inside text-xs space-y-0.5">
                  {driftStatus.driftItems.slice(0, 5).map((item) => (
                    <li key={item.templateId} data-testid="drift-item">
                      <span className="font-medium">{item.caseName}</span>
                      {" — "}
                      {item.reason === "new_template"
                        ? `"${item.templateTitle}" (new template, not yet exported)`
                        : item.reason === "removed"
                          ? `"${item.templateTitle}" archived after last export (was v${item.lastExportedVersionNo ?? "?"})`
                          : `"${item.templateTitle}" promoted to v${item.currentVersionNo ?? "?"} (last export: v${item.lastExportedVersionNo ?? "none"})`}
                    </li>
                  ))}
                  {driftStatus.driftItems.length > 5 && (
                    <li className="text-muted-foreground">
                      …and {driftStatus.driftItems.length - 5} more
                    </li>
                  )}
                </ul>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => setSnoozeDialogOpen(true)}
                  disabled={dismissDrift.isPending}
                  data-testid="button-snooze-drift"
                >
                  Snooze
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={handleDismiss}
                  disabled={dismissDrift.isPending}
                  data-testid="button-dismiss-drift"
                >
                  Dismiss
                </Button>
              </div>
            </AlertDescription>
            {/* Close icon for quick dismiss */}
            <button
              className="absolute top-3 right-3 text-muted-foreground hover:text-foreground"
              aria-label="Dismiss drift alert"
              onClick={handleDismiss}
              disabled={dismissDrift.isPending}
              data-testid="button-dismiss-drift-x"
            >
              <X className="h-4 w-4" />
            </button>
          </Alert>
        )}

        <div className="flex flex-wrap gap-3">
          <Button
            onClick={handleExport}
            disabled={exporting}
            data-testid="button-export-prompt-kit"
          >
            <Download className="h-4 w-4 mr-1" />
            {exporting ? "Exporting..." : "Export bundle"}
          </Button>
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={importKit.isPending}
            data-testid="button-import-prompt-kit"
          >
            <Upload className="h-4 w-4 mr-1" /> Import bundle…
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            data-testid="input-import-prompt-kit-file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void handleFilePicked(file);
            }}
          />
        </div>

        {lastResult && (
          <div
            className="text-sm text-muted-foreground space-y-1"
            data-testid="text-import-result"
          >
            <p>
              Last import: {lastResult.casesCreated} case(s) created,{" "}
              {lastResult.casesUpdated} updated · {lastResult.templatesCreated}{" "}
              template(s) created, {lastResult.templatesUpdated} updated ·{" "}
              {lastResult.versionsCreated} version(s) created,{" "}
              {lastResult.versionsUpdated} updated · {lastResult.promotionsApplied}{" "}
              promotion(s) applied.
            </p>
            {lastResult.warnings.map((w, i) => (
              <p key={i} className="text-destructive" data-testid={`text-import-warning-${i}`}>
                {w}
              </p>
            ))}
          </div>
        )}
      </CardContent>

      {/* Import confirmation dialog */}
      <Dialog
        open={pendingBundle !== null}
        onOpenChange={(open) => {
          if (!open) setPendingBundle(null);
        }}
      >
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Import this Prompt Kit bundle?</DialogTitle>
            <DialogDescription>
              {pendingBundle
                ? `The bundle contains ${pendingBundle.cases.length} case type${pendingBundle.cases.length === 1 ? "" : "s"}${pendingBundle.exportedAt ? `, exported ${new Date(pendingBundle.exportedAt).toLocaleString()}` : ""}. Matching case types, templates, and versions in this environment will be updated to match the bundle, including production promotions.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingBundle(null)}
              disabled={importKit.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleImport}
              disabled={importKit.isPending}
              data-testid="button-confirm-import-prompt-kit"
            >
              {importKit.isPending ? "Importing..." : "Import bundle"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Snooze dialog */}
      <Dialog open={snoozeDialogOpen} onOpenChange={setSnoozeDialogOpen}>
        <DialogContent className="sm:max-w-[380px]">
          <DialogHeader>
            <DialogTitle>Snooze drift alert</DialogTitle>
            <DialogDescription>
              Choose how long to suppress the drift alert. You can always
              re-export at any time.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-2">
            {[
              { label: "1 day", days: 1 },
              { label: "3 days", days: 3 },
              { label: "7 days", days: 7 },
              { label: "30 days", days: 30 },
            ].map(({ label, days }) => (
              <Button
                key={days}
                variant="outline"
                onClick={() => handleSnooze(days)}
                disabled={dismissDrift.isPending}
                data-testid={`button-snooze-drift-${days}d`}
              >
                {label}
              </Button>
            ))}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setSnoozeDialogOpen(false)}
              disabled={dismissDrift.isPending}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
