import React from "react";
import { useLocalSearchParams } from "expo-router";
import { SmartEditScreen } from "@/components/SmartEditScreen";

export default function SmartEditRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SmartEditScreen key={id} jobId={Number(id)} />;
}
