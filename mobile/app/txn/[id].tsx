import React from "react";
import { useLocalSearchParams } from "expo-router";
import { Screen } from "@/components/ui";
import { TxnDetail, useTxn } from "@/components/TxnDetail";

export default function TxnScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Screen title="Transaction"><TxnDetail t={useTxn(id)} /></Screen>;
}
