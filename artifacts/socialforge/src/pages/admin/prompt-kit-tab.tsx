import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { useGetPromptKitDrift } from "@workspace/api-client-react";
import { CasesSection } from "./prompt-kit/cases-section";
import { TemplatesSection } from "./prompt-kit/templates-section";
import { PlaygroundSection } from "./prompt-kit/playground-section";
import { TestCasesSection } from "./prompt-kit/test-cases-section";
import { MetricsSection } from "./prompt-kit/metrics-section";
import { TransferSection } from "./prompt-kit/transfer-section";

export function PromptKitTab() {
  const [activeTab, setActiveTab] = useState("cases");

  const { data: driftStatus } = useGetPromptKitDrift();

  // Show the drift indicator when there IS drift AND it's not currently snoozed/dismissed.
  const showDriftIndicator =
    driftStatus != null &&
    !driftStatus.neverExported &&
    driftStatus.hasDrift &&
    !driftStatus.isSnoozed &&
    driftStatus.dismissedAt == null;

  return (
    <div className="space-y-6" data-testid="prompt-kit-tab">
      <div>
        <h2 className="text-xl font-bold tracking-tight">Prompt Kit</h2>
        <p className="text-muted-foreground mt-1">
          Governed prompt templates — case types, versions, reviews, playground,
          and usage metrics.
        </p>
      </div>

      {showDriftIndicator && (
        <Alert
          variant="destructive"
          className="py-3 flex items-start gap-3"
          data-testid="prompt-kit-drift-header-alert"
        >
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <AlertDescription className="flex-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              <strong>Prompt Kit out of sync</strong> —{" "}
              {driftStatus.driftItems.length} template
              {driftStatus.driftItems.length === 1 ? "" : "s"} promoted to
              production since the last export.
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs border-destructive/50 hover:bg-destructive/10"
              onClick={() => setActiveTab("transfer")}
              data-testid="button-drift-go-to-transfer"
            >
              Go to Export / import
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="overflow-x-auto">
          <TabsList>
            <TabsTrigger value="cases" data-testid="tab-prompt-kit-cases">
              Case types
            </TabsTrigger>
            <TabsTrigger value="templates" data-testid="tab-prompt-kit-templates">
              Templates
            </TabsTrigger>
            <TabsTrigger
              value="playground"
              data-testid="tab-prompt-kit-playground"
            >
              Playground
            </TabsTrigger>
            <TabsTrigger
              value="test-cases"
              data-testid="tab-prompt-kit-test-cases"
            >
              Test cases
            </TabsTrigger>
            <TabsTrigger value="metrics" data-testid="tab-prompt-kit-metrics">
              Metrics
            </TabsTrigger>
            <TabsTrigger value="transfer" data-testid="tab-prompt-kit-transfer">
              Export / import
              {showDriftIndicator && (
                <span
                  className="ml-1.5 inline-flex h-2 w-2 rounded-full bg-destructive"
                  aria-label="drift detected"
                  data-testid="drift-tab-badge"
                />
              )}
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="cases" className="mt-6">
          <CasesSection />
        </TabsContent>
        <TabsContent value="templates" className="mt-6">
          <TemplatesSection />
        </TabsContent>
        <TabsContent value="playground" className="mt-6">
          <PlaygroundSection />
        </TabsContent>
        <TabsContent value="test-cases" className="mt-6">
          <TestCasesSection />
        </TabsContent>
        <TabsContent value="metrics" className="mt-6">
          <MetricsSection />
        </TabsContent>
        <TabsContent value="transfer" className="mt-6">
          <TransferSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
