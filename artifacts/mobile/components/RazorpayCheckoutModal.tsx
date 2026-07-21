import React, { useMemo } from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { Feather } from "@expo/vector-icons";

import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

export type CheckoutRequest =
  | {
      mode: "subscription";
      keyId: string;
      subscriptionId: string;
      title: string;
      description: string;
    }
  | {
      mode: "order";
      keyId: string;
      orderId: string;
      amountPaise: number;
      title: string;
      description: string;
    };

export type CheckoutSuccess = {
  paymentId: string;
  signature: string;
  subscriptionId?: string;
  orderId?: string;
};

type BridgeMessage =
  | ({ type: "success" } & {
      razorpay_payment_id: string;
      razorpay_signature: string;
      razorpay_subscription_id?: string;
      razorpay_order_id?: string;
    })
  | { type: "failure"; description?: string }
  | { type: "dismiss" };

function buildHtml(request: CheckoutRequest, appName: string): string {
  const options: Record<string, unknown> = {
    key: request.keyId,
    name: appName,
    description: request.description,
    ...(request.mode === "subscription"
      ? { subscription_id: request.subscriptionId }
      : {
          order_id: request.orderId,
          amount: request.amountPaise,
          currency: "INR",
        }),
  };
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<style>
  body { margin: 0; background: #ffffff; font-family: -apple-system, sans-serif; }
  .loading { padding: 48px 24px; text-align: center; color: #666; font-size: 15px; }
</style>
</head>
<body>
<div class="loading">Opening secure payment&hellip;</div>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
  function send(payload) {
    window.ReactNativeWebView.postMessage(JSON.stringify(payload));
  }
  try {
    var options = ${JSON.stringify(options)};
    options.handler = function (response) {
      response.type = "success";
      send(response);
    };
    options.modal = {
      ondismiss: function () { send({ type: "dismiss" }); },
    };
    var rzp = new Razorpay(options);
    rzp.on("payment.failed", function (response) {
      send({
        type: "failure",
        description: response && response.error && response.error.description,
      });
    });
    rzp.open();
  } catch (err) {
    send({ type: "failure", description: String(err && err.message ? err.message : err) });
  }
</script>
</body>
</html>`;
}

/**
 * Hosts Razorpay Checkout inside a WebView. On completion the page posts the
 * payment ids back; the caller verifies them server-side over the app's own
 * authenticated session — nothing from the WebView is trusted beyond the ids.
 */
export function RazorpayCheckoutModal({
  request,
  appName = "KOKAO",
  onSuccess,
  onFailure,
  onDismiss,
}: {
  request: CheckoutRequest | null;
  appName?: string;
  onSuccess: (result: CheckoutSuccess) => void;
  onFailure: (message: string) => void;
  onDismiss: () => void;
}) {
  const insets = useSafeAreaInsets();
  const html = useMemo(
    () => (request ? buildHtml(request, appName) : ""),
    [request, appName],
  );

  if (!request) return null;

  return (
    <Modal visible animationType="slide" onRequestClose={onDismiss}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>
            {request.title}
          </Text>
          <TouchableOpacity
            onPress={onDismiss}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityLabel="Close payment"
          >
            <Feather name="x" size={22} color={c.foreground} />
          </TouchableOpacity>
        </View>
        <WebView
          originWhitelist={["https://*"]}
          source={{ html, baseUrl: "https://checkout.razorpay.com" }}
          onMessage={(event) => {
            let message: BridgeMessage | null = null;
            try {
              message = JSON.parse(event.nativeEvent.data) as BridgeMessage;
            } catch {
              return;
            }
            if (!message || typeof message !== "object") return;
            if (message.type === "success") {
              if (
                typeof message.razorpay_payment_id !== "string" ||
                typeof message.razorpay_signature !== "string"
              ) {
                onFailure("Payment finished but the response was incomplete.");
                return;
              }
              onSuccess({
                paymentId: message.razorpay_payment_id,
                signature: message.razorpay_signature,
                subscriptionId:
                  typeof message.razorpay_subscription_id === "string"
                    ? message.razorpay_subscription_id
                    : undefined,
                orderId:
                  typeof message.razorpay_order_id === "string"
                    ? message.razorpay_order_id
                    : undefined,
              });
            } else if (message.type === "failure") {
              onFailure(message.description || "Payment failed. You were not charged.");
            } else if (message.type === "dismiss") {
              onDismiss();
            }
          }}
          style={styles.webview}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
    gap: 12,
  },
  title: {
    fontFamily: fonts.semiBold,
    fontSize: 15,
    color: c.foreground,
    flex: 1,
  },
  webview: { flex: 1 },
});
