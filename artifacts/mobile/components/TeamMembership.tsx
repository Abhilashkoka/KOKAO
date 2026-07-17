import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useGetMe, useLeaveTeam } from "@workspace/api-client-react";

import { Badge, Button, Card } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

const ackKey = (tenantId: number, role: string) =>
  `kokao-team-welcome-${tenantId}-${role}`;

/**
 * One-time welcome shown to invited members/admins after invite auto-accept,
 * so they know which workspace they landed in and who invited them.
 * Acknowledgement is remembered per workspace in AsyncStorage.
 */
export function TeamWelcomeModal() {
  const { data: me } = useGetMe();
  const [open, setOpen] = useState(false);

  const isInvitedUser = Boolean(me && me.team && me.team.role !== "owner");
  const tenantId = me?.tenant?.id;
  const role = me?.team?.role;

  useEffect(() => {
    if (!isInvitedUser || tenantId === undefined || !role) return;
    let cancelled = false;
    AsyncStorage.getItem(ackKey(tenantId, role))
      .then((seen) => {
        if (!cancelled && !seen) setOpen(true);
      })
      .catch(() => {
        // Storage unavailable — skip the welcome rather than loop it.
      });
    return () => {
      cancelled = true;
    };
  }, [isInvitedUser, tenantId, role]);

  if (!isInvitedUser || !me?.team) return null;

  const dismiss = () => {
    setOpen(false);
    if (tenantId !== undefined && role) {
      AsyncStorage.setItem(ackKey(tenantId, role), "1").catch(() => {
        // Ignore storage failures; worst case the welcome shows again.
      });
    }
  };

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={dismiss}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.titleRow}>
            <Feather name="users" size={20} color={c.primary} />
            <Text style={styles.title}>
              You&apos;ve joined {me.team.workspaceName || "a workspace"}
            </Text>
          </View>
          <Text style={styles.body}>
            {me.team.invitedByEmail
              ? `${me.team.invitedByEmail} invited you to this workspace.`
              : "You were invited to this workspace by its team."}{" "}
            You&apos;re a{me.team.role === "admin" ? "n admin" : " member"} here,
            so everything you see — content, brand kits, and connected accounts —
            belongs to this shared workspace. You can review your membership or
            leave the team anytime from the Home screen.
          </Text>
          <Button title="Got it" onPress={dismiss} style={{ marginTop: 18 }} />
        </View>
      </View>
    </Modal>
  );
}

/**
 * Membership details card for invited members/admins: workspace name, role,
 * inviter, joined date, and a leave-the-workspace action with confirmation.
 */
export function TeamMembershipCard() {
  const { data: me } = useGetMe();
  const queryClient = useQueryClient();
  const leaveTeam = useLeaveTeam();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const team = me?.team;
  if (!team || team.role === "owner") return null;

  const handleLeave = () => {
    setLeaveError(null);
    leaveTeam.mutate(undefined, {
      onSuccess: () => {
        setConfirmOpen(false);
        // A fresh personal workspace is auto-provisioned on the next request;
        // clearing the cache drops every query from the old workspace.
        queryClient.clear();
      },
      onError: (err: any) => {
        setLeaveError(
          err?.response?.data?.error ||
            "Could not leave the workspace. Please try again.",
        );
      },
    });
  };

  return (
    <Card style={{ marginTop: 14 }}>
      <View style={styles.cardTitleRow}>
        <Feather name="users" size={16} color={c.primary} />
        <Text style={styles.cardTitle}>Your membership</Text>
      </View>
      <Text style={styles.cardSub}>
        You&apos;re part of someone else&apos;s workspace. Everything you see in
        this app belongs to it.
      </Text>
      <View style={styles.detailBox}>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Workspace</Text>
          <Text style={styles.detailValue} numberOfLines={1}>
            {team.workspaceName || "Workspace"}
          </Text>
        </View>
        <View style={[styles.detailRow, styles.detailDivider]}>
          <Text style={styles.detailLabel}>Your role</Text>
          <Badge
            label={team.role === "admin" ? "Admin" : "Member"}
            tone="accent"
          />
        </View>
        {team.invitedByEmail ? (
          <View style={[styles.detailRow, styles.detailDivider]}>
            <Text style={styles.detailLabel}>Invited by</Text>
            <Text style={styles.detailValue} numberOfLines={1}>
              {team.invitedByEmail}
            </Text>
          </View>
        ) : null}
        {team.joinedAt ? (
          <View style={[styles.detailRow, styles.detailDivider]}>
            <Text style={styles.detailLabel}>Joined</Text>
            <Text style={styles.detailValue}>
              {new Date(team.joinedAt).toLocaleDateString()}
            </Text>
          </View>
        ) : null}
      </View>
      <Button
        title="Leave this workspace"
        variant="outline"
        icon="log-out"
        onPress={() => {
          setLeaveError(null);
          setConfirmOpen(true);
        }}
        loading={leaveTeam.isPending}
        style={{ marginTop: 14 }}
      />

      <Modal
        visible={confirmOpen}
        transparent
        animationType="fade"
        onRequestClose={() => !leaveTeam.isPending && setConfirmOpen(false)}
      >
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.title}>Leave this workspace?</Text>
            <Text style={styles.body}>
              You will immediately lose access to{" "}
              {team.workspaceName || "this workspace"} and its content.
              You&apos;ll get your own personal workspace instead, and your seat
              is freed for someone else.
            </Text>
            {leaveError ? <Text style={styles.errorText}>{leaveError}</Text> : null}
            <View style={styles.confirmRow}>
              <Pressable
                onPress={() => setConfirmOpen(false)}
                disabled={leaveTeam.isPending}
                style={({ pressed }) => [
                  styles.cancelBtn,
                  { opacity: leaveTeam.isPending ? 0.5 : pressed ? 0.85 : 1 },
                ]}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Button
                title="Leave"
                variant="destructive"
                onPress={handleLeave}
                loading={leaveTeam.isPending}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>
    </Card>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  sheet: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: c.background,
    borderRadius: colors.radius + 4,
    padding: 22,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: {
    fontFamily: fonts.bold,
    fontSize: 17,
    color: c.foreground,
    flexShrink: 1,
  },
  body: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.mutedForeground,
    lineHeight: 19,
    marginTop: 10,
  },
  errorText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: c.destructive,
    marginTop: 10,
  },
  confirmRow: { flexDirection: "row", gap: 10, marginTop: 18 },
  cancelBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: colors.radius,
    borderWidth: 1,
    borderColor: c.border,
    minHeight: 48,
  },
  cancelText: {
    fontFamily: fonts.semiBold,
    fontSize: 15,
    color: c.foreground,
  },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { fontFamily: fonts.semiBold, fontSize: 15, color: c.foreground },
  cardSub: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 4,
    lineHeight: 18,
  },
  detailBox: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    marginTop: 12,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  detailDivider: { borderTopWidth: 1, borderTopColor: c.border },
  detailLabel: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.mutedForeground,
  },
  detailValue: {
    fontFamily: fonts.semiBold,
    fontSize: 13,
    color: c.foreground,
    flexShrink: 1,
  },
});
