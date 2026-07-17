import React from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  TWEET_MAX_LENGTH,
  isOverTweetLimit,
  tweetOverBy,
  splitIntoTweets,
  THREADS_MAX_LENGTH,
  chunkOnWhitespace,
  LINKEDIN_MAX_LENGTH,
  isOverLinkedinLimit,
  splitForLinkedin,
} from "@workspace/social-limits";

import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

export function CaptionSplitHints({ text, platform }: { text: string; platform: string }) {
  const captionText = text.trim();
  if (!["x", "threads", "linkedin"].includes(platform)) return null;

  const showX = platform === "x";
  const showThreads = platform === "x" || platform === "threads";
  const showLinkedin = platform === "x" || platform === "linkedin";

  const overX = isOverTweetLimit(captionText);
  const overThreads = captionText.length > THREADS_MAX_LENGTH;
  const threadsChunks = overThreads ? chunkOnWhitespace(captionText, THREADS_MAX_LENGTH) : [];
  const overLinkedin = isOverLinkedinLimit(captionText);
  const liComments = overLinkedin ? splitForLinkedin(captionText).comments.length : 0;

  return (
    <View style={{ marginTop: 10, gap: 3 }}>
      {showX ? (
        <Text style={[styles.limitHint, overX && styles.limitHintOver]}>
          {captionText.length} / {TWEET_MAX_LENGTH} characters for X
          {overX
            ? ` \u2014 ${tweetOverBy(captionText)} over; will post as a thread of ${splitIntoTweets(captionText).length} tweets on X`
            : ""}
        </Text>
      ) : null}
      {showThreads ? (
        <Text style={[styles.limitHint, overThreads && styles.limitHintOver]}>
          {captionText.length} / {THREADS_MAX_LENGTH} characters for Threads
          {overThreads
            ? ` \u2014 over; will post as a chain of ${threadsChunks.length} connected posts on Threads`
            : ""}
        </Text>
      ) : null}
      {showLinkedin ? (
        <Text style={[styles.limitHint, overLinkedin && styles.limitHintOver]}>
          {captionText.length} / {LINKEDIN_MAX_LENGTH} characters for LinkedIn
          {overLinkedin
            ? ` \u2014 over; the rest will be posted as ${liComments} follow-up comment${liComments === 1 ? "" : "s"} on LinkedIn`
            : ""}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  limitHint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
    lineHeight: 17,
  },
  limitHintOver: {
    fontFamily: fonts.medium,
    color: c.destructive,
  },
});
