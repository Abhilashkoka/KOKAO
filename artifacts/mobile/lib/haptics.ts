import { Platform } from "react-native";
import * as Haptics from "expo-haptics";

/** Light impact haptic; no-op on web where expo-haptics is unavailable. */
export function haptic(): void {
  if (Platform.OS !== "web") {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }
}
