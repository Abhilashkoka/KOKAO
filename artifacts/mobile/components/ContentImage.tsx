import { useAuth } from "@clerk/expo";
import { Image } from "expo-image";
import React, { useEffect, useState } from "react";
import { ImageStyle, StyleSheet, View } from "react-native";

import colors from "@/constants/colors";

const domain = process.env.EXPO_PUBLIC_DOMAIN;

/**
 * Renders a tenant-scoped stored image (imagePath like /objects/<tenant>/uploads/<uuid>)
 * by attaching the Clerk bearer token to the storage request.
 */
export function ContentImage({
  imagePath,
  style,
}: {
  imagePath: string;
  style?: ImageStyle;
}) {
  const { getToken } = useAuth();
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    getToken().then((t) => {
      if (mounted) setToken(t);
    });
    return () => {
      mounted = false;
    };
  }, [getToken, imagePath]);

  if (!domain || !token) {
    return <View style={[styles.placeholder, style]} />;
  }

  return (
    <Image
      source={{
        uri: `https://${domain}/api/storage${imagePath}`,
        headers: { Authorization: `Bearer ${token}` },
      }}
      style={[styles.placeholder, style]}
      contentFit="cover"
      transition={150}
    />
  );
}

const styles = StyleSheet.create({
  placeholder: {
    backgroundColor: colors.light.muted,
    borderRadius: colors.radius,
    overflow: "hidden",
  },
});
