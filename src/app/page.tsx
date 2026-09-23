"use client";

import { useEffect, useState } from "react";
import AppShell, { type ViewKey } from "@/components/AppShell";
import ExecuteView from "@/components/ExecuteView";
import RulesView from "@/components/RulesView";
import HistoryView from "@/components/HistoryView";

export default function Home() {
  const [view, setView] = useState<ViewKey>("execute");
  const [ragOnline, setRagOnline] = useState<boolean | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // RAG 检索服务连通性探测（30s 周期）
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch("/rag-api/api/documents", { signal: AbortSignal.timeout(5000) });
        setRagOnline(res.ok);
      } catch {
        setRagOnline(false);
      }
    };
    check();
    const timer = setInterval(check, 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <AppShell view={view} onViewChange={setView} ragOnline={ragOnline}>
      {view === "execute" && <ExecuteView onExecuted={() => setRefreshTick((t) => t + 1)} />}
      {view === "rules" && <RulesView />}
      {view === "history" && <HistoryView refreshTick={refreshTick} />}
    </AppShell>
  );
}
