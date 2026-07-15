import { useSignIn } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import { Link, useRouter } from "expo-router";
import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Button, Input, Label } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

export default function SignInScreen() {
  const { signIn, errors, fetchStatus } = useSignIn();
  const router = useRouter();

  const [emailAddress, setEmailAddress] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const insets = useSafeAreaInsets();

  const handleSubmit = async () => {
    setFormError(null);
    const { error } = await signIn.password({ emailAddress, password });
    if (error) {
      setFormError(error.message || "Sign in failed. Check your credentials.");
      return;
    }

    if (signIn.status === "complete") {
      await signIn.finalize({
        navigate: () => {
          router.replace("/(tabs)");
        },
      });
    } else {
      setFormError("Additional verification is required. Please sign in on the web app.");
    }
  };

  return (
    <KeyboardAwareScrollViewCompat
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[
        styles.container,
        { paddingTop: insets.top + 64, paddingBottom: insets.bottom + 32 },
      ]}
    >
      <View style={styles.logoBox}>
        <Feather name="zap" size={26} color="#ffffff" />
      </View>
      <Text style={styles.title}>Welcome back</Text>
      <Text style={styles.subtitle}>Sign in to your KOKAO workspace</Text>

      <Label>Email address</Label>
      <Input
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        value={emailAddress}
        placeholder="you@example.com"
        onChangeText={setEmailAddress}
      />
      {errors.fields.identifier ? (
        <Text style={styles.error}>{errors.fields.identifier.message}</Text>
      ) : null}

      <Label>Password</Label>
      <Input
        value={password}
        placeholder="Your password"
        secureTextEntry
        onChangeText={setPassword}
      />
      {errors.fields.password ? (
        <Text style={styles.error}>{errors.fields.password.message}</Text>
      ) : null}
      {formError ? <Text style={styles.error}>{formError}</Text> : null}

      <Button
        title="Sign in"
        onPress={handleSubmit}
        loading={fetchStatus === "fetching"}
        disabled={!emailAddress || !password}
        style={{ marginTop: 22 }}
      />

      <View style={styles.linkRow}>
        <Text style={styles.linkText}>New to KOKAO? </Text>
        <Link href="/(auth)/sign-up">
          <Text style={styles.link}>Create an account</Text>
        </Link>
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 24 },
  logoBox: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: c.primary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  title: { fontFamily: fonts.bold, fontSize: 28, color: c.foreground },
  subtitle: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: c.mutedForeground,
    marginTop: 6,
    marginBottom: 12,
  },
  error: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.destructive,
    marginTop: 6,
  },
  linkRow: { flexDirection: "row", justifyContent: "center", marginTop: 24 },
  linkText: { fontFamily: fonts.regular, fontSize: 14, color: c.mutedForeground },
  link: { fontFamily: fonts.semiBold, fontSize: 14, color: c.primary },
});
