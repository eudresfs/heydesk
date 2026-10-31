import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopSnapshot } from "../context/types";
import { sportsActivities, type SportsSnapshot } from "../sports/useSports";
import { advanceActivities, detectActivities, enqueueActivities, idleActivity, type Activity, type ActivityInput, type ActivityState } from "./activity";

// Liga as leituras do desktop à fila. Com a ilha aberta ou oculta nada aparece:
// o aviso já não teria onde morar e não deve esperar para surgir velho depois.
export function useActivity(snapshot: DesktopSnapshot | null, enabled: boolean, sports: SportsSnapshot | null = null, followedTeams: string[] = [], waterNudge: { id: number } | null = null, pushed: { id: number; inputs: ActivityInput[] } | null = null, mapFor?: string): Activity | null {
  const [state, setState] = useState<ActivityState>(idleActivity);
  const previous = useRef<DesktopSnapshot | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = snapshot;
    if (!enabled) return;
    const found = detectActivities(before, snapshot);
    if (found.length) setState(value => enqueueActivities(value, found, Date.now()));
  }, [snapshot, enabled]);
  const previousSports = useRef<SportsSnapshot | null>(null);
  useEffect(() => {
    const before = previousSports.current;
    previousSports.current = sports;
    if (!enabled) return;
    const found = sportsActivities(before, sports, Date.now(), followedTeams, mapFor);
    if (found.length) setState(value => enqueueActivities(value, found, Date.now()));
  }, [sports, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!enabled || !waterNudge) return;
    setState(value => enqueueActivities(value, [{ kind: "water", group: "water", icon: "drop", value: "Hora de beber água", label: "Lembrete de água", priority: 2, durationMs: 5000, width: 300, mood: "happy", tone: "neutral" }], Date.now()));
  }, [waterNudge?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!enabled || !pushed) return;
    setState(value => enqueueActivities(value, pushed.inputs, Date.now()));
  }, [pushed?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!enabled) setState(value => value.current || value.queue.length ? idleActivity : value); }, [enabled]);
  useEffect(() => {
    if (!state.current) return;
    const timer = window.setTimeout(() => setState(value => advanceActivities(value, Date.now())), Math.max(0, state.current.until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [state]);
  return enabled ? state.current : null;
}

/** Fila extra para avisos que chegam por evento (volume, rede, notificações). */
export function useActivityPush(enabled: boolean) {
  const [pending, setPending] = useState<{ id: number; inputs: ActivityInput[] } | null>(null);
  const seq = useRef(0);
  const push = useCallback((input: ActivityInput) => { if (enabled) setPending({ id: ++seq.current, inputs: [input] }); }, [enabled]);
  return { pending, push };
}
