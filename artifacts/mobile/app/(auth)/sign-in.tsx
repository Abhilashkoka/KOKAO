import { useSignIn } from "@clerk/expo";
import { Image } from "expo-image";
import { Link, useRouter } from "expo-router";
import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { SocialSignInButtons } from "@/components/SocialSignInButtons";
import { Button, Input, Label } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";
import { useAppBrand } from "@/lib/brand";

const c = colors.light;

export default function SignInScreen() {
  const { signIn, errors, fetchStatus } = useSignIn();
  const router = useRouter();

  const [emailAddress, setEmailAddress] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  const { appName, iconUrl, logoUrl } = useAppBrand();
  const brandImage = iconUrl || logoUrl;

  const finalizeIfComplete = async () => {
    if (signIn.status === "complete") {
      await signIn.finalize({
        navigate: () => {
          router.replace("/(tabs)");
        },
      });
      return true;
    }
    return false;
  };

  const startEmailCodeFallback = async () => {
    const { error } = await signIn.emailCode.sendCode();
    if (error) {
      setFormError(
        error.message ||
          "Additional verification is required, but we couldn't send a code. Please sign in on the web app.",
      );
      return;
    }
    setCode("");
    setVerifyingCode(true);
  };

  const handleSubmit = async () => {
    setFormError(null);
    const { error } = await signIn.password({ emailAddress, password });
    if (error) {
      setFormError(error.message || "Sign in failed. Check your credentials.");
      return;
    }

    if (await finalizeIfComplete()) {
      return;
    }

    const status = signIn.status as string;
    if (status === "needs_client_trust" || status === "needs_first_factor") {
      // New devices can require an extra verification step. Fall back to an
      // emailed one-time code so the user isn't dead-ended.
      await startEmailCodeFallback();
      return;
    }

    setFormError("Additional verification is required. Please sign in on the web app.");
  };

  const handleVerifyCode = async () => {
    setFormError(null);
    const { error } = await signIn.emailCode.verifyCode({ code });
    if (error) {
      setFormError(error.message || "That code didn't work. Check it and try again.");
      return;
    }
    if (!(await finalizeIfComplete())) {
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
      <Image
        source={brandImage ? { uri: brandImage } : require("@/assets/images/kokao-mark.png")}
        style={styles.logo}
        contentFit="contain"
      />

      {verifyingCode ? (
        <>
          <Text style={styles.title}>Check your email</Text>
          <Text style={styles.subtitle}>
            To finish signing in on this device, enter the code we sent to {emailAddress}
          </Text>

          <Label>Verification code</Label>
          <Input
            value={code}
            placeholder="Enter the 6-digit code"
            keyboardType="numeric"
            onChangeText={setCode}
          />
          {errors.fields.code ? (
            <Text style={styles.error}>{errors.fields.code.message}</Text>
          ) : null}
          {formError ? <Text style={styles.error}>{formError}</Text> : null}

          <Button
            title="Verify"
            onPress={handleVerifyCode}
            loading={fetchStatus === "fetching"}
            disabled={!code}
            style={{ marginTop: 22 }}
          />
          <Button
            title="Resend code"
            variant="secondary"
            onPress={() => signIn.emailCode.sendCode()}
            style={{ marginTop: 10 }}
          />
          <Button
            title="Back to sign in"
            variant="secondary"
            onPress={() => {
              setVerifyingCode(false);
              setFormError(null);
            }}
            style={{ marginTop: 10 }}
          />
        </>
      ) : (
        <>
          <Text style={styles.title}>Welcome back</Text>
          <Text style={styles.subtitle}>Sign in to your {appName} workspace</Text>

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

          <SocialSignInButtons onError={setFormError} />

          <View style={styles.linkRow}>
            <Text style={styles.linkText}>New to {appName}? </Text>
            <Link href="/(auth)/sign-up">
              <Text style={styles.link}>Create an account</Text>
            </Link>
          </View>
        </>
      )}

      <View nativeID="clerk-captcha" />
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 24 },
  logo: {
    width: 56,
    height: 56,
    borderRadius: 14,
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
