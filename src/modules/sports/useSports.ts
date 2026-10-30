import { useCallback, useEffect, useMemo, useState } from "react";
import type { ShellBridge } from "../../lib/shellBridge";
import type { ActivityInput } from "../activity/activity";

export interface SportSide { id: string; name: string; short: string; logo: string | null; score: string | null }
export interface SportGame { id: string; league: string; leagueName: string; start: number; state: "pre" | "in" | "post"; detail: string; clock: string | null; home: SportSide; away: SportSide; followed: boolean; maps?: MapInfo[]; pinned?: boolean }
export interface MapInfo { name: string | null; result: "home" | "away" | "done" | "live" | "pending"; homeRounds: number | null; awayRounds: number | null }
export interface SportsSnapshot { games: SportGame[]; observedAt: number | null; errors: string[] }
export interface SportsConfig { leagues: string[]; teams: string[]; hasToken: boolean }
export type SportsCatalog = [id: string, name: string, kind: string][];
export interface TeamOption { id: string; name: string; logo: string | null }

/** Próximo aviso antes do jogo: 30 e 5 minutos antes do início. */
export function kickoffAlert(game: SportGame, now: number): 30 | 5 | null {
  if (game.state !== "pre" || !game.followed) return null;
  const minutes = (game.start - now) / 60_000;
  if (minutes > 4 && minutes <= 5) return 5;
  if (minutes > 29 && minutes <= 30) return 30;
  return null;
}

export function kickoffLabel(start: number, now: number) {
  const date = new Date(start), today = new Date(now);
  const time = date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return `hoje ${time}`;
  const tomorrow = new Date(now + 86_400_000);
  if (date.toDateString() === tomorrow.toDateString()) return `amanhã ${time}`;
  return `${date.toLocaleDateString("pt-BR", { weekday: "short", day: "numeric" }).replace(".", "")} ${time}`;
}

export function useSports(bridge: ShellBridge, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<SportsSnapshot | null>(null);
  const [config, setConfig] = useState<SportsConfig | null>(null);
  const [catalog, setCatalog] = useState<SportsCatalog>([]);
  useEffect(() => {
    if (!bridge.getSportsConfig) return;
    void bridge.getSportsConfig().then(([value, list]) => { setConfig(value); setCatalog(list); }).catch(() => {});
  }, [bridge]);
  useEffect(() => {
    if (!enabled || !bridge.getSports) return;
    let active = true, timer: number | undefined;
    const poll = () => bridge.getSports!().then(value => { if (active) setSnapshot(value); }).catch(() => {})
      .finally(() => { if (active) timer = window.setTimeout(poll, 30_000); }); // o backend atualiza a cada 30 s
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, [bridge, enabled]);
  // Jogo acompanhado: qualquer partida vira "seguida" (notch, avisos), mesmo sem time marcado.
  const [pinned, setPinned] = useState<string | null>(() => { try { return localStorage.getItem("heydesk.sports.pinned"); } catch { return null; } });
  const togglePin = useCallback((id: string) => setPinned(current => {
    const next = current === id ? null : id;
    try { if (next) localStorage.setItem("heydesk.sports.pinned", next); else localStorage.removeItem("heydesk.sports.pinned"); } catch {}
    return next;
  }), []);
  const view = useMemo<SportsSnapshot | null>(() => snapshot && pinned
    ? { ...snapshot, games: snapshot.games.map(game => game.id === pinned ? { ...game, followed: true, pinned: true } : game) } : snapshot, [snapshot, pinned]);
  const save = useCallback(async (leagues: string[], teams: string[], token?: string) => {
    if (!bridge.saveSportsConfig) return;
    setConfig(await bridge.saveSportsConfig(leagues, teams, token));
  }, [bridge]);
  return { snapshot: view, config, catalog, save, pinned, togglePin, available: Boolean(bridge.desktop && bridge.getSports) };
}
export type SportsControl = ReturnType<typeof useSports>;

/** Placar que mudou em jogo seguido vira aviso; o mascote comemora gol do time seguido. */
export function sportsActivities(previous: SportsSnapshot | null, next: SportsSnapshot | null, now: number, followedTeams: string[]): ActivityInput[] {
  if (!previous || !next) return [];
  const found: ActivityInput[] = [];
  for (const game of next.games) {
    if (!game.followed) continue;
    const before = previous.games.find(item => item.id === game.id);
    const scoreline = `${game.home.short} ${game.home.score ?? 0}–${game.away.score ?? 0} ${game.away.short}`;
    if (before && game.state === "in" && (before.home.score !== game.home.score || before.away.score !== game.away.score)) {
      const homeUp = Number(game.home.score ?? 0) > Number(before.home.score ?? 0);
      const scorer = homeUp ? game.home : game.away;
      const ours = followedTeams.includes(`${game.league}|${scorer.id}`);
      found.push({ kind: "score", group: "sport", icon: "ball", value: scoreline, label: `Ponto de ${scorer.name}`, priority: 4, durationMs: 6000, width: 320, mood: ours ? "happy" : "worried", tone: ours ? "ok" : "neutral" });
    }
    const alert = kickoffAlert(game, now);
    const already = before && kickoffAlert(before, previous.observedAt ?? now - 30_000) === alert;
    if (alert && !already) found.push({ kind: "kickoff", group: "sport", icon: "ball", value: `${game.home.short} × ${game.away.short} em ${alert} min`, label: game.leagueName, priority: 2, durationMs: 6000, width: 320, mood: "wide", tone: "neutral" });
  }
  return found;
}
