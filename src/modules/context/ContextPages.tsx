import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ShellBridge } from "../../lib/shellBridge";
import type { useSettings } from "../../hooks/useSettings";
import type { useContextSnapshots } from "./useContext";
import { defaultReminders, parseEventText, pendingTodos, type NotesControl } from "./useNotes";
import { SNOOZE_MIN, waterCopy, waterPlan, waterSettings } from "./waterPlan";
import type { AskControl } from "./useAsk";
import { Digits } from "../ui/Digits";
import { PrompterPage } from "../prompter/PrompterPage";
import type { RecorderControl } from "../prompter/useRecorder";
import type { CalendarsControl, FeedEvent } from "./useCalendars";
import { extension, fileSize, useThumbnail, type ShelfControl, type ShelfItem } from "./useShelf";
import { Mascot, type EyeShape } from "./Mascot";
import { defaultMascot, defaultSounds, type MascotSettings, type SoundSettings } from "../../lib/shellBridge";
import { playSound } from "../sound/sounds";
import { setLyricsOn, useLyricsOn } from "./lyricsStore";
import { SportsPage, SportsPreferences } from "../sports/SportsPages";
import type { SportsControl } from "../sports/useSports";
import { PetPage } from "../pet/PetPage";
import type { PetControl } from "../pet/usePet";
import type { ClaudeLimit, CodexQuotaSnapshot, LyricLine, Lyrics, MediaAction, MediaStatus, QuotaWindow, TrackInfo } from "./types";

// Hora e clima ficam só no compacto; aberto, o rolo tem Início, Player, Claude,
// Sistema, Tarefas e Nota.
export const pageNames = { home: "Início", media: "Player", limits: "Claude", system: "Sistema", tasks: "Tarefas", agenda: "Agenda", shelf: "Prateleira", prompter: "Teleprompter", water: "Água", pet: "Bichinho", note: "Nota", ask: "Perguntar", sports: "Esportes", sportsPrefs: "Preferências de esportes", calendarPrefs: "Agendas", generalPrefs: "Geral", waterPrefs: "Ajustes da água", pagesPrefs: "Páginas", mascotPrefs: "Mascote", soundPrefs: "Sons", appearance: "Aparência", modules: "Módulos" } as const;
export type ContextPage = keyof typeof pageNames;
export function weatherLabel(code: number | null) {
  if (code == null) return "Condição indisponível";
  if (code === 0) return "Céu limpo";
  if (code <= 3) return "Nublado";
  if (code <= 48) return "Nevoeiro";
  if (code <= 67) return "Chuva";
  if (code <= 77) return "Neve";
  if (code <= 86) return "Pancadas";
  return "Trovoadas";
}
export function windowLabel(minutes: number | null) {
  if (minutes == null) return "Janela desconhecida";
  if (minutes % 1440 === 0) return minutes === 10080 ? "semana" : `${minutes / 1440} dias`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}
function validPercent(value: number | null | undefined): value is number { return value != null && Number.isFinite(value) && value >= 0 && value <= 100; }
function percent(value: number | null | undefined) { return validPercent(value) ? `${Math.round(value)}%` : "—"; }
function clockOf(value: string | number | null | undefined) {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}
function Note({ children }: { children: React.ReactNode }) { return <p className="context-note">{children}</p>; }

/** Cota é atual quando a leitura é recente e a janela ainda não renovou. */
export function quotaReading(quota: QuotaWindow, snapshot: CodexQuotaSnapshot | null, failed: boolean) {
  const age = snapshot?.observedAt ? Date.now() - Date.parse(snapshot.observedAt) : Infinity;
  const stale = failed || snapshot?.state !== "available" || !Number.isFinite(age) || age < 0 || age > 300_000;
  const current = quota.state === "available" && !stale && (quota.resetsAt == null || quota.resetsAt * 1000 > Date.now());
  return { current, value: current ? quota.remainingPercent : quota.lastKnownRemainingPercent };
}
/** Cota do Claude perto do fim: algum limite em 90% ou marcado como crítico. */
export function quotaLow(context: ReturnType<typeof useContextSnapshots>) {
  const claude = context.claude.value;
  return Boolean(claude && claude.state === "available" && claude.limits.some(limit => limit.percent >= 90 || limit.severity === "critical"));
}

/** Ritmo: onde o uso deveria estar pelo tempo decorrido e a projeção até a renovação. */
export function claudePace(limit: ClaudeLimit, now: number) {
  if (limit.resetsAt == null || limit.windowMinutes == null) return null;
  const windowMs = limit.windowMinutes * 60_000, left = limit.resetsAt - now;
  if (left <= 0 || left > windowMs) return null;
  const elapsedMs = windowMs - left, expected = elapsedMs / windowMs * 100;
  if (limit.percent >= 100) return { expected, exhaustsAt: now, leftAtReset: 0 };
  // Pouco tempo decorrido torna a projeção ruído; só o marcador aparece.
  if (expected < 5 || limit.percent <= 0) return { expected, exhaustsAt: null, leftAtReset: null };
  const projected = limit.percent / (expected / 100);
  if (projected < 100) return { expected, exhaustsAt: null, leftAtReset: 100 - projected };
  return { expected, exhaustsAt: now + (100 - limit.percent) / (limit.percent / elapsedMs), leftAtReset: 0 };
}
function whenOf(ms: number, now: number) {
  const date = new Date(ms);
  return ms - now < 20 * 3_600_000 && date.getDate() === new Date(now).getDate()
    ? date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString("pt-BR", { weekday: "short", hour: "2-digit", minute: "2-digit" }).replace(".,", "");
}
function PaceBar({ limit, expected, label }: { limit: ClaudeLimit; expected: number | null; label: string }) {
  const tone = limit.severity === "critical" || limit.percent >= 90 ? "warn" : "accent";
  return <div className="pace-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(limit.percent)} data-tone={tone}>
    <i style={{ width: `${Math.min(100, limit.percent)}%` }} />
    {expected != null && <b style={{ left: `${Math.min(100, expected)}%` }} title="Ritmo esperado pelo tempo decorrido" />}
  </div>;
}

function duration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
/** A posição publicada pelo Windows é um instante; enquanto toca, avança pelo relógio. */
export function mediaPosition(media: MediaStatus, now: number) {
  if (media.durationMs == null || media.positionMs == null) return null;
  const elapsed = media.state === "playing" && media.positionAtMs != null ? Math.max(0, now - media.positionAtMs) : 0;
  return Math.min(media.durationMs, media.positionMs + elapsed);
}
export function useNow(active: boolean, every = 500) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // Janela escondida (tela cheia, suspensão) atrasa timers: ao voltar, relê o relógio na hora.
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, every);
    const visible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", tick); };
  }, [active, every]);
  return now;
}

const icons: Record<MediaAction | "play" | "lyrics", string> = {
  previous: "M6 5h2v14H6zM20 5v14L9 12z",
  next: "M16 5h2v14h-2zM4 5v14l11-7z",
  toggle: "M6 4h4v16H6zM14 4h4v16h-4z",
  play: "M7 4v16l13-8z",
  lyrics: "M4 5h16v2H4zM4 10h16v2H4zM4 15h10v2H4zM17 14v6l4-3z",
};
/** Linha atual: a última cujo instante já passou (com leve antecipação para a leitura). */
export function lyricIndex(lines: LyricLine[], positionMs: number) {
  let index = -1;
  for (let i = 0; i < lines.length && lines[i].atMs <= positionMs + 250; i++) index = i;
  return index;
}
/** Linha atual da letra; só re-renderiza quando a linha muda (timer até a próxima linha,
 * em vez de um relógio de 250 ms re-renderizando quem chama). */
