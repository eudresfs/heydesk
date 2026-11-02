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
/** CS2 ao vivo pelo HLTV: lados, placar do mapa e rounds jogados (motivo: bomb, defuse, elimination, time). */
export interface CsRound { round: number; winner: "CT" | "T"; reason: string; team?: string }
/** Lado do time no mapa ao vivo ("CT"/"TR"), comparando nomes entre bo3.gg e HLTV. */
export function csSide(live: CsLive | null | undefined, team: { name: string; short: string }): "CT" | "TR" | undefined {
  if (!live) return undefined;
  const clean = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const same = (a: string, b: string) => { const x = clean(a), y = clean(b); return !!x && !!y && (x === y || (x.length >= 4 && y.includes(x)) || (y.length >= 4 && x.includes(y))); };
  if (same(live.ctTeam, team.name) || same(live.ctTeam, team.short)) return "CT";
  if (same(live.tTeam, team.name) || same(live.tTeam, team.short)) return "TR";
  return undefined;
}
/** CS2 ao vivo: placar de rounds do mapa atual (mandante–visitante) e o nome do mapa.
 * Prefere a página da partida (HLTV, com nome do mapa); sem ela, o mapa ao vivo da lista. */
/** Placar final de mapa (MR12: 13 com o outro ≤ 11; prorrogação: 16, 19… com 2 de vantagem).
 * Entre um mapa e outro a página do HLTV ainda mostra o placar do mapa que acabou. */
export function csFinished(live: CsLive | null | undefined) {
  if (!live) return false;
  const high = Math.max(live.ctScore, live.tScore), low = Math.min(live.ctScore, live.tScore);
  return (high === 13 && low <= 11) || (high > 13 && (high - 13) % 3 === 0 && high - low >= 2);
}
/** Placares finais vistos por jogo e mapa (índice na série), para os mapas encerrados. */
const finishedMaps = new Map<string, Map<number, { name: string; home: number; away: number }>>();
export function csFinishedMap(game: SportGame, index: number) { return finishedMaps.get(game.id)?.get(index) ?? null; }

