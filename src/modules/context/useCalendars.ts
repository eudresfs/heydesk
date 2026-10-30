// Agendas assinadas por link ICS (Google, iCloud, Outlook): só leitura, buscadas no Rust.
import { useCallback, useEffect, useState } from "react";
import type { ShellBridge } from "../../lib/shellBridge";

export interface FeedEvent { id: string; title: string; at: number; allDay: boolean; feed: string; color: string }
export interface CalendarSnapshot { events: FeedEvent[]; observedAt: number | null; errors: string[] }
export interface PublicFeed { id: string; name: string; color: string; host: string }
/** `url` ausente mantém o link já salvo. */
export interface FeedInput { id: string; name: string; color: string; url?: string }

export function useCalendars(bridge: ShellBridge) {
  const [snapshot, setSnapshot] = useState<CalendarSnapshot | null>(null);
  const [feeds, setFeeds] = useState<PublicFeed[]>([]);
  useEffect(() => { void bridge.getCalendarFeeds?.().then(setFeeds).catch(() => {}); }, [bridge]);
  useEffect(() => {
    if (!bridge.getCalendarEvents) return;
    let active = true, timer: number | undefined;
    const poll = () => bridge.getCalendarEvents!().then(value => { if (active) setSnapshot(value); }).catch(() => {})
      .finally(() => { if (active) timer = window.setTimeout(poll, 120_000); }); // o backend baixa os ICS a cada 15 min
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, [bridge]);
  const save = useCallback(async (inputs: FeedInput[]) => {
    if (!bridge.saveCalendarFeeds) throw new Error("Indisponível nesta versão.");
    const saved = await bridge.saveCalendarFeeds(inputs);
    setFeeds(saved);
    // O Rust busca logo depois de salvar; pega o resultado em alguns segundos.
    window.setTimeout(() => { void bridge.getCalendarEvents?.().then(setSnapshot).catch(() => {}); }, 4000);
    return saved;
  }, [bridge]);
  return { events: snapshot?.events ?? [], errors: snapshot?.errors ?? [], observedAt: snapshot?.observedAt ?? null, feeds, save };
}
export type CalendarsControl = ReturnType<typeof useCalendars>;
