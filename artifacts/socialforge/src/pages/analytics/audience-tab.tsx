import { useGetAudienceAnalytics } from "@workspace/api-client-react";
import {
  useAnalyticsParams,
  StatCard,
  StatGrid,
  TabLoading,
  TabError,
  NameCountTable,
  TwoColumn,
  TrendBars,
  formatNumber,
  formatPercent,
  formatDuration,
} from "./shared";

export function AudienceTab() {
  const params = useAnalyticsParams();
  const { data, isLoading, isError } = useGetAudienceAnalytics(params);

  if (isLoading) return <TabLoading />;
  if (isError || !data) return <TabError />;

  return (
    <div className="space-y-4">
      <StatGrid>
        <StatCard label="Monthly active users" value={formatNumber(data.mau)} />
        <StatCard
          label="Stickiness"
          value={formatPercent(data.stickiness)}
          hint="Daily actives as a share of monthly actives"
        />
        <StatCard label="Sessions" value={formatNumber(data.sessions)} />
        <StatCard
          label="Avg session length"
          value={formatDuration(data.avgSessionLengthSec)}
        />
      </StatGrid>
      <StatGrid>
        <StatCard label="Day 1 retention" value={formatPercent(data.retention.d1)} />
        <StatCard label="Day 7 retention" value={formatPercent(data.retention.d7)} />
        <StatCard label="Day 30 retention" value={formatPercent(data.retention.d30)} />
      </StatGrid>
      <TrendBars title="Daily active users" points={data.dau} />
      <TwoColumn>
        <NameCountTable title="Countries" rows={data.countries} nameHeader="Country" />
        <NameCountTable title="Platforms" rows={data.platforms} nameHeader="Platform" />
        <NameCountTable title="Browsers" rows={data.browsers} nameHeader="Browser" />
        <NameCountTable title="Device models" rows={data.deviceModels} nameHeader="Device" />
      </TwoColumn>
    </div>
  );
}
