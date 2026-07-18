import React, { useRef, useState } from "react";
import { Platform } from "react-native";
import {
  useAudioRecorder,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import { useTranscribeAudio } from "@workspace/api-client-react";
import { Button } from "@/components/ui";

type Props = {
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
  disabled?: boolean;
};

// React Native FormData accepts { uri, name, type } file descriptors, but the
// generated API client is typed against the web File/Blob shape.
type RNFile = { uri: string; name: string; type: string };

/**
 * Record a short voice note and turn it into text via the transcribe API.
 * Native (Expo Go): expo-audio recorder writing an m4a file.
 * Web preview: browser MediaRecorder, mirroring the web app's behavior.
 */
export function VoiceNoteButton({ onTranscript, onError, disabled }: Props) {
  const transcribe = useTranscribeAudio();
  const [recording, setRecording] = useState(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const webRecorderRef = useRef<MediaRecorder | null>(null);
  const webChunksRef = useRef<BlobPart[]>([]);

  const submit = (file: RNFile | File) => {
    transcribe.mutate(
      { data: { audio: file as unknown as Blob } },
      {
        onSuccess: (result) => {
          if (result.text) {
            onTranscript(result.text);
          } else {
            onError(
              "The recording came back empty. Try speaking closer to the microphone.",
            );
          }
        },
        onError: (err) =>
          onError(
            (err as Error | null)?.message || "Could not transcribe the recording.",
          ),
      },
    );
  };

  const startNative = async () => {
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        onError("Allow microphone access to record a voice note.");
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecording(true);
    } catch {
      onError("Could not start recording. Check microphone access.");
    }
  };

  const stopNative = async () => {
    try {
      await recorder.stop();
      setRecording(false);
      const uri = recorder.uri;
      if (!uri) {
        onError("The recording could not be saved. Try again.");
        return;
      }
      const ext = uri.split(".").pop()?.toLowerCase() || "m4a";
      submit({
        uri,
        name: `voice-note.${ext}`,
        type: ext === "m4a" ? "audio/mp4" : `audio/${ext}`,
      });
    } catch {
      setRecording(false);
      onError("Could not finish the recording. Try again.");
    }
  };

  const startWeb = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      webChunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) webChunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        rec.stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const type = rec.mimeType || "audio/webm";
        const blob = new Blob(webChunksRef.current, { type });
        webChunksRef.current = [];
        if (blob.size === 0) return;
        const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        submit(new File([blob], `voice-note.${ext}`, { type }));
      };
      webRecorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      onError("Allow microphone access in your browser to record a voice note.");
    }
  };

  const stopWeb = () => {
    const rec = webRecorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  };

  const isWeb = Platform.OS === "web";

  if (transcribe.isPending) {
    return <Button title="Transcribing..." icon="mic" variant="outline" onPress={() => {}} loading />;
  }

  return recording ? (
    <Button
      title="Stop recording"
      icon="square"
      variant="destructive"
      onPress={isWeb ? stopWeb : stopNative}
    />
  ) : (
    <Button
      title="Voice note"
      icon="mic"
      variant="outline"
      onPress={isWeb ? startWeb : startNative}
      disabled={disabled}
    />
  );
}
