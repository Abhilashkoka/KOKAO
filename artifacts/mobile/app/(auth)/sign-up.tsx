import { useAuth, useSignUp } from "@clerk/expo";
import { Link, useRouter } from "expo-router";
import React, { useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { SocialSignInButtons } from "@/components/SocialSignInButtons";
import { Button, Input, Label } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

export default function SignUpScreen() {
  const { signUp, errors, fetchStatus } = useSignUp();
  const { isSignedIn } = useAuth();
  const router = useRouter();

  const [emailAddress, setEmailAddress] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const insets = useSafeAreaInsets();

  const handleSubmit = async () => {
    setFormError(null);
    const { error } = await signUp.password({ emailAddress, password });
    if (error) {
      setFormError(error.message || "Sign up failed. Try a different email or password.");
      return;
    }
    await signUp.verifications.sendEmailCode();
  };

  const handleVerify = async () => {
    setFormError(null);
    await signUp.verifications.verifyEmailCode({ code });
    if (signUp.status === "complete") {
      await signUp.finalize({
        navigate: () => {
          router.replace("/(tabs)");
        },
      });
    } else {
      setFormError("Verification is not complete yet. Check the code and try again.");
    }
  };

  if (signUp.status === "complete" || isSignedIn) {
    return null;
  }

  const verifying =
    signUp.status === "missing_requirements" &&
    signUp.unverifiedFields.includes("email_address") &&
    signUp.missingFields.length === 0;

  return (
    <KeyboardAwareScrollViewCompat
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[
        styles.container,
        { paddingTop: insets.top + 64, paddingBottom: insets.bottom + 32 },
      ]}
    >
      <Image
        source={require("@/assets/images/kokao-mark.png")}
        style={styles.logo}
        resizeMode="contain"
      />

      {verifying ? (
        <>
          <Text style={styles.title}>Verify your email</Text>
          <Text style={styles.subtitle}>
            We sent a verification code to {emailAddress}
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
            onPress={handleVerify}
            loading={fetchStatus === "fetching"}
            disabled={!code}
            style={{ marginTop: 22 }}
          />
          <Button
            title="Resend code"
            variant="secondary"
            onPress={() => signUp.verifications.sendEmailCode()}
            style={{ marginTop: 10 }}
          />
        </>
      ) : (
        <>
          <Text style={styles.title}>Create your account</Text>
          <Text style={styles.subtitle}>Start creating on-brand content with KOKAO</Text>

          <Label>Email address</Label>
          <Input
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            value={emailAddress}
            placeholder="you@example.com"
            onChangeText={setEmailAddress}
          />
          {errors.fields.emailAddress ? (
            <Text style={styles.error}>{errors.fields.emailAddress.message}</Text>
          ) : null}

          <Label>Password</Label>
          <Input
            value={password}
            placeholder="Choose a password"
            secureTextEntry
            onChangeText={setPassword}
          />
          {errors.fields.password ? (
            <Text style={styles.error}>{errors.fields.password.message}</Text>
          ) : null}
          {formError ? <Text style={styles.error}>{formError}</Text> : null}

          <Button
            title="Sign up"
            onPress={handleSubmit}
            loading={fetchStatus === "fetching"}
            disabled={!emailAddress || !password}
            style={{ marginTop: 22 }}
          />

          <SocialSignInButtons onError={setFormError} />

          <View style={styles.linkRow}>
            <Text style={styles.linkText}>Already have an account? </Text>
            <Link href="/(auth)/sign-in">
              <Text style={styles.link}>Sign in</Text>
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