export function csMapScore(game: SportGame, live: CsLive | null | undefined): { home: number; away: number; map: string } | null {
  if (game.state !== "in") return null;
  const index = game.maps?.findIndex(map => map.result === "live") ?? -1;
  // Com a lista de mapas da página da partida: o mapa atual é o primeiro sem vencedor.
  // O placar ao vivo só vale se o placar da página for desse mapa (senão ele nem começou).
  if (live && live.gameId === game.id && live.maps?.length) {
    const current = live.maps.find(map => !map.winner);
    if (!current) return null;
    const same = current.name.toLowerCase() === live.map.toLowerCase() && !csFinished(live);
    const homeCt = csSide(live, game.home) === "CT";
    return same ? { home: homeCt ? live.ctScore : live.tScore, away: homeCt ? live.tScore : live.ctScore, map: current.name } : { home: 0, away: 0, map: current.name };
  }
  if (live && live.gameId === game.id && csFinished(live)) {
    // O placar final vai para o último mapa encerrado; o mapa novo usa o placar da lista.
    const homeCt = csSide(live, game.home) === "CT";
    const done = (game.maps ?? []).filter(map => map.result !== "live" && map.result !== "pending").length;
    if (done > 0) {
      const byGame = finishedMaps.get(game.id) ?? new Map();
      byGame.set(done - 1, { name: live.map, home: homeCt ? live.ctScore : live.tScore, away: homeCt ? live.tScore : live.ctScore });
      finishedMaps.set(game.id, byGame);
    }
  } else if (live && live.gameId === game.id) {
    const homeCt = csSide(live, game.home) === "CT";
    return { home: homeCt ? live.ctScore : live.tScore, away: homeCt ? live.tScore : live.ctScore, map: live.map || (index >= 0 ? `Mapa ${index + 1}` : "") };
  }
  const map = index >= 0 ? game.maps![index] : null;
  if (!map || map.homeRounds == null || map.awayRounds == null) return null;
  // A lista também pode ainda mostrar o placar final do mapa anterior: o novo começa em 0–0.
  const stale = csFinished({ ctScore: map.homeRounds, tScore: map.awayRounds } as CsLive);
  return { home: stale ? 0 : map.homeRounds, away: stale ? 0 : map.awayRounds, map: map.name ?? `Mapa ${index + 1}` };
}
export interface CsMap { name: string; home: number | null; away: number | null; winner: "home" | "away" | "" }
export interface CsLive { gameId: string; map: string; round: number; ctTeam: string; tTeam: string; ctScore: number; tScore: number; phase: string; history: CsRound[]; streams?: CsStream[]; maps?: CsMap[] }
/** Transmissão listada pelo HLTV (embed pronto: YouTube, Twitch ou Kick). */
export interface CsStream { name: string; provider: string; country: string; viewers: string; embed: string }
const viewersOf = (text: string) => { const value = parseFloat(text.replace(",", ".")); return Number.isFinite(value) ? value * (/k/i.test(text) ? 1000 : /m/i.test(text) ? 1_000_000 : 1) : 0; };
/** Canal para abrir primeiro: o brasileiro mais assistido; sem canal BR, o mais assistido. */
export function bestStream(streams: CsStream[] = []): CsStream | null {
  const ranked = [...streams].sort((a, b) => viewersOf(b.viewers) - viewersOf(a.viewers));
  return ranked.find(stream => stream.country === "Brazil") ?? ranked[0] ?? null;
}
/** Embed para o PiP: Twitch exige o domínio de quem incorpora; sempre começa sem som. */
export function embedUrl(embed: string) {
  try {
    const url = new URL(embed);
    if (url.hostname === "player.twitch.tv") { url.searchParams.set("parent", location.hostname || "tauri.localhost"); url.searchParams.set("muted", "true"); }
    if (url.hostname.endsWith("youtube.com")) { url.searchParams.set("mute", "1"); url.searchParams.set("autoplay", "1"); }
    if (url.hostname === "player.kick.com") { url.searchParams.set("muted", "true"); url.searchParams.set("autoplay", "true"); }
    return url.toString();
  } catch { return embed; }
}

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
  useEffect(() => { void bridge.setCsPinned?.(pinned).catch(() => {}); }, [bridge, pinned]);
  const view = useMemo<SportsSnapshot | null>(() => snapshot && pinned
    ? { ...snapshot, games: snapshot.games.map(game => game.id === pinned ? { ...game, followed: true, pinned: true } : game) } : snapshot, [snapshot, pinned]);
  const save = useCallback(async (leagues: string[], teams: string[], token?: string) => {
    if (!bridge.saveSportsConfig) return;
    setConfig(await bridge.saveSportsConfig(leagues, teams, token));
  }, [bridge]);
  // Placar round a round do CS2 (HLTV), empurrado pelo Rust a cada mudança.
  const [csLive, setCsLive] = useState<CsLive | null>(null);
  const [csStatus, setCsStatus] = useState<{ gameId: string; state: "searching" | "live" | "missing" | "blocked" } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    void bridge.getCsStatus?.().then(value => setCsStatus(value ?? null)).catch(() => {});
    if (!bridge.onDesktopEvent) return;
    let stop: (() => void) | undefined, alive = true;
    void bridge.onDesktopEvent("hltv:status", payload => setCsStatus(payload as typeof csStatus)).then(fn => { if (alive) stop = fn; else fn(); });
    return () => { alive = false; stop?.(); };
  }, [bridge, enabled]);
  useEffect(() => {
    if (!enabled) return;
    void bridge.getCsLive?.().then(value => setCsLive(value ?? null)).catch(() => {});
    if (!bridge.onDesktopEvent) return;
    let stop: (() => void) | undefined, alive = true;
    void bridge.onDesktopEvent("hltv:live", payload => setCsLive((payload as CsLive | null) ?? null)).then(fn => { if (alive) stop = fn; else fn(); });
    return () => { alive = false; stop?.(); };
  }, [bridge, enabled]);
  const watch = useCallback((embed: string | null) => { void bridge.streamPip?.(embed).catch(() => {}); }, [bridge]);
  return { snapshot: view, config, catalog, save, pinned, togglePin, csLive, csStatus, watch, available: Boolean(bridge.desktop && bridge.getSports) };
}
export type SportsControl = ReturnType<typeof useSports>;

