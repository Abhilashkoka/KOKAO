import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CasesSection } from "./prompt-kit/cases-section";
import { TemplatesSection } from "./prompt-kit/templates-section";
import { PlaygroundSection } from "./prompt-kit/playground-section";
import { TestCasesSection } from "./prompt-kit/test-cases-section";
import { MetricsSection } from "./prompt-kit/metrics-section";

export function PromptKitTab() {
  return (
    <div className="space-y-6" data-testid="prompt-kit-tab">
      <div>
        <h2 className="text-xl font-bold tracking-tight">Prompt Kit</h2>
        <p className="text-muted-foreground mt-1">
          Governed prompt templates — case types, versions, reviews, playground,
          and usage metrics.
        </p>
      </div>

      <Tabs defaultValue="cases">
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
      </Tabs>
    </div>
  );
}
