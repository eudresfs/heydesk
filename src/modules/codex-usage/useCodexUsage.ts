import { useCallback, useEffect, useRef, useState } from "react";
import type { ShellBridge } from "../../lib/shellBridge";
import type { CodexUsageSnapshot } from "./types";

export function useCodexUsage(bridge: ShellBridge, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<CodexUsageSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const queuedRefresh = useRef(false);
  const queuedRead = useRef(false);
  const active = useRef(false);
  const latestRequest = useRef<(refresh?: boolean) => Promise<void>>();

  const request = useCallback(async (refresh = false): Promise<void> => {
    if (!bridge.desktop || !enabled) return;
    if (inFlight.current) { queuedRead.current = true; queuedRefresh.current ||= refresh; return; }
    const current = generation.current;
    inFlight.current = true;
    if (refresh) setRefreshing(true);
    try {
      const result = await (refresh ? bridge.refreshCodexUsage() : bridge.getCodexUsage());
      if (!active.current || generation.current !== current) return;
      setSnapshot(result);
      setFailed(false);
    } catch {
      if (active.current && generation.current === current) setFailed(true);
    } finally {
      inFlight.current = false;
      if (active.current) {
        if (generation.current === current) setRefreshing(false);
        if (queuedRead.current) {
          const refreshNext = queuedRefresh.current;
          queuedRead.current = false;
          queuedRefresh.current = false;
          void latestRequest.current?.(refreshNext);
        }
      }
    }
  }, [bridge, enabled]);
  latestRequest.current = request;

  useEffect(() => {
    generation.current++;
    active.current = true;
    queuedRefresh.current = false;
    queuedRead.current = false;
    setSnapshot(null);
    setFailed(false);
    setRefreshing(false);
    if (bridge.desktop && enabled) void request();
    const interval = bridge.desktop && enabled ? window.setInterval(() => { void request(); }, 5000) : undefined;
    return () => { active.current = false; generation.current++; window.clearInterval(interval); };
  }, [bridge, enabled, request]);

  return { snapshot, failed, refreshing, refresh: () => request(true) };
}