/** Como cada esporte chama o que mudou o placar: mapa (e-sports), gol (futebol), ponto (resto).
 *  `mapFor` é o texto do tema para e-sports ("{team}" vira o nome do time). */
export function scoreLabel(league: string, team: string, mapFor?: string) {
  if (/^(hltv|bo3|panda):/.test(league)) return mapFor?.includes("{team}") ? mapFor.replace("{team}", team) : `Mapa para ${team}`;
  if (/soccer|futebol/i.test(league)) return `Gol de ${team}`;
  return `Ponto de ${team}`;
}
/** Jogos seguidos que acabaram agora (estava "in", virou "post"): vitória ou derrota do time seguido. */
export function sportsResults(previous: SportsSnapshot | null, next: SportsSnapshot | null, followedTeams: string[]): { id: string; result: "win" | "loss" }[] {
  if (!previous || !next) return [];
  const results: { id: string; result: "win" | "loss" }[] = [];
  // HLTV não mostra partida encerrada: a que estava ao vivo e sumiu acabou com o último placar visto.
  const vanished = previous.games.filter(game => game.league.startsWith("hltv:") && game.state === "in" && !next.games.some(item => item.id === game.id)).map(game => ({ ...game, state: "post" }));
  for (const game of [...next.games, ...vanished]) {
    const before = previous.games.find(item => item.id === game.id);
    if (!game.followed || before?.state !== "in" || game.state !== "post") continue;
    const home = Number(game.home.score ?? 0), away = Number(game.away.score ?? 0);
    if (home === away) continue;
    const ours = (side: typeof game.home) => followedTeams.includes(`${game.league}|${side.id}`);
    const winner = home > away ? game.home : game.away, loser = home > away ? game.away : game.home;
    if (ours(winner)) results.push({ id: game.id, result: "win" });
    else if (ours(loser)) results.push({ id: game.id, result: "loss" });
  }
  return results;
}

/** Placar que mudou em jogo seguido vira aviso; o mascote comemora gol do time seguido. */
export function sportsActivities(previous: SportsSnapshot | null, next: SportsSnapshot | null, now: number, followedTeams: string[], mapFor?: string): ActivityInput[] {
  if (!previous || !next) return [];
  const found: ActivityInput[] = [];
  for (const game of next.games) {
    if (!game.followed) continue;
    const before = previous.games.find(item => item.id === game.id);
    const scoreline = `${game.home.short} ${game.home.score ?? 0}–${game.away.score ?? 0} ${game.away.short}`;
    if (before && game.state === "in" && (before.home.score !== game.home.score || before.away.score !== game.away.score)) {
      const homeUp = Number(game.home.score ?? 0) > Number(before.home.score ?? 0);
      const scorer = homeUp ? game.home : game.away;
      // Humor: feliz se foi o time seguido; preocupado só se foi o adversário dele;
      // jogo só acompanhado (nenhum dos dois seguido) fica neutro.
      const ours = followedTeams.includes(`${game.league}|${scorer.id}`);
      const rival = !ours && followedTeams.includes(`${game.league}|${(homeUp ? game.away : game.home).id}`);
      found.push({ kind: "score", group: "sport", icon: "ball", value: scoreline, label: scoreLabel(game.league, scorer.name, mapFor), priority: 4, durationMs: 6000, width: 320, mood: ours ? "happy" : rival ? "worried" : "wide", tone: ours ? "ok" : "neutral" });
    }
    const alert = kickoffAlert(game, now);
    const already = before && kickoffAlert(before, previous.observedAt ?? now - 30_000) === alert;
    if (alert && !already) found.push({ kind: "kickoff", group: "sport", icon: "ball", value: `${game.home.short} × ${game.away.short} em ${alert} min`, label: game.leagueName, priority: 2, durationMs: 6000, width: 320, mood: "wide", tone: "neutral" });
  }
  return found;
}