export function useLyricIndex(lines: LyricLine[], media: MediaStatus | null, active: boolean) {
  const [index, setIndex] = useState(-1);
  useEffect(() => {
    if (!active || !media || !lines.length) { setIndex(-1); return; }
    let timer = 0;
    const step = () => {
      const position = mediaPosition(media, Date.now());
      const current = position == null ? -1 : lyricIndex(lines, position);
      setIndex(current);
      if (position == null || media.state !== "playing") return;
      const next = lines[current + 1];
      // Ressincroniza ao menos a cada 5 s (pulos na música chegam pelo snapshot).
      const wait = next ? Math.min(5000, Math.max(40, next.atMs - 250 - position)) : 5000;
      timer = window.setTimeout(step, wait);
    };
    step();
    return () => window.clearTimeout(timer);
  }, [lines, media, active]);
  return active ? index : -1;
}
export function useLyrics(bridge: ShellBridge, media: MediaStatus | null | undefined, open: boolean) {
  const [result, setResult] = useState<{ key: string; lyrics: Lyrics | null }>({ key: "", lyrics: null });
  const key = media?.title ? `${media.title}\u001f${media.artist ?? ""}` : "";
  useEffect(() => {
    if (!open || !key || !bridge.getLyrics || result.key === key) return;
    let active = true;
    setResult({ key, lyrics: null });
    bridge.getLyrics(media!.title!, media!.artist ?? "", media!.durationMs ?? null)
      .then(lyrics => { if (active) setResult({ key, lyrics }); })
      .catch(() => { if (active) setResult({ key, lyrics: { state: "error", lines: [], plain: null } }); });
    return () => { active = false; };
  }, [open, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return result.key === key ? result.lyrics : null;
}
/** Sem arte do álbum: gradiente estável derivado da faixa, para cada música ter cara própria. */
export function coverStyle(seed: string) {
  if (!seed) return undefined;
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360, second = (hue + 40 + (Math.abs(hash >> 8) % 80)) % 360;
  return { background: `radial-gradient(120% 120% at 20% 10%, oklch(46% .12 ${hue}), oklch(22% .06 ${second}))`, color: "rgba(255,255,255,.75)" };
}
/** Ficha da faixa (álbum, ano, gênero, capa) compartilhada: o Player busca; o fundo do Vidro só lê. */
const trackInfos = new Map<string, TrackInfo | null>();
const trackListeners = new Set<() => void>();
export function useTrackInfo(bridge: ShellBridge, media: MediaStatus | null | undefined, fetch: boolean) {
  const key = media?.title ? `${media.title}${media.artist ?? ""}` : "";
  const info = useSyncExternalStore(listener => { trackListeners.add(listener); return () => trackListeners.delete(listener); }, () => trackInfos.get(key));
  useEffect(() => {
    if (!fetch || !key || !bridge.getTrackInfo || trackInfos.has(key)) return;
    trackInfos.set(key, null);
    const done = (value: TrackInfo | null) => { if (trackInfos.size > 60) trackInfos.clear(); trackInfos.set(key, value); trackListeners.forEach(listener => listener()); };
    bridge.getTrackInfo(media!.title!, media!.artist ?? "", media!.durationMs ?? null).then(done, () => { trackInfos.delete(key); });
  }, [fetch, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return key ? info ?? null : null;
}
/** Capa certa: navegadores publicam o ícone do site ou do próprio navegador; ali vale a do iTunes. */
export function bestArt(media: MediaStatus | null | undefined, appArt: string | null, info: TrackInfo | null) {
  const browser = /chrome|edge|firefox|opera|brave|vivaldi|navegador/i.test(media?.source ?? "");
  return browser ? info?.art ?? appArt : appArt ?? info?.art ?? null;
}
/** Capa real do app de mídia; só busca quando a faixa (artKey) muda. A última capa fica guardada:
 * aviso de faixa, fundo do player e o próprio player usam a mesma leitura. */
let lastArt: { key: string; url: Promise<string | null> } | null = null;
export function useMediaArt(bridge: ShellBridge, artKey: string | null | undefined) {
  const [art, setArt] = useState<{ key: string; url: string | null }>({ key: "", url: null });
  useEffect(() => {
    if (!artKey || !bridge.getMediaArt || art.key === artKey) return;
    let active = true;
    if (lastArt?.key !== artKey) lastArt = { key: artKey, url: bridge.getMediaArt().catch(() => null) };
    void lastArt.url.then(url => { if (active) setArt({ key: artKey, url }); });
    return () => { active = false; };
  }, [artKey, bridge]); // eslint-disable-line react-hooks/exhaustive-deps
  // Capa nova da mesma faixa ainda chegando: mantém a anterior em vez de piscar.
  return artKey ? art.url : null;
}
function MediaIcon({ path, size = 15 }: { path: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={path} /></svg>;
}
function Player({ media, bridge, enabled, stale }: { media: MediaStatus | null | undefined; bridge: ShellBridge; enabled: boolean; stale: boolean }) {
  const playing = media?.state === "playing";
  const lyricsOpen = useLyricsOn();
  const [failure, setFailure] = useState("");
  const now = useNow(Boolean(playing && media?.durationMs), lyricsOpen ? 200 : 500);
  const active = media && (media.state === "playing" || media.state === "paused");
  const position = active ? mediaPosition(media, now) : null;
  const lyrics = useLyrics(bridge, active ? media : null, lyricsOpen);
  const info = useTrackInfo(bridge, active ? media : null, true);
  const artUrl = bestArt(media, useMediaArt(bridge, active ? media.artKey : null), info);
  useEffect(() => { if (!failure) return; const timer = window.setTimeout(() => setFailure(""), 3000); return () => window.clearTimeout(timer); }, [failure]);
  const send = (action: MediaAction) => {
    if (!bridge.mediaControl) return;
    void bridge.mediaControl(action).catch(error => setFailure(typeof error === "string" ? error : "O app de mídia não respondeu."));
  };
  const toggleLyrics = () => setLyricsOn(!lyricsOpen);
  const title = !bridge.desktop ? "Player do Windows" : !enabled ? "Mídia desativada" : active ? media.title ?? "Título indisponível" : "Nada tocando";
  const meta = !bridge.desktop ? "Disponível no app desktop" : !enabled ? "Ative em Módulos" : active
    ? media.artist || media.source || (playing ? "Tocando" : "Pausado")
    : "Toque algo em qualquer player do Windows";
  const controls = active && <div className="player-controls">
    <button type="button" className="media-button" aria-label="Faixa anterior" disabled={!media.canPrevious} onClick={() => send("previous")}><MediaIcon path={icons.previous} /></button>
    <button type="button" className="media-button primary" aria-label={playing ? "Pausar" : "Tocar"} disabled={!media.canToggle} onClick={() => send("toggle")}><MediaIcon path={playing ? icons.toggle : icons.play} size={13} /></button>
    <button type="button" className="media-button" aria-label="Próxima faixa" disabled={!media.canNext} onClick={() => send("next")}><MediaIcon path={icons.next} /></button>
  </div>;
  const lyricsButton = active && bridge.getLyrics && <button type="button" className="media-button lyrics-button" aria-label="Letra" aria-pressed={lyricsOpen} onClick={toggleLyrics}><MediaIcon path={icons.lyrics} size={14} /></button>;
  const progress = active && media.durationMs != null && position != null && <div className="player-progress">
    <span>{duration(position)}</span>
    <progress aria-label="Progresso da faixa" max={media.durationMs} value={position} />
    <span>{duration(media.durationMs)}</span>
  </div>;
  if (active && lyricsOpen) {
    const lines = lyrics?.state === "synced" ? lyrics.lines : [];
    const index = position != null ? lyricIndex(lines, position) : -1;
    const message = !lyrics ? "Buscando letra…" : lyrics.state === "instrumental" ? "Instrumental" : lyrics.state === "plain" ? "Letra sem sincronia" : lyrics.state === "error" ? "Não foi possível buscar a letra" : lyrics.state === "none" ? "Letra não encontrada" : null;
    const at = (offset: number) => lines[index + offset]?.text || (index + offset >= 0 && index + offset < lines.length ? "♪" : "");
    return <div className="player-page lyrics-mode" data-state={media.state}>
      <div className="lyrics-head">
        <div className="player-cover small" aria-hidden="true" style={artUrl ? undefined : coverStyle(`${media.title ?? ""}${media.artist ?? ""}`)}>{artUrl && <img src={artUrl} alt="" />}</div>
        <span className="player-meta"><b>{title}</b>{media.artist ? ` · ${media.artist}` : ""}</span>
      </div>
      <div className="lyrics" aria-live="off">
        {message ? <strong className="lyric-current lyric-note">{message}</strong> : <>
          <span className="lyric-side" key={`p${index}`}>{at(-1)}</span>
          <strong className="lyric-current" key={`c${index}`}>{index < 0 ? "♪" : at(0)}</strong>
          <span className="lyric-side" key={`n${index}`}>{at(1)}</span>
        </>}
      </div>
      <div className="lyrics-footer">{progress}{controls}{lyricsButton}</div>
    </div>;
  }
  // Barra no estilo Spotify: capa e ficha à esquerda, controles sobre o progresso no centro, letra à direita.
  // No tema Vidro, a capa vira capa de disco: o vinil sai de trás dela e gira enquanto toca, com a agulha em cima.
  return <div className="player-page" data-state={media?.state ?? "unavailable"}>
    <div className="player-deck" aria-hidden="true">
      {active && <span className="vinyl"><span className="vinyl-disc"><span className="vinyl-label" style={artUrl ? { backgroundImage: `url("${artUrl}")` } : coverStyle(`${media.title ?? ""}${media.artist ?? ""}`)} /></span><span className="vinyl-sheen" /></span>}
      <div className="player-cover" style={artUrl ? undefined : coverStyle(active ? `${media.title ?? ""}${media.artist ?? ""}` : "")}>
        {artUrl ? <img src={artUrl} alt="" /> : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></svg>}
      </div>
      {active && <span className="tonearm"><i /></span>}
    </div>
    <div className="player-info">
      <strong className="player-title">{title}</strong>
      <span className="player-meta">{playing ? <span className="player-eq" aria-hidden="true"><i /><i /><i /><i /></span> : null}{meta}{stale && active ? " · dado antigo" : ""}</span>
      {active && <span className="player-sub">{[info?.album, info?.year, info?.genre, media.artist ? media.source : null].filter(Boolean).join(" · ")}</span>}
    </div>
    <div className="player-center">{controls}{progress}{failure && <span className="player-failure" role="status">{failure}</span>}</div>
    <div className="player-actions">{lyricsButton}</div>
  </div>;
}

function Claude({ bridge, enabled, context }: { bridge: ShellBridge; enabled: boolean; context: ReturnType<typeof useContextSnapshots> }) {
  const snapshot = context.claude.value, now = Date.now();
  if (!bridge.desktop) return <div className="statement-page"><Note>A cota do Claude aparece no app desktop.</Note></div>;
  if (!enabled) return <div className="statement-page"><Note>Uso do Claude desativado. Ative em Módulos.</Note></div>;
  if (!snapshot?.limits.length) return <div className="statement-page"><Note>{snapshot?.reason ?? (context.claude.failed ? "Não foi possível ler a cota do Claude." : "Consultando a cota do Claude…")}</Note></div>;
  const stale = snapshot.state !== "available" || context.claude.failed;
  // O número grande é o limite mais perto de acabar; os outros viram linhas.
  const hero = snapshot.limits.reduce((top, limit) => limit.percent > top.percent ? limit : top);
  const others = snapshot.limits.filter(limit => limit !== hero).slice(0, 2);
  const pace = claudePace(hero, now);
  const tone = stale ? "stale" : hero.severity === "critical" || hero.percent >= 90 ? "warn" : "accent";
  // Horário real de renovação informado pela Anthropic; sem previsão.
  const reset = (limit: ClaudeLimit) => limit.resetsAt != null ? `renova ${whenOf(limit.resetsAt, now)}` : "renovação não informada";
  const forecast = stale ? `lido ${clockOf(snapshot.observedAt) ?? "antes"}${snapshot.reason ? ` · ${snapshot.reason}` : ""}`
    : hero.percent >= 100 ? `esgotado · ${reset(hero)}` : reset(hero);
  return <div className="statement-page claude-page">
    <div className="statement-value"><span className="statement-number" data-tone={tone}><Digits value={percent(hero.percent)} /></span><span className="statement-unit">usado <span className="hd-badge">{hero.label}</span></span></div>
    {!stale && <PaceBar limit={hero} expected={pace?.expected ?? null} label={`${hero.label}: ${Math.round(hero.percent)}% usado`} />}
    <p className="statement-line">Claude{snapshot.plan ? ` ${snapshot.plan}` : ""} <span>· {forecast}</span></p>
    {others.map(limit => { const other = claudePace(limit, now); return <div className="statement-row" key={`${limit.kind}-${limit.label}`}>
      <span>{limit.label} <em>· {reset(limit).replace("renovação não informada", "sem horário")}</em></span>
      <PaceBar limit={limit} expected={stale ? null : other?.expected ?? null} label={`${limit.label}: ${Math.round(limit.percent)}% usado`} />
      <strong>{percent(limit.percent)}</strong>
    </div>; })}
  </div>;
}

export function rate(bps: number | null | undefined) {
  if (bps == null || !Number.isFinite(bps) || bps < 0) return "—";
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${Math.round(bps / 1024)} KB/s`;
  return `${(bps / 1048576).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB/s`;
}
const systemIcons = {
  cpu: "M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M6 6h12v12H6zM10 10h4v4h-4z",
  memory: "M3 7h18v10H3zM7 7v10M11 7v10M15 7v10M3 17l-1 3M21 17l1 3",
  disk: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3zM4 6c0 1.7 3.6 3 8 3s8-1.3 8-3M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  network: "M12 20h.01M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 14 0M1.5 9.4a15 15 0 0 1 21 0",
  battery: "M3 8h15v8H3zM21 11v2",
  awake: "M17 8h1a4 4 0 0 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4zM6 2v3M10 2v3M14 2v3",
};
function RowIcon({ name }: { name: keyof typeof systemIcons }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={systemIcons[name]} /></svg>;
}
function Bar({ value, label, tone }: { value: number | null; label: string; tone?: string }) {
  return validPercent(value)
    ? <div className="pace-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)} data-tone={tone}><i style={{ width: `${value}%` }} /></div>
    : <div className="meter-empty" aria-hidden="true" />;
}
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="meter-empty" aria-hidden="true" />;
  const top = Math.max(...values, 1);
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${14 - value / top * 13}`).join(" ");
  return <svg className="spark" viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>;
}
export interface KeepAwakeControl { on: boolean; available: boolean; error: string; toggle(): void }
function System({ data, enabled, previous, network, awake }: { data: ReturnType<typeof useContextSnapshots>["desktop"]["value"]; enabled: boolean; previous: boolean; network: number[]; awake?: KeepAwakeControl }) {
  if (!enabled) return <div className="statement-page"><Note>CPU, memória e bateria desativados. Ative em Módulos.</Note></div>;
  const share = (part?: { usedBytes: number; totalBytes: number } | null) => part && part.totalBytes > 0 ? part.usedBytes / part.totalBytes * 100 : null;
  const gb = (bytes: number) => (bytes / 1073741824).toLocaleString("pt-BR", { maximumFractionDigits: bytes >= 107374182400 ? 0 : 1 });
  const memory = data?.memory && data.memory.totalBytes > 0 ? data.memory : null;
  const disk = data?.disk && data.disk.totalBytes > 0 ? data.disk : null;
  const battery = data?.battery?.hasBattery ? data.battery : null;
  const warn = (value: number | null) => value != null && value >= 90 ? "warn" : "accent";
  const cpu = data?.cpuPercent ?? null, memoryShare = share(memory), diskShare = share(disk);
  return <div className="system-rows" data-stale={previous || undefined}>
    <div className="system-row"><RowIcon name="cpu" /><span>CPU</span><Bar value={cpu} label="Uso de CPU" tone={warn(cpu)} /><strong>{cpu == null ? "aguardando" : percent(cpu)}</strong></div>
    <div className="system-row"><RowIcon name="memory" /><span>Memória</span><Bar value={memoryShare} label="Memória em uso" tone={warn(memoryShare)} /><strong>{memory ? `${gb(memory.usedBytes)} de ${gb(memory.totalBytes)} GB` : "—"}</strong></div>
    <div className="system-row"><RowIcon name="disk" /><span>Disco</span><Bar value={diskShare} label="Disco do sistema em uso" tone={warn(diskShare)} /><strong>{disk ? `${gb(disk.totalBytes - disk.usedBytes)} GB livres` : "—"}</strong></div>
    <div className="system-row"><RowIcon name="network" /><span>Rede</span><Spark values={network} /><strong>{data?.network ? `↓ ${rate(data.network.downBps)} ↑ ${rate(data.network.upBps)}` : "—"}</strong></div>
    <div className="system-row"><RowIcon name="battery" /><span>Bateria</span>{battery ? <Bar value={battery.percent} label="Carga da bateria" tone={battery.percent != null && battery.percent <= 20 && !battery.plugged ? "warn" : "ok"} /> : <div className="meter-empty" aria-hidden="true" />}<strong>{battery ? `${percent(battery.percent)} · ${battery.charging ? "carregando" : battery.plugged ? "na tomada" : "na bateria"}` : "Sem bateria"}</strong></div>
    {awake?.available && <div className="system-row awake-row"><RowIcon name="awake" /><span>Acordado</span><em>{awake.error || (awake.on ? "o PC não dorme nem apaga a tela" : "o Windows segue a energia normal")}</em><button type="button" className="switch" role="switch" aria-checked={awake.on} aria-label="Manter o PC acordado" onClick={awake.toggle}><i /></button></div>}
  </div>;
}

function greeting(hour: number) { return hour < 5 ? "Boa madrugada" : hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite"; }
/** Resumo: um cartão por assunto; tocar no cartão leva à página dele. */
/** Início (OmniNotch): saudação, player grande e, ao lado, Hoje e Tarefas. */
function Home({ context, media, notes, go, bridge, calendars }: { context: ReturnType<typeof useContextSnapshots>; media: MediaStatus | null | undefined; notes?: NotesControl; go(page: ContextPage): void; bridge: ShellBridge; calendars?: CalendarsControl }) {
  const nowMs = useNow(true, 1000);
  const now = new Date(nowMs);
  const active = media && (media.state === "playing" || media.state === "paused") ? media : null;
  const playing = active?.state === "playing";
  const position = active ? mediaPosition(active, nowMs) : null;
  const artUrl = useMediaArt(bridge, active ? active.artKey : null);
  const claude = context.claude.value?.limits.length ? context.claude.value : null;
  const hero = claude?.limits.reduce((top, limit) => limit.percent > top.percent ? limit : top);
  const pending = notes ? pendingTodos(notes.notes.todos) : [];
  const dayEnd = new Date(now); dayEnd.setHours(23, 59, 59, 999);
  const today = [...(notes?.events ?? []).map(event => ({ id: event.id, title: event.title, at: event.at, allDay: false, color: undefined as string | undefined })),
    ...(calendars?.events ?? []).map(event => ({ id: event.id, title: event.title, at: event.at, allDay: event.allDay, color: event.color }))]
    .filter(event => event.at <= dayEnd.getTime() && (event.allDay ? new Date(event.at).toDateString() === now.toDateString() : event.at >= nowMs - 30 * 60_000))
    .sort((a, b) => Number(!a.allDay) - Number(!b.allDay) || a.at - b.at);
  const send = (action: MediaAction) => { void bridge.mediaControl?.(action).catch(() => {}); };
  const date = now.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  return <div className="home-page">
    <p className="home-greeting"><strong>{greeting(now.getHours())}</strong><span>{date.charAt(0).toUpperCase() + date.slice(1)}</span></p>
    <div className="home-grid">
      {active ? <div className="home-player" data-state={active.state}>
        <button type="button" className="home-art" aria-label="Abrir Player" onClick={() => go("media")} style={artUrl ? undefined : coverStyle(`${active.title ?? ""}${active.artist ?? ""}`)}>
          {artUrl ? <img src={artUrl} alt="" /> : <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></svg>}
        </button>
        <div className="home-track">
          <div className="home-track-head"><span><strong>{active.title ?? "Título indisponível"}</strong><span>{[active.artist, active.source].filter(Boolean).join(" · ") || (playing ? "Tocando" : "Pausado")}</span></span>
            <span className="home-track-tools">{playing && <span className="player-eq home-eq" aria-hidden="true"><i /><i /><i /><i /></span>}
              {bridge.getLyrics && <button type="button" className="home-lyrics" aria-label="Abrir letra" title="Letra" onClick={() => { setLyricsOn(true); go("media"); }}><MediaIcon path={icons.lyrics} size={14} /></button>}</span></div>
          {active.durationMs != null && position != null && <div className="home-progress"><progress aria-label="Progresso da faixa" max={active.durationMs} value={position} /><span>{duration(position)}</span><span>{duration(active.durationMs)}</span></div>}
          <div className="home-controls">
            <button type="button" aria-label="Faixa anterior" disabled={!active.canPrevious} onClick={() => send("previous")}><MediaIcon path={icons.previous} size={20} /></button>
            <button type="button" className="home-play" aria-label={playing ? "Pausar" : "Tocar"} disabled={!active.canToggle} onClick={() => send("toggle")}><MediaIcon path={playing ? icons.toggle : icons.play} size={24} /></button>
            <button type="button" aria-label="Próxima faixa" disabled={!active.canNext} onClick={() => send("next")}><MediaIcon path={icons.next} size={20} /></button>
          </div>
        </div>
      </div> : <button type="button" className="home-player" onClick={() => go("limits")}>
        <span className="home-art" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></svg></span>
        <span className="home-track"><span>Claude · {hero?.label ?? "cota"}</span><strong className="home-number" data-tone={!hero ? undefined : hero.percent >= 90 || hero.severity === "critical" ? "warn" : "accent"}>{hero ? <Digits value={`${Math.round(hero.percent)}%`} /> : "—"}</strong><span>{hero ? "usado · nada tocando agora" : "Nada tocando · cota indisponível"}</span></span>
      </button>}
      <div className="home-side">
        <div className="home-section">
          <button type="button" className="home-section-head" onClick={() => go("agenda")}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4" /></svg>Hoje</button>
          {today.slice(0, 2).map(event => <div key={event.id} className="home-event"><i style={event.color ? { background: event.color } : undefined} /><b title={event.title}>{event.title}</b><small>{event.allDay ? "dia todo" : new Date(event.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</small></div>)}
          {!today.length && <span className="home-empty">Nada mais hoje.</span>}
        </div>
        <div className="home-section">
          <button type="button" className="home-section-head" onClick={() => go("tasks")}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></svg>Tarefas</button>
          {pending.slice(0, today.length > 1 ? 1 : 2).map(todo => <button key={todo.id} type="button" className="home-todo" onClick={() => notes?.toggleTodo(todo.id, "done")}><i /><span>{todo.text}</span></button>)}
          {!pending.length && <span className="home-empty">Tudo feito.</span>}
        </div>
      </div>
    </div>
  </div>;
}

const visibleTodos = 4;
function Tasks({ notes }: { notes?: NotesControl }) {
  const [draft, setDraft] = useState("");
  // Concluir: o check é desenhado e o texto riscado antes de a tarefa sair da lista.
  const [finishing, setFinishing] = useState<string[]>([]);
  const finish = (id: string) => {
    if (!notes || finishing.includes(id)) return;
    setFinishing(value => [...value, id]);
    window.setTimeout(() => { notes.toggleTodo(id, "done"); setFinishing(value => value.filter(item => item !== id)); }, 650);
  };
  if (!notes) return <div className="statement-page"><Note>Tarefas indisponíveis.</Note></div>;
  const pending = pendingTodos(notes.notes.todos), done = notes.notes.todos.length - pending.length;
  return <div className="tasks-page">
    {/* Sem <form>: a página já vive dentro do formulário de preferências. */}
    <div className="task-new">
      <input aria-label="Nova tarefa" placeholder="Nova tarefa e Enter" maxLength={280} value={draft} onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); notes.addTodo(draft); setDraft(""); } }} />
    </div>
    <ul className="task-list" aria-label="Tarefas pendentes">
      {pending.slice(0, visibleTodos).map(todo => <li key={todo.id} className="task-item" data-done={finishing.includes(todo.id) || undefined}>
        <button type="button" className="task-check" role="checkbox" aria-checked={finishing.includes(todo.id)} aria-label={`Concluir ${todo.text}`} onClick={() => finish(todo.id)}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg></button>
        <span className="task-text">{todo.text}</span>
        <button type="button" className="task-star" aria-pressed={todo.starred} aria-label={todo.starred ? `Desfavoritar ${todo.text}` : `Favoritar ${todo.text}`} onClick={() => notes.toggleTodo(todo.id, "starred")}><svg width="13" height="13" viewBox="0 0 24 24" fill={todo.starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" /></svg></button>
        <button type="button" className="task-remove" aria-label={`Apagar ${todo.text}`} onClick={() => notes.removeTodo(todo.id)}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
      </li>)}
      {!pending.length && <li className="task-empty">{notes.state === "loading" ? <span className="hd-shimmer">Carregando</span> : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></svg>Nada pendente. Escreva acima e Enter.</>}</li>}
    </ul>
    <p className="task-footer">
      {pending.length > visibleTodos && <span>+{pending.length - visibleTodos} pendentes</span>}
      {done > 0 && <button type="button" className="text-button" onClick={notes.clearDone}>Limpar {done} concluída{done > 1 ? "s" : ""}</button>}
      {notes.error && <span className="task-error" role="alert">{notes.error}</span>}
    </p>
  </div>;
}

/** Agenda local: mês com marcas nos dias com compromisso, lista do dia e campo
 * que entende "Reunião 15:30". Lembretes saem no notch. */
const visibleEvents = 4;
const nextHour = (now: number) => { const date = new Date(now); date.setHours(date.getHours() + 1, 0, 0, 0); return `${String(date.getHours()).padStart(2, "0")}:00`; };
function Agenda({ notes, calendars, onConfigure }: { notes?: NotesControl; calendars?: CalendarsControl; onConfigure?(): void }) {
  const now = useNow(true, 60_000);
  const [day, setDay] = useState(() => { const date = new Date(); date.setHours(0, 0, 0, 0); return date; });
  const [draft, setDraft] = useState("");
  const [time, setTime] = useState(() => nextHour(Date.now()));
  const [reminders, setReminders] = useState<number[]>(defaultReminders);
  if (!notes) return <div className="statement-page"><Note>Agenda indisponível.</Note></div>;
  const month = new Date(day.getFullYear(), day.getMonth(), 1), first = (month.getDay() + 6) % 7, days = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
  const key = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  type Row = { id: string; title: string; at: number; allDay?: boolean; feed?: FeedEvent; reminders?: number[] };
  const rows: Row[] = [...notes.events.map(event => ({ id: event.id, title: event.title, at: event.at, reminders: event.reminders })), ...(calendars?.events ?? []).map(event => ({ id: event.id, title: event.title, at: event.at, allDay: event.allDay, feed: event }))];
  const marked = new Set(rows.map(row => key(new Date(row.at))));
  const today = key(new Date(now)), selected = key(day);
  const list = rows.filter(row => key(new Date(row.at)) === selected).sort((a, b) => Number(!a.allDay) - Number(!b.allDay) || a.at - b.at);
  const add = () => { const parsed = parseEventText(draft, day, now, time); if (parsed) { notes.addEvent(parsed.title, parsed.at, reminders); setDraft(""); } };
  const shift = (delta: number) => setDay(new Date(day.getFullYear(), day.getMonth() + delta, 1));
  const toggle = (minutes: number) => setReminders(reminders.includes(minutes) ? reminders.filter(item => item !== minutes) : [...reminders, minutes]);
  return <div className="agenda-page">
    <div className="cal">
      <div className="cal-head"><button type="button" className="icon-button" aria-label="Mês anterior" onClick={() => shift(-1)}>‹</button>
        <span>{(text => text.charAt(0).toUpperCase() + text.slice(1))(month.toLocaleDateString("pt-BR", { month: "long", year: "numeric" }))}</span>
        <button type="button" className="icon-button" aria-label="Próximo mês" onClick={() => shift(1)}>›</button></div>
      <div className="cal-grid">
        {["S", "T", "Q", "Q", "S", "S", "D"].map((label, index) => <span key={`h${index}`} className="cal-dow">{label}</span>)}
        {Array.from({ length: first }, (_, index) => <span key={`e${index}`} />)}
        {Array.from({ length: days }, (_, index) => {
          const date = new Date(day.getFullYear(), day.getMonth(), index + 1), id = key(date);
          return <button key={id} type="button" className="cal-day" aria-label={date.toLocaleDateString("pt-BR")} aria-current={id === today ? "date" : undefined} aria-pressed={id === selected} data-mark={marked.has(id) || undefined} onClick={() => setDay(date)}>{index + 1}</button>;
        })}
      </div>
    </div>
    <div className="agenda-day">
      <span className="agenda-title">{selected === today ? "Hoje" : (text => text.charAt(0).toUpperCase() + text.slice(1))(day.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "short" }))}
        <button type="button" className="agenda-feeds" onClick={onConfigure} title={calendars?.errors.join("\n") || "Assinar agendas do Google, iCloud ou Outlook"} data-error={calendars?.errors.length ? "" : undefined}>{calendars?.feeds.length ? `${calendars.feeds.length} agenda${calendars.feeds.length > 1 ? "s" : ""}` : "Assinar agenda"}</button></span>
      <ul className="agenda-list">
        {list.slice(0, visibleEvents).map(row => <li key={row.id} className="agenda-item" data-past={!row.allDay && row.at < now || undefined} title={row.feed ? row.feed.feed : row.reminders?.length ? `Lembretes ${row.reminders.join(" e ")} min antes` : undefined}>
          <span className="agenda-time" style={row.feed ? { color: row.feed.color } : undefined}>{row.allDay ? "dia todo" : clockOf(row.at)}</span>
          <span className="agenda-name">{row.feed && <i className="agenda-dot" style={{ background: row.feed.color }} />}<span>{row.title}</span></span>
          {row.feed ? <span /> : <button type="button" className="task-remove" aria-label={`Apagar ${row.title}`} onClick={() => notes.removeEvent(row.id)}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>}
        </li>)}
        {list.length > visibleEvents && <li className="agenda-more">+{list.length - visibleEvents} neste dia</li>}
        {!list.length && <li className="task-empty">Nada marcado.</li>}
      </ul>
      <div className="agenda-compose">
        <input className="hd-input agenda-input" aria-label="Novo compromisso" placeholder="Compromisso" maxLength={160} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
        <input className="hd-input agenda-time-input" type="time" aria-label="Horário" value={time} onChange={event => setTime(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
        {[30, 15].map(minutes => <button key={minutes} type="button" className="chip agenda-remind" aria-pressed={reminders.includes(minutes)} aria-label={`Lembrar ${minutes} min antes`} title={`Lembrar ${minutes} min antes`} onClick={() => toggle(minutes)}>{minutes}′</button>)}
        <button type="button" className="icon-button agenda-add" aria-label="Adicionar compromisso" disabled={!draft.trim()} onClick={add}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
      </div>
    </div>
  </div>;
}

function QrCode({ size, modules }: { size: number; modules: string }) {
  // Um path só com os módulos escuros; margem de 2 módulos (fundo branco no CSS).
  let d = "";
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y * size + x] === "1") d += `M${x + 2} ${y + 2}h1v1h-1z`;
  return <svg className="qr" viewBox={`0 0 ${size + 4} ${size + 4}`} shapeRendering="crispEdges" role="img" aria-label="QR code para enviar arquivos do celular"><path d={d} fill="#000" /></svg>;
}
const ago = (at: number, now: number) => { const minutes = Math.round((now - at) / 60_000); return minutes < 1 ? "agora" : minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.round(minutes / 60)} h` : new Date(at).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }); };
const icon = { folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", close: "M6 6l12 12M18 6L6 18", phone: "M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2", plus: "M12 5v14M5 12h14", drop: "M12 3v12M7 10l5 5 5-5M5 21h14" };
const Glyph = ({ d, size = 13 }: { d: string; size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
/** Nome que o celular inventa (uuid) vira "Foto"/"Vídeo"/"Arquivo" com a extensão. */
function displayName(name: string) {
  const stem = name.replace(/\.[^.]+$/, "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem) && !/^(IMG|VID|PXL)_\d/.test(stem)) return name;
  const ext = extension(name);
  return ["JPG", "JPEG", "PNG", "HEIC", "WEBP", "GIF"].includes(ext) ? `Foto · ${ext.toLowerCase()}` : ["MP4", "MOV", "3GP", "WEBM"].includes(ext) ? `Vídeo · ${ext.toLowerCase()}` : name;
}
function ShelfCard({ item, shelf, now }: { item: ShelfItem; shelf: ShelfControl; now: number }) {
  const thumb = useThumbnail(shelf.bridge, item.id);
  // Arrastar para fora: depois de mover 5 px com o botão apertado, o Windows assume o arrasto.
  const press = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  return <li className="shelf-card" title={`${item.name} · arraste para fora ou clique para abrir`}>
    <button type="button" className="shelf-thumb" aria-label={`Abrir ${item.name}`} draggable={false}
      onPointerDown={event => { if (event.button === 0) press.current = { x: event.clientX, y: event.clientY, dragged: false }; }}
      onPointerMove={event => { const start = press.current; if (!start || start.dragged || (event.buttons & 1) === 0) return; if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) { start.dragged = true; shelf.drag(item.id); } }}
      onClick={() => { const dragged = press.current?.dragged; press.current = null; if (!dragged) shelf.open(item.id); }}>
      {thumb ? <img src={thumb} alt="" draggable={false} /> : <span className="shelf-ext">{extension(item.name)}</span>}
    </button>
    <span className="shelf-name">{displayName(item.name)}</span>
    <span className="shelf-meta">{fileSize(item.size)} · {ago(item.addedAt, now)}</span>
    <span className="shelf-actions">
      <button type="button" aria-label={`Mostrar ${item.name} na pasta`} title="Mostrar na pasta" onClick={() => shelf.reveal(item.id)}><Glyph d={icon.folder} size={11} /></button>
      <button type="button" aria-label={`Tirar ${item.name} da prateleira`} title="Tirar da prateleira" onClick={() => shelf.remove(item.id)}><Glyph d={icon.close} size={11} /></button>
    </span>
  </li>;
}
/** Prateleira: arquivos entre o PC e o celular. "Celular" mostra o QR (enviar e baixar). */
function ShelfPage({ shelf }: { shelf?: ShelfControl }) {
  const now = useNow(true, 30_000);
  const picker = useRef<HTMLInputElement>(null);
  if (!shelf) return <div className="statement-page"><Note>Prateleira indisponível.</Note></div>;
  const max = shelf.receive ? 3 : 5;
  const cards = <ul className="shelf-cards">
    {shelf.items.slice(0, max).map(item => <ShelfCard key={item.id} item={item} shelf={shelf} now={now} />)}
    {shelf.items.length > max && <li className="shelf-more"><button type="button" aria-label={`Mais ${shelf.items.length - max}: mostrar ${shelf.items[max].name} na pasta`} title={`Mostrar ${shelf.items[max].name} na pasta`} onClick={() => shelf.reveal(shelf.items[max].id)}>+{shelf.items.length - max}</button></li>}
  </ul>;
  const add = <><input ref={picker} type="file" multiple hidden onChange={event => { shelf.addFiles([...(event.target.files ?? [])]); event.target.value = ""; }} />
    <button type="button" className="chip shelf-chip" onClick={() => picker.current?.click()}><Glyph d={icon.plus} size={12} />Adicionar</button></>;
  if (shelf.receive) return <div className="shelf-page shelf-receiving">
    <div className="qr-box"><QrCode size={shelf.receive.qrSize} modules={shelf.receive.qr} /></div>
    <div className="shelf-side">
      <div className="shelf-head"><b>Aponte a câmera do celular</b><span className="shelf-buttons">{add}<button type="button" className="chip shelf-chip" onClick={shelf.stop}>Parar</button></span></div>
      <span className="shelf-hint">Pelo celular dá para enviar e baixar o que está aqui. Mesma rede Wi-Fi; se o Windows perguntar, permita em redes privadas.</span>
      {shelf.items.length ? cards : <span className="shelf-hint">Os arquivos aparecem aqui.</span>}
    </div>
  </div>;
  return <div className="shelf-page" data-dragging={shelf.dragging ? "" : undefined}>
    <div className="shelf-head"><b>{shelf.items.length ? `Prateleira · ${shelf.items.length}` : "Prateleira"}</b>
      <span className="shelf-buttons">{add}<button type="button" className="chip shelf-chip" onClick={shelf.start}><Glyph d={icon.phone} size={12} />Celular</button></span></div>
    {shelf.error && <span className="shelf-hint" data-error="">{shelf.error}</span>}
    {shelf.items.length && !shelf.dragging ? cards : <div className="shelf-drop"><Glyph d={icon.drop} size={18} /><span>{shelf.dragging ? "Solte para guardar aqui" : "Arraste arquivos para o notch, use Adicionar ou clique em Celular"}</span></div>}
  </div>;
}

/** Páginas que aparecem no ciclo do notch; Início fica sempre. */
export const optionalPages = ["media", "sports", "limits", "system", "tasks", "agenda", "shelf", "prompter", "water", "pet", "note", "ask"] as const;
/** Ordem salva aplicada às páginas: Início sempre primeiro; as que não estão na
 * ordem salva (páginas novas) entram na posição padrão, depois das ordenadas. */
export function orderPages<T extends string>(pages: readonly T[], order: readonly string[] = []): T[] {
  const rank = (page: T, index: number) => page === "home" ? -1 : order.includes(page) ? order.indexOf(page) : order.length + index;
  return pages.map((page, index) => ({ page, rank: rank(page, index) })).sort((a, b) => a.rank - b.rank).map(item => item.page);
}

function PagesPrefs({ settings, editable }: { settings: ReturnType<typeof useSettings>; editable: boolean }) {
  const hidden = settings.draft.hiddenPages ?? [];
  const pages = orderPages(optionalPages, settings.draft.pageOrder);
  const toggle = (page: string) => settings.edit({ ...settings.draft, hiddenPages: hidden.includes(page) ? hidden.filter(item => item !== page) : [...hidden, page] });
  const move = (index: number, by: number) => {
    const next = [...pages]; const [page] = next.splice(index, 1); next.splice(index + by, 0, page);
    settings.edit({ ...settings.draft, pageOrder: next });
  };
  return <fieldset disabled={!editable} className="pages-prefs"><legend className="sr-only">Páginas do notch</legend>
    <span className="pages-hint">Escolha o que aparece e em que ordem. Início fica sempre primeiro.</span>
    <ol className="pages-list">{pages.map((page, index) => <li key={page} className="setting-row" data-hidden={hidden.includes(page) || undefined}>
      <span className="page-move">
        <button type="button" className="icon-button" aria-label={`Subir ${pageNames[page]}`} disabled={index === 0} onClick={() => move(index, -1)}><Glyph d="M6 15l6-6 6 6" size={13} /></button>
        <button type="button" className="icon-button" aria-label={`Descer ${pageNames[page]}`} disabled={index === pages.length - 1} onClick={() => move(index, 1)}><Glyph d="M6 9l6 6 6-6" size={13} /></button>
      </span>
      <label htmlFor={`page-${page}`}>{pageNames[page]}</label>
      <button id={`page-${page}`} type="button" className="switch" role="switch" aria-checked={!hidden.includes(page)} onClick={() => toggle(page)}><i /></button>
    </li>)}</ol>
  </fieldset>;
}

const feedColors = ["#4285F4", "#34A853", "#FBBC05", "#EA4335", "#A142F4", "#FF8A1F"];
function CalendarPrefs({ calendars }: { calendars?: CalendarsControl }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  if (!calendars) return <div className="statement-page"><Note>Agendas indisponíveis.</Note></div>;
  const keep = calendars.feeds.map(feed => ({ id: feed.id, name: feed.name, color: feed.color }));
  const run = (inputs: Parameters<CalendarsControl["save"]>[0], done: string) => { setStatus("Salvando…"); calendars.save(inputs).then(() => { setStatus(done); setName(""); setUrl(""); }).catch(error => setStatus(String(error?.message ?? error))); };
  const add = () => {
    if (!url.trim()) return;
    const color = feedColors.find(color => !calendars.feeds.some(feed => feed.color === color)) ?? feedColors[0];
    run([...keep, { id: `f${Date.now().toString(36)}`, name: name.trim(), color, url: url.trim() }], "Agenda adicionada. Os eventos chegam em alguns segundos.");
  };
  return <div className="calendar-prefs">
    <ul className="feed-list">
      {calendars.feeds.map(feed => <li key={feed.id} className="feed-row"><i className="agenda-dot" style={{ background: feed.color }} /><b>{feed.name}</b><span>{feed.host}</span>
        <button type="button" className="task-remove" aria-label={`Remover ${feed.name}`} onClick={() => run(keep.filter(item => item.id !== feed.id), "Agenda removida.")}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button></li>)}
      {!calendars.feeds.length && <li className="feed-help">Google: Configurações da agenda › <b>Endereço secreto no formato iCal</b>. iCloud: Compartilhar › <b>Calendário público</b>. Só leitura.</li>}
    </ul>
    <div className="feed-add">
      <input className="hd-input" aria-label="Nome da agenda" placeholder="Nome" maxLength={40} value={name} onChange={event => setName(event.target.value)} />
      <input className="hd-input" aria-label="Link ICS da agenda" placeholder="https://… ou webcal://…" value={url} onChange={event => setUrl(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
      <button type="button" className="save-button" disabled={!url.trim()} onClick={add}>Assinar</button>
    </div>
    <span className="feed-status" aria-live="polite">{status ?? (calendars.errors.length ? calendars.errors.join(" · ") : calendars.feeds.length ? "Atualiza a cada 15 min. O link fica só neste computador." : "")}</span>
  </div>;
}

const liters = (ml: number) => (ml / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
/** Água (Nusa): total do dia contra a meta, um toque para registrar o copo, gráfico por hora. */
function WaterPage({ notes }: { notes?: NotesControl }) {
  const now = useNow(true, 30_000);
  if (!notes) return <div className="statement-page"><Note>Água indisponível.</Note></div>;
  const water = notes.water, plan = waterPlan(water, now), settings = waterSettings(water);
  const total = plan.drunk, share = Math.min(100, Math.round(total / water.goalMl * 100));
  const last = water.log[water.log.length - 1];
  const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (plan.due) {
    const copy = waterCopy(plan, water, now);
    return <div className="water-due" data-level={plan.level}>
      <svg className="water-due-icon" width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5s-6.5 7.2-6.5 12A6.5 6.5 0 0 0 18.5 14.5C18.5 9.7 12 2.5 12 2.5z" /></svg>
      <div className="water-due-text"><strong>{copy.title}</strong><span>{copy.sub}</span><span className="water-due-meta">Hoje {liters(total)} de {liters(water.goalMl)} L · {share}%</span></div>
      <div className="water-due-actions">
        <button type="button" className="water-yes" onClick={() => plan.due === "refill" ? notes.refillWater() : notes.drink()}>{copy.yes}</button>
        <button type="button" className="water-no" onClick={notes.refuseWater}>{copy.no}</button>
      </div>
    </div>;
  }
  const status = !water.reminders ? "Lembretes desligados"
    : share >= 100 ? "Meta batida hoje"
    : !plan.active ? `Lembretes ${weekdays(settings.days)}, ${minuteClock(settings.start)}–${minuteClock(settings.end)}`
    : plan.nextAt ? `Próximo gole às ${hhmm(plan.nextAt)}` : "";
  // Linha do tempo do período: goles já bebidos (cheios) e previstos (vazados).
  const span = Math.max(1, plan.to - plan.from), place = (time: number) => `${Math.min(100, Math.max(0, (time - plan.from) / span * 100))}%`;
  const today = water.log.filter(drink => drink.at >= plan.from - 12 * 3_600_000 && new Date(drink.at).toDateString() === new Date(now).toDateString());
  const ring = 2 * Math.PI * 40;
  const bottleShare = Math.round(settings.left / settings.bottle * 100);
  return <div className="water-page2">
    <div className="water-ring" role="img" aria-label={`${liters(total)} de ${liters(water.goalMl)} litros, ${share}%`}>
      <svg viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="48" r="40" className="water-ring-track" /><circle cx="48" cy="48" r="40" className="water-ring-fill" style={{ strokeDasharray: ring, strokeDashoffset: ring * (1 - share / 100) }} /></svg>
      <span><b><Digits value={liters(total)} /></b><small>de {liters(water.goalMl)} L</small></span>
    </div>
    <div className="water-info">
      <div className="water-head"><span className="water-title">Água · {share}%</span>
        <button type="button" className="switch" role="switch" aria-checked={water.reminders} aria-label="Lembretes de água" onClick={() => notes.setWater({ reminders: !water.reminders })}><i /></button>
</div>
      <span className="water-sub">{status}{plan.active && plan.sipsLeft > 0 ? ` · faltam ${plan.sipsLeft} gole${plan.sipsLeft > 1 ? "s" : ""}` : ""}</span>
      <div className="water-actions">
        <button type="button" className="water-drink" onClick={() => notes.drink()}><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5s-6.5 7.2-6.5 12A6.5 6.5 0 0 0 18.5 14.5C18.5 9.7 12 2.5 12 2.5z" /></svg>Beber {settings.sip} ml</button>
        <button type="button" className="water-bottle" data-low={settings.left < settings.sip || undefined} aria-label={`Garrafa com ${settings.left} de ${settings.bottle} ml. Encher`} onClick={notes.refillWater}>
          <span className="water-bottle-glass" aria-hidden="true"><i style={{ transform: `scaleY(${bottleShare / 100})` }} /></span>
          <span className="water-bottle-text"><b>{settings.left} ml</b><small>{settings.left < settings.sip ? "encher" : "na garrafa"}</small></span>
        </button>
        <button type="button" className="icon-button" aria-label="Desfazer último gole" disabled={!last || now - last.at > 86_400_000} onClick={notes.undoDrink}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" /></svg></button>
      </div>
      <div className="water-timeline" aria-label="Goles de hoje e previstos">
        <span className="water-track"><i className="water-now" style={{ left: place(now) }} />
          {today.map(drink => <i key={drink.at} className="water-dot" data-done="" style={{ left: place(drink.at) }} />)}
          {plan.upcoming.map(time => <i key={time} className="water-dot" style={{ left: place(time) }} />)}
        </span>
        <span className="water-axis2"><span>{minuteClock(settings.start)}</span><span>{minuteClock(settings.end)}</span></span>
      </div>
    </div>
  </div>;
}

const dayLetters = ["D", "S", "T", "Q", "Q", "S", "S"], dayNames = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const minuteClock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const minutesOf = (text: string) => { const [h, m] = text.split(":").map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null; };
function weekdays(days: number[]) {
  const sorted = [...days].sort();
  if (sorted.join() === "1,2,3,4,5") return "de segunda a sexta";
  if (sorted.length === 7) return "todos os dias";
  return sorted.map(day => dayNames[day]).join(", ");
}

/** Ajustes da água: meta, gole, garrafa, período, dias e soneca de 15 min. */
function WaterSettings({ notes, onDone }: { notes: NotesControl; onDone(): void }) {
  const water = notes.water, settings = waterSettings(water), sips = Math.ceil(water.goalMl / settings.sip);
  const ml = (value: string, min: number, max: number) => { const n = Math.round(Number(value)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null; };
  return <div className="water-settings">
    <div className="water-head"><span className="water-title">Ajustes da água</span><button type="button" className="chip" onClick={onDone}>Pronto</button></div>
    <div className="water-form">
      <label>Meta do dia<span><input className="hd-input" type="number" min="0.5" max="10" step="0.25" value={water.goalMl / 1000} onChange={event => { const n = Number(event.target.value); if (n >= .5 && n <= 10) notes.setWater({ goalMl: Math.round(n * 1000) }); }} />L</span></label>
      <label>Gole<span><input className="hd-input" type="number" min="50" max="1000" step="50" value={settings.sip} onChange={event => { const n = ml(event.target.value, 50, 1000); if (n) notes.setWater({ cupMl: n }); }} />ml</span></label>
      <label>Garrafa<span><input className="hd-input" type="number" min="100" max="3000" step="50" value={settings.bottle} onChange={event => { const n = ml(event.target.value, 100, 3000); if (n) notes.setWater({ bottleMl: n, bottleLeftMl: Math.min(n, settings.left) }); }} />ml</span></label>
      <label>Período<span><input className="hd-input" type="time" value={minuteClock(settings.start)} onChange={event => { const n = minutesOf(event.target.value); if (n != null && n < settings.end) notes.setWater({ startMin: n }); }} />às<input className="hd-input" type="time" value={minuteClock(settings.end)} onChange={event => { const n = minutesOf(event.target.value); if (n != null && n > settings.start) notes.setWater({ endMin: n }); }} /></span></label>
      <div className="water-days" role="group" aria-label="Dias com lembrete">{dayLetters.map((letter, day) => <button key={day} type="button" className="chip" aria-pressed={settings.days.includes(day)} aria-label={dayNames[day]} onClick={() => notes.setWater({ days: settings.days.includes(day) ? settings.days.filter(item => item !== day) : [...settings.days, day].sort() })}>{letter}</button>)}</div>
      <label className="water-snooze-row">Soneca de {SNOOZE_MIN} min ao recusar<button type="button" className="switch" role="switch" aria-checked={settings.snooze} aria-label="Soneca ao recusar" onClick={() => notes.setWater({ snooze: !settings.snooze })}><i /></button></label>
    </div>
    <span className="water-hint">{sips} goles de {settings.sip} ml, {weekdays(settings.days)}, das {minuteClock(settings.start)} às {minuteClock(settings.end)}: um a cada ~{Math.round((settings.end - settings.start) / sips)} min.</span>
  </div>;
}

function QuickNote({ notes }: { notes?: NotesControl }) {
  if (!notes) return <div className="statement-page"><Note>Nota indisponível.</Note></div>;
  const status = notes.state === "error" ? notes.error : notes.state === "saving" ? "salvando…" : notes.state === "loading" ? "carregando…" : notes.notes.note ? "salvo" : "";
  return <div className="note-page">
    <textarea aria-label="Nota rápida" placeholder="Escreva algo rápido…" maxLength={20000} value={notes.notes.note} disabled={notes.state === "loading"} onChange={event => notes.setNote(event.target.value)} />
    <span className="note-status" role={notes.state === "error" ? "alert" : undefined}>{status}</span>
  </div>;
}

const askIcons = {
  stop: "M8 8h8v8H8z",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  clear: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  shrink: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
  send: "M12 19V5M5 12l7-7 7 7",
  check: "M5 12l5 5L20 7",
};
function AskIcon({ name }: { name: keyof typeof askIcons }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={askIcons[name]} /></svg>;
}
function AskPage({ ask }: { ask?: AskControl & { tall: boolean; setTall(value: boolean): void } }) {
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const last = ask?.history[ask.history.length - 1];
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [last?.answer, ask?.history.length, ask?.tall]);
  // O campo fica desabilitado durante a resposta e perde o foco; devolve ao terminar.
  const field = useRef<HTMLInputElement>(null);
  const wasBusy = useRef(false);
  useEffect(() => { if (wasBusy.current && !ask?.busy) field.current?.focus(); wasBusy.current = Boolean(ask?.busy); }, [ask?.busy]);
  if (!ask?.available) return <div className="statement-page"><Note>O Ask usa o Claude Code instalado; disponível no app desktop.</Note></div>;
  const send = () => { void ask.ask(draft); setDraft(""); };
  const copy = (text: string, key: string) => { void navigator.clipboard?.writeText(text).then(() => { setCopied(key); window.setTimeout(() => setCopied(""), 1200); }).catch(() => {}); };
  // Compacto: só a última troca. Expandido: a conversa inteira, com rolagem própria.
  const turns = ask.tall ? ask.history : last ? [last] : [];
  return <div className="ask-page" data-tall={ask.tall || undefined}>
    <div className="ask-log" ref={log} data-scroll={ask.tall ? "" : undefined} aria-live="polite">
      {turns.length ? turns.map((turn, index) => <div className="ask-turn" key={index}>
        <p className="ask-question">{turn.question}</p>
        {turn.error ? <p className="ask-error" role="alert">{turn.error}</p>
          : turn.answer ? <p className="ask-text">{turn.answer.split(/(\s+)/).map((word, at) => <span className="hd-word" key={at}>{word}</span>)}</p>
          : ask.busy && turn === last ? <p className="ask-text"><span className="hd-shimmer">Pensando</span></p> : null}
        {turn.answer && !(ask.busy && turn === last) && <button type="button" className="icon-button ask-copy" data-done={copied === String(index) || undefined} aria-label={copied === String(index) ? "Copiado" : "Copiar resposta"} title="Copiar resposta" onClick={() => copy(turn.answer, String(index))}><AskIcon name={copied === String(index) ? "check" : "copy"} /></button>}
      </div>) : <div className="ask-empty">
        <p className="ask-model"><svg className="claude-mark" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">{Array.from({ length: 12 }, (_, ray) => <rect key={ray} x="11.1" y="1.5" width="1.8" height="9" rx=".9" transform={`rotate(${ray * 30} 12 12)`} />)}</svg>Haiku 5.5<span>· esforço médio</span></p>
        <div className="ask-suggestions">{["Escreva um e-mail curto pedindo um prazo", "Me dê 3 ideias de nome", "Explique um conceito em uma frase"].map(text => <button key={text} type="button" className="chip" onClick={() => { setDraft(text); field.current?.focus(); }}>{text}</button>)}</div>
      </div>}
    </div>
    <div className="ask-bar">
      <input ref={field} aria-label="Pergunta ao Claude" placeholder={ask.busy ? "Respondendo…" : "Pergunte e Enter"} maxLength={2000} value={draft} disabled={ask.busy}
        onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); send(); } }} />
      <button type="button" className="icon-button" aria-label="Limpar conversa" title="Limpar conversa" disabled={ask.busy || !ask.history.length} onClick={ask.clear}><AskIcon name="clear" /></button>
      <button type="button" className="icon-button" aria-label={ask.tall ? "Reduzir conversa" : "Expandir conversa"} aria-pressed={ask.tall} title={ask.tall ? "Reduzir" : "Expandir"} onClick={() => ask.setTall(!ask.tall)}><AskIcon name={ask.tall ? "shrink" : "expand"} /></button>
      {ask.busy ? <button type="button" className="icon-button ask-send" data-busy="" aria-label="Parar resposta" title="Parar" onClick={ask.cancel}><AskIcon name="stop" /></button>
        : <button type="button" className="icon-button ask-send" aria-label="Enviar pergunta" title="Enviar" disabled={!draft.trim()} onClick={send}><AskIcon name="send" /></button>}
    </div>
  </div>;
}

export const glowPresets: Record<Exclude<MascotSettings["glow"], "custom">, [string, string, string]> = {
  aurora: ["#19b8ff", "#2d5bff", "#7b4bff"], amber: ["#ffb300", "#ffd34d", "#ff8a1f"], mint: ["#2ee6a6", "#19c37d", "#0fb5a0"],
  rose: ["#ff5fa2", "#ff3d7f", "#c84bff"], mono: ["#8a8a8a", "#d4d4d4", "#6f6f6f"],
};
export const glowNames: Record<keyof typeof glowPresets, string> = { aurora: "Aurora", amber: "Âmbar", mint: "Menta", rose: "Rosa", mono: "Neutro" };
export const eyeColors: [string, string][] = [["#FFFFFF", "Branco"], ["#FFE08A", "Amarelo"], ["#9FE8FF", "Azul-claro"], ["#B9FFB0", "Verde-claro"], ["#FFB3D9", "Rosa"]];
export const shapes: [EyeShape, string][] = [["oval", "Oval"], ["round", "Redondo"], ["pixel", "Pixel"], ["line", "Traço"], ["heart", "Coração"]];
function MascotPrefs({ settings, editable }: { settings: ReturnType<typeof useSettings>; editable: boolean }) {
  const mascot = { ...defaultMascot, ...settings.draft.mascot };
  const set = (patch: Partial<MascotSettings>) => settings.edit({ ...settings.draft, mascot: { ...mascot, ...patch } });
  // A prévia é o próprio mascote do painel, que já usa o rascunho.
  return <fieldset disabled={!editable} className="mascot-prefs"><legend className="sr-only">Mascote</legend>
    <div className="pref-rows">
      <div className="pref-row"><span>Olhos</span><div className="pref-options">{shapes.map(([shape, label]) => <button key={shape} type="button" className="shape-option" aria-pressed={mascot.eyeShape === shape} aria-label={label} title={label} onClick={() => set({ eyeShape: shape })}><Mascot expression="normal" active={false} reducedMotion shape={shape} /></button>)}</div></div>
      <div className="pref-row"><span>Cor</span><div className="pref-options">{eyeColors.map(([color, label]) => <button key={color} type="button" className="swatch" style={{ ["--swatch" as string]: color }} aria-pressed={mascot.eyeColor.toUpperCase() === color} aria-label={`Olhos ${label.toLowerCase()}`} title={label} onClick={() => set({ eyeColor: color })} />)}<input type="color" aria-label="Cor livre dos olhos" value={mascot.eyeColor} onChange={event => set({ eyeColor: event.target.value.toUpperCase() })} /></div></div>
      <div className="pref-row"><span>Brilho</span><div className="pref-options">{(Object.keys(glowPresets) as (keyof typeof glowPresets)[]).map(name => <button key={name} type="button" className="swatch" style={{ ["--swatch" as string]: `linear-gradient(135deg, ${glowPresets[name].join(", ")})` }} aria-pressed={mascot.glow === name} aria-label={`Brilho ${glowNames[name].toLowerCase()}`} title={glowNames[name]} onClick={() => set({ glow: name })} />)}<input type="color" aria-label="Brilho livre" value={mascot.glowColor} onChange={event => set({ glow: "custom", glowColor: event.target.value.toUpperCase() })} /></div></div>
      <div className="pref-row"><span>Animar</span><div className="pref-options">
        {([["blink", "Piscar"], ["look", "Olhar"], ["reactions", "Reações"], ["bounce", "Quique"]] as const).map(([key, label]) => <button key={key} type="button" className="chip" aria-pressed={mascot[key]} onClick={() => set({ [key]: !mascot[key] })}>{label}</button>)}
        <button type="button" className="chip" aria-pressed={mascot.inPanel !== false} title="Mascote também no painel aberto; desligado, fica só no notch" onClick={() => set({ inPanel: mascot.inPanel === false })}>No painel</button>
        <button type="button" className="chip" aria-pressed={mascot.pace === "lively"} onClick={() => set({ pace: mascot.pace === "lively" ? "calm" : "lively" })}>{mascot.pace === "lively" ? "Animado" : "Calmo"}</button>
      </div></div>
    </div>
  </fieldset>;
}

function SoundPrefs({ settings, editable }: { settings: ReturnType<typeof useSettings>; editable: boolean }) {
  const sounds = { ...defaultSounds, ...settings.draft.sounds };
  const set = (patch: Partial<SoundSettings>) => settings.edit({ ...settings.draft, sounds: { ...sounds, ...patch } });
  return <fieldset disabled={!editable} className="pref-rows"><legend className="sr-only">Sons</legend>
    <div className="pref-row"><span>Sons</span><div className="pref-options"><button type="button" className="switch" role="switch" aria-checked={sounds.enabled} aria-label="Sons ligados" onClick={() => set({ enabled: !sounds.enabled })}><i /></button>
      <input type="range" min="0" max="100" aria-label="Volume dos sons" style={{ ["--fill" as string]: `${sounds.volume}%` }} value={sounds.volume} onChange={event => set({ volume: Number(event.target.value) })} /><output>{sounds.volume}%</output></div></div>
    <div className="pref-row"><span>Pacote</span><div className="pref-options">{([["soft", "Suave"], ["retro", "Retrô"], ["minimal", "Mínimo"]] as const).map(([pack, label]) => <button key={pack} type="button" className="chip" aria-pressed={sounds.pack === pack} onClick={() => { set({ pack }); playSound("notification", pack, sounds.volume); }}>{label}</button>)}
      <button type="button" className="chip" onClick={() => playSound("reminder", sounds.pack, sounds.volume)}>▶ Testar</button></div></div>
    <div className="pref-row"><span>Tocar em</span><div className="pref-options">{([["notifications", "Notificações"], ["reminders", "Lembretes"], ["sports", "Esportes"], ["interactions", "Interações"]] as const).map(([key, label]) => <button key={key} type="button" className="chip" aria-pressed={sounds[key]} onClick={() => set({ [key]: !sounds[key] })}>{label}</button>)}</div></div>
    <div className="pref-row"><span>Silêncio</span><div className="pref-options"><button type="button" className="switch" role="switch" aria-checked={sounds.respectDnd} aria-label="Respeitar o Não perturbe" onClick={() => set({ respectDnd: !sounds.respectDnd })}><i /></button><span>Respeitar o Não perturbe e tela cheia</span></div></div>
  </fieldset>;
}

export function ContextPages({ page, bridge, settings, context, editable, setColorPickerActive, awake, notes, ask, sports, go, notificationStatus, calendars, shelf, recorder, ghost, pet, reducedMotion = false }: {
  page: ContextPage; bridge: ShellBridge; settings: ReturnType<typeof useSettings>; context: ReturnType<typeof useContextSnapshots>; editable: boolean; setColorPickerActive(active: boolean): void;
  awake?: KeepAwakeControl; notes?: NotesControl; ask?: AskControl & { tall: boolean; setTall(value: boolean): void }; sports?: SportsControl; go?(page: ContextPage): void; notificationStatus?: string; calendars?: CalendarsControl; shelf?: ShelfControl; recorder?: RecorderControl; ghost?: boolean;
  pet?: PetControl; reducedMotion?: boolean;
}) {
  const saved = settings.saved.modules;
  const data = context.desktop.value;
  if (page === "home") return <Home context={context} media={saved.media ? data?.media : null} notes={notes} go={go ?? (() => {})} bridge={bridge} calendars={calendars} />;
  if (page === "tasks") return <Tasks notes={notes} />;
  if (page === "note") return <QuickNote notes={notes} />;
  if (page === "water") return <WaterPage notes={notes} />;
  if (page === "pet") return <PetPage pet={pet} reducedMotion={reducedMotion} />;
  if (page === "prompter") return <PrompterPage notes={notes} recorder={recorder} ghost={ghost} />;
  if (page === "shelf") return <ShelfPage shelf={shelf} />;
  if (page === "agenda") return <Agenda notes={notes} calendars={calendars} onConfigure={() => go?.("calendarPrefs")} />;
  if (page === "calendarPrefs") return <CalendarPrefs calendars={calendars} />;
  if (page === "waterPrefs") return notes ? <WaterSettings notes={notes} onDone={() => go?.("water")} /> : null;
  if (page === "pagesPrefs") return <PagesPrefs settings={settings} editable={editable} />;
  if (page === "mascotPrefs") return <MascotPrefs settings={settings} editable={editable} />;
  if (page === "soundPrefs") return <SoundPrefs settings={settings} editable={editable} />;
  if (page === "ask") return <AskPage ask={ask} />;
  if (page === "sports") return <SportsPage sports={sports} onConfigure={() => go?.("sportsPrefs")} />;
  if (page === "sportsPrefs") return <SportsPreferences sports={sports} bridge={bridge} />;
  if (page === "media") return <Player media={saved.media ? data?.media : null} bridge={bridge} enabled={saved.media} stale={context.desktop.failed} />;
  if (page === "limits") return <Claude bridge={bridge} enabled={saved.claudeUsage !== false} context={context} />;
  if (page === "system") return <System data={data} enabled={saved.systemInfo} previous={context.desktop.failed} network={context.network ?? []} awake={awake} />;
  if (page === "appearance") return <fieldset disabled={!editable} className="appearance-fields"><legend className="sr-only">Aparência da ilha</legend><div className="setting-row opacity-row"><label htmlFor="opacity">Opacidade do compacto <output htmlFor="opacity">{settings.draft.appearance.opacity}%</output></label><input id="opacity" disabled={!editable} type="range" min="30" max="100" step="1" style={{ ["--fill" as string]: `${(settings.draft.appearance.opacity - 30) / 70 * 100}%` }} value={settings.draft.appearance.opacity} onChange={event => settings.edit({ ...settings.draft, appearance: { ...settings.draft.appearance, opacity: Number(event.target.value) } })} /></div><div className="setting-row"><label htmlFor="accent-color">Cor de destaque</label><input id="accent-color" disabled={!editable} type="color" value={settings.draft.appearance.accentColor} onClick={() => setColorPickerActive(true)} onChange={event => { setColorPickerActive(false); settings.edit({ ...settings.draft, appearance: { ...settings.draft.appearance, accentColor: event.target.value.toUpperCase() } }); }} /></div><div className="setting-row"><span id="reduced-motion">Movimento reduzido</span><div className="segmented" role="radiogroup" aria-labelledby="reduced-motion">{([["system", "Sistema"], ["on", "Reduzido"], ["off", "Completo"]] as const).map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={settings.draft.motion.reducedMotion === value} onClick={() => settings.edit({ ...settings.draft, motion: { reducedMotion: value } })}>{label}</button>)}</div></div></fieldset>;

  return <fieldset disabled={!editable} className="module-fields"><legend className="sr-only">Módulos da ilha</legend>{([ ["claudeUsage", "Uso do Claude"], ["hideInFullscreen", "Ocultar em tela cheia"], ["notifications", "Avisos do WhatsApp"], ["systemInfo", "CPU e memória"], ["media", "Player do Windows"], ["weather", "Clima no compacto"] ] as const).map(([key, label]) => <div className="setting-row" key={key}><label htmlFor={`module-${key}`}>{label}{key === "notifications" && notificationStatus && notificationStatus !== "on" && notificationStatus !== "off" && <span className="module-city" title={notificationStatus === "denied" ? "Permita em Configurações › Privacidade › Notificações" : undefined}>{notificationStatus === "denied" ? "Permita em Configurações › Privacidade › Notificações" : "Indisponível neste Windows"}</span>}{key === "weather" && <span className="module-city" title="Local configurado, sem localização automática">{settings.draft.weatherLocation?.city ?? "Local não configurado"}</span>}</label><button id={`module-${key}`} type="button" className="switch" role="switch" disabled={!editable} aria-checked={settings.draft.modules[key] !== false} onClick={() => settings.edit({ ...settings.draft, modules: { ...settings.draft.modules, [key]: settings.draft.modules[key] === false } })}><i /></button></div>)}<button type="button" className="module-pages" onClick={() => go?.("pagesPrefs")}>Páginas do notch<span>{optionalPages.length - (settings.draft.hiddenPages?.length ?? 0)} de {optionalPages.length} visíveis ›</span></button></fieldset>;
}
