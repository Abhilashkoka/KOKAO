import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from "react-native";

import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;
const r = colors.radius;

export function Button({
  title,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false,
  icon,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "destructive" | "outline";
  loading?: boolean;
  disabled?: boolean;
  icon?: keyof typeof Feather.glyphMap;
  style?: ViewStyle;
}) {
  const bg =
    variant === "primary"
      ? c.primary
      : variant === "destructive"
        ? c.destructive
        : variant === "outline"
          ? "transparent"
          : c.secondary;
  const fg =
    variant === "primary" || variant === "destructive"
      ? "#ffffff"
      : variant === "outline"
        ? c.primary
        : c.secondaryForeground;
  const isDisabled = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: bg,
          borderWidth: variant === "outline" ? 1 : 0,
          borderColor: c.primary,
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <>
          {icon ? <Feather name={icon} size={16} color={fg} /> : null}
          <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Input(props: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={c.mutedForeground}
      {...props}
      style={[styles.input, props.multiline && styles.inputMultiline, props.style]}
    />
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

export function Badge({
  label,
  tone = "muted",
}: {
  label: string;
  tone?: "muted" | "success" | "destructive" | "accent";
}) {
  const map = {
    muted: { bg: c.muted, fg: c.mutedForeground },
    success: { bg: "#e8f7ee", fg: c.success },
    destructive: { bg: "#fdecec", fg: c.destructive },
    accent: { bg: c.accent, fg: c.accentForeground },
  } as const;
  const t = map[tone];
  return (
    <View style={[styles.badge, { backgroundColor: t.bg }]}>
      <Text style={[styles.badgeText, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? c.primary : c.secondary,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.chipText,
          { color: selected ? "#ffffff" : c.secondaryForeground },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function EmptyState({
  icon,
  title,
  subtitle,
}: {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  subtitle?: string;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Feather name={icon} size={26} color={c.mutedForeground} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.emptySubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message?: string;
  onRetry: () => void;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Feather name="alert-circle" size={26} color={c.destructive} />
      </View>
      <Text style={styles.emptyTitle}>Something went wrong</Text>
      {message ? <Text style={styles.emptySubtitle}>{message}</Text> : null}
      <Button title="Retry" onPress={onRetry} variant="secondary" style={{ marginTop: 16 }} />
    </View>
  );
}

export function Skeleton({ height = 16, width, style }: { height?: number; width?: number | `${number}%`; style?: ViewStyle }) {
  return (
    <View
      style={[
        { height, width: width ?? "100%", backgroundColor: c.muted, borderRadius: 8 },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: r,
    minHeight: 48,
  },
  buttonText: { fontFamily: fonts.semiBold, fontSize: 15 },
  card: {
    backgroundColor: c.background,
    borderRadius: r + 2,
    borderWidth: 1,
    borderColor: c.border,
    padding: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: c.input,
    borderRadius: r,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: fonts.regular,
    color: c.foreground,
    backgroundColor: c.background,
    minHeight: 48,
  },
  inputMultiline: { minHeight: 110, textAlignVertical: "top", paddingTop: 12 },
  label: {
    fontFamily: fonts.semiBold,
    fontSize: 13,
    color: c.foreground,
    marginBottom: 6,
    marginTop: 14,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    alignSelf: "flex-start",
  },
  badgeText: { fontFamily: fonts.semiBold, fontSize: 11 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
  },
  chipText: { fontFamily: fonts.medium, fontSize: 13 },
  empty: { alignItems: "center", paddingVertical: 48, paddingHorizontal: 32 },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: c.muted,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  emptyTitle: {
    fontFamily: fonts.semiBold,
    fontSize: 16,
    color: c.foreground,
    textAlign: "center",
  },
  emptySubtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.mutedForeground,
    textAlign: "center",
    marginTop: 6,
    lineHeight: 19,
  },
});
