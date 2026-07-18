import React, { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Button, Card, Chip } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

const PLATFORMS = ["instagram", "facebook", "linkedin", "x", "threads"];
const MINUTES = [0, 15, 30, 45];

type Props = {
  defaultPlatform?: string;
  pending?: boolean;
  onConfirm: (platform: string, scheduledAt: Date) => void;
  onCancel: () => void;
};

function dayLabel(d: Date, index: number) {
  if (index === 0) return "Today";
  if (index === 1) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export function SchedulePicker({ defaultPlatform, pending, onConfirm, onCancel }: Props) {
  const days = useMemo(() => {
    const list: Date[] = [];
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    for (let i = 0; i < 7; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      list.push(d);
    }
    return list;
  }, []);

  const defaultHour = Math.min(23, new Date().getHours() + 1);
  const [dayIndex, setDayIndex] = useState(0);
  const [hour, setHour] = useState(defaultHour);
  const [minute, setMinute] = useState(0);
  const [platform, setPlatform] = useState(
    defaultPlatform && PLATFORMS.includes(defaultPlatform) ? defaultPlatform : PLATFORMS[0]!,
  );

  const scheduledAt = useMemo(() => {
    const d = new Date(days[dayIndex]!);
    d.setHours(hour, minute, 0, 0);
    return d;
  }, [days, dayIndex, hour, minute]);

  const inPast = scheduledAt.getTime() <= Date.now();

  return (
    <Card style={{ marginTop: 12 }}>
      <Text style={styles.title}>When should this post go out?</Text>

      <Text style={styles.section}>Day</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.row}>
          {days.map((d, i) => (
            <Chip
              key={d.toISOString()}
              label={dayLabel(d, i)}
              selected={dayIndex === i}
              onPress={() => setDayIndex(i)}
            />
          ))}
        </View>
      </ScrollView>

      <Text style={styles.section}>Hour</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.row}>
          {Array.from({ length: 24 }, (_, h) => (
            <Chip
              key={h}
              label={`${String(h).padStart(2, "0")}:00`}
              selected={hour === h}
              onPress={() => setHour(h)}
            />
          ))}
        </View>
      </ScrollView>

      <Text style={styles.section}>Minutes</Text>
      <View style={styles.row}>
        {MINUTES.map((m) => (
          <Chip
            key={m}
            label={`:${String(m).padStart(2, "0")}`}
            selected={minute === m}
            onPress={() => setMinute(m)}
          />
        ))}
      </View>

      <Text style={styles.section}>Platform</Text>
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        {PLATFORMS.map((p) => (
          <Chip key={p} label={p} selected={platform === p} onPress={() => setPlatform(p)} />
        ))}
      </View>

      <Text style={styles.summary}>
        {`Scheduled for ${scheduledAt.toLocaleString(undefined, {
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })}`}
      </Text>
      {inPast ? (
        <Text style={styles.warn}>That time has already passed. Pick a time in the future.</Text>
      ) : null}

      <View style={[styles.row, { marginTop: 12 }]}>
        <Button
          title="Schedule"
          icon="clock"
          onPress={() => onConfirm(platform, scheduledAt)}
          loading={pending}
          disabled={inPast || pending}
          style={{ flex: 1 }}
        />
        <Button
          title="Cancel"
          variant="secondary"
          onPress={onCancel}
          disabled={pending}
          style={{ flex: 1 }}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  title: {
    fontFamily: fonts.semiBold,
    fontSize: 15,
    color: c.foreground,
  },
  section: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 12,
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: "row",
    gap: 8,
  },
  summary: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: c.foreground,
    marginTop: 12,
  },
  warn: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.destructive,
    marginTop: 4,
  },
});
