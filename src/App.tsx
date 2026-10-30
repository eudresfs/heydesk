import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { createShellBridge, type ShellBridge } from "./lib/shellBridge";
import { useIsland } from "./hooks/useIsland";
import { useSettings } from "./hooks/useSettings";
import { useReducedMotion } from "./hooks/useReducedMotion";
import { useContextSnapshots } from "./modules/context/useContext";
import { ContextPages, orderPages, pageNames, quotaLow, useLyricIndex, useLyrics, useNow, type ContextPage, weatherLabel } from "./modules/context/ContextPages";
import { useLyricsOn } from "./modules/context/lyricsStore";
import { Mascot, type MascotExpression } from "./modules/context/Mascot";
import { useMascotPresence } from "./modules/context/useMascotPresence";
import { usePageMotion } from "./modules/motion/usePageMotion";
import { WheelPaging } from "./modules/navigation/wheelPaging";
import { useActivity, useActivityPush } from "./modules/activity/useActivity";
import { toastHeight, toastView } from "./modules/activity/activity";
import type { Activity } from "./modules/activity/activity";
import { useMascotTouch } from "./modules/context/useMascotTouch";
import { defaultReminders, dueReminders, useNotes } from "./modules/context/useNotes";
import { waterCopy, waterPlan } from "./modules/context/waterPlan";
import { useAsk } from "./modules/context/useAsk";
import { useSports } from "./modules/sports/useSports";
import { useCalendars } from "./modules/context/useCalendars";
import { fileSize, useShelf } from "./modules/context/useShelf";
import { clock as recClock, recordedMs, useRecorder } from "./modules/prompter/useRecorder";
import { PrompterGrip } from "./modules/prompter/PrompterPage";
import { Tooltips } from "./components/Tooltips";
import { glowPresets } from "./modules/context/ContextPages";
import { defaultMascot, defaultSounds } from "./lib/shellBridge";
import { playSound, soundCategory, type SoundKind } from "./modules/sound/sounds";
import type { BodySize } from "./modules/motion/spring";

// O rolo vertical do painel aberto. Hora e clima ficam só no compacto.
const tallAsk = { width: 580, height: 380 } as const;
/** Início tem tamanho próprio, mais largo e alto (como o OmniNotch). */
export const homeSize = { width: 640, height: 280 } as const;
/** Teleprompter: mais alto, para várias linhas abaixo da câmera. */
const prompterSize = { width: 600, height: 300 } as const;
const settingsPageIds: ContextPage[] = ["appearance", "modules", "pagesPrefs", "mascotPrefs", "soundPrefs", "sportsPrefs", "calendarPrefs", "waterPrefs"];
const allContextPages: ContextPage[] = ["home", "media", "sports", "limits", "system", "tasks", "agenda", "shelf", "prompter", "water", "note", "ask"];
function editableTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('input, select, textarea, [contenteditable]:not([contenteditable=false])'));
}
function useClock() {
  const format = () => new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const [clock, setClock] = useState(format);
  useEffect(() => { const timer = window.setInterval(() => setClock(format()), 1000); return () => window.clearInterval(timer); }, []);
  return clock;
}
/** Sigla curta do time para o compacto: a sigla oficial ou o nome em até 5 letras. */
function teamTag(side: { short: string; name: string }) {
  const tag = side.short && side.short.length <= 5 ? side.short : side.name.replace(/^(team|the)\s+/i, "").split(/\s+/)[0];
  return tag.length > 6 ? tag.slice(0, 5) : tag;
}
const pageIcons: Partial<Record<ContextPage, string>> = {
  home: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  media: "M9 18V5l11-2v13M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zM20 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z",
  sports: "M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4",
  limits: "M5 20V12M10 20V6M15 20v-9M20 20V4",
  system: "M7 7h10v10H7zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3",
  tasks: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2",
  agenda: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  shelf: "M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5",
  prompter: "M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM7.5 8h9M8.5 11h7M10 14h4M12 17v3M8 20h8",
  water: "M12 3s-6 6.6-6 11a6 6 0 0 0 12 0c0-4.4-6-11-6-11z",
  note: "M6 3h9l4 4v14H6zM9 12h7M9 16h5",
  ask: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
};
function PageIcon({ page }: { page: ContextPage }) {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={pageIcons[page] ?? pageIcons.home} /></svg>;
}
function ActivityIcon({ icon }: { icon: Activity["icon"] }) {
  const paths = { plug: "M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5", battery: "M3 8h15v8H3zM21 11v2M6 11v2", note: "M9 18V5l11-2v13M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zM20 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z", ball: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7l4 3-1.5 4.5h-5L8 10z", drop: "M12 2.5s-6.5 7.2-6.5 12A6.5 6.5 0 0 0 18.5 14.5C18.5 9.7 12 2.5 12 2.5z", volume: "M11 5L6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14", mute: "M11 5L6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6", wifi: "M5 12.6a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 20h.01", offline: "M2 2l20 20M8.5 16a5 5 0 0 1 7 0M5 12.6a10 10 0 0 1 5.2-2.7M16.7 10.4A10 10 0 0 1 19 12.6M12 20h.01", message: "M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 21l2.1-5.6A8.4 8.4 0 1 1 21 11.5z", file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5", calendar: "M3 5h18v16H3zM3 10h18M8 3v4M16 3v4" };
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[icon]} /></svg>;
}

export default function App({ bridge: suppliedBridge }: { bridge?: ShellBridge }) {
  const [bridge] = useState(() => suppliedBridge ?? createShellBridge());
  const settings = useSettings(bridge);
  const hiddenPages = settings.saved.hiddenPages ?? [];
  const contextPages = orderPages(allContextPages, settings.saved.pageOrder).filter(key => key === "home" || !hiddenPages.includes(key));
  const [page, setPage] = useState<ContextPage>("home");
  const [menuOpen, setMenuOpen] = useState(false);
  const [colorPickerActive, setColorPickerActive] = useState(false);
  const [keyboardPage, setKeyboardPage] = useState(false);
  const reducedMotion = useReducedMotion(settings.draft.motion.reducedMotion);
  // A atividade é decidida depois da leitura do desktop; o tamanho chega à ilha no render seguinte.
  const [activitySize, setActivitySize] = useState<BodySize | null>(null);
  // Pin: o painel fica aberto com o cursor fora e ao clicar em outro app; Escape fecha.
  const [pinned, setPinned] = useState(false);
  // Ask expandido: o painel cresce para mostrar a conversa; vale só no Ask.
  const [askTall, setAskTall] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  // Arquivo sendo arrastado do Explorador: o notch abre na Prateleira e espera o soltar.
  const [fileDrag, setFileDrag] = useState(false);
  const calendars = useCalendars(bridge);
  const notes = useNotes(bridge);
  // Água: plano do dia (próximo gole, garrafa, humor); relido a cada 30 s.
  const waterTick = useNow(true, 30_000);
  const waterNow = notes.state !== "loading" ? waterPlan(notes.water, waterTick) : null;
  const waterPending = Boolean(waterNow?.due);
  // Lembrete de água ignorado: o mascote muda de humor e, bravo, fica vermelho (olhos e brilho).
  const waterLevel = waterPending ? waterNow?.level ?? 0 : -1;
  const waterMood: MascotExpression = waterLevel >= 2 ? "angry" : waterLevel === 1 ? "worried" : "wide";
  const waterAngry = waterLevel >= 2;
  const recorder = useRecorder(bridge);
  const [prompterDrag, setPrompterDrag] = useState<number | null>(null);
  const island = useIsland(bridge, fileDrag || (recorder.busy || recorder.countdown != null) && page === "prompter" || prompterDrag != null || pinned || settings.dirty || settings.saveState === "saving" || colorPickerActive || menuOpen, reducedMotion, activitySize, askTall && askOpen ? tallAsk : page === "home" ? homeSize : page === "prompter" ? { width: prompterSize.width, height: prompterDrag ?? notes.prompter.height ?? prompterSize.height } : null, prompterDrag != null ? 440 : 0, waterPending);
  // Tela cheia (jogo, vídeo) esconde a ilha no Rust: leituras e animações pausam junto.
  const [occluded, setOccluded] = useState(false);
  useEffect(() => {
    if (!bridge.onDesktopEvent) return;
    let stop: (() => void) | undefined, active = true;
    void bridge.onDesktopEvent("shell:occluded", payload => setOccluded(payload === true)).then(fn => { if (active) stop = fn; else fn(); });
    return () => { active = false; stop?.(); };
  }, [bridge]);
  const away = island.hidden || occluded;
  const pageMotion = usePageMotion<ContextPage>("home", reducedMotion || !island.expanded || island.hidden);
  const context = useContextSnapshots(bridge, settings.loadState === "ready" && !away, settings.saved.modules, island.expanded);
  const clock = useClock();
  const assistant = useAsk(bridge);
  const sports = useSports(bridge, settings.loadState === "ready");
  const heading = useRef<HTMLHeadingElement>(null);
  const preferencesButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const openButton = useRef<HTMLButtonElement | null>(null);
  const menuKeyboard = useRef(false);
  const compactRef = useCallback((node: HTMLButtonElement | null) => { openButton.current = node; island.compactRef(node); }, [island.compactRef]);
  const [wheel] = useState(() => new WheelPaging());
  const editable = bridge.desktop && settings.loadState === "ready";
  const preferences = page === "appearance" || page === "modules" || page === "sportsPrefs" || page === "calendarPrefs" || page === "pagesPrefs" || page === "mascotPrefs" || page === "soundPrefs";
  const desktop = context.desktop.value;
  const weather = settings.saved.modules.weather && !context.desktop.failed && desktop?.weather?.state === "ready" ? desktop.weather : null;
  const playing = Boolean(settings.saved.modules.media && !context.desktop.failed && desktop?.media?.state === "playing");
  // Keep Awake vale só nesta sessão do app. Com ele ligado o mascote também não cochila.
  const [awakeOn, setAwakeOn] = useState(false);
  const [awakeError, setAwakeError] = useState("");
  useEffect(() => { void bridge.getKeepAwake?.().then(setAwakeOn).catch(() => {}); }, [bridge]);
  const awake = { on: awakeOn, available: Boolean(bridge.desktop && bridge.setKeepAwake), error: awakeError, toggle: () => {
    setAwakeError("");
    void bridge.setKeepAwake?.(!awakeOn).then(setAwakeOn).catch(error => setAwakeError(typeof error === "string" ? error : "Não foi possível mudar."));
  } };
  const presence = useMascotPresence(bridge, { enabled: settings.loadState === "ready" && !island.expanded && !away, hovered: island.hovered, playing: playing || awakeOn, reducedMotion });
  // Lembrete de água insistente: fica no notch até "Bebi" ou "Adiar"; a cada 5 min
  // o mascote volta a chamar atenção.
  const waterNudge = null;
  const activityEnabled = settings.loadState === "ready" && !island.expanded && !island.hidden;
  const pushed = useActivityPush(activityEnabled);
  const pushRef = useRef(pushed.push);
  pushRef.current = pushed.push;
  // Arquivo chegou do celular: aviso no compacto (e som de notificação).
  const shelf = useShelf(bridge, item => pushRef.current({ kind: "file", group: "file", icon: "file", value: item.name, label: `Recebido do celular · ${fileSize(item.size)}`, priority: 3, durationMs: 5000, width: 380, mood: "happy", tone: "ok" }));
  const dragRef = useRef<{ open(): void; dropFiles(files: File[]): void; dragging(value: boolean): void }>(null!);
  dragRef.current = {
    open: () => { if (!island.expanded) island.change(true, true, false); if (page !== "shelf") selectPage("shelf", false, 1); },
    dropFiles: files => shelf.addFiles(files),
    dragging: value => { setFileDrag(value); shelf.setDragging(value); },
  };
  // Soltar do Explorador: quem recebe é o WebView2 (eventos HTML com os arquivos);
  // o arrasto do Tauri fica desligado porque o WebView2 recusava arquivos de fora.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); if (depth++ === 0) { dragRef.current.dragging(true); dragRef.current.open(); } };
    const over = (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; };
    const leave = (event: DragEvent) => { if (!hasFiles(event)) return; if (--depth <= 0) { depth = 0; dragRef.current.dragging(false); } };
    const drop = (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); depth = 0; dragRef.current.dragging(false); const files = Array.from(event.dataTransfer?.files ?? []); if (files.length) dragRef.current.dropFiles(files); };
    window.addEventListener("dragenter", enter); window.addEventListener("dragover", over); window.addEventListener("dragleave", leave); window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); };
  }, []);
  // Eventos do Windows viram avisos: volume, Wi-Fi/internet e notificações escolhidas.
  useEffect(() => {
    if (!bridge.onDesktopEvent) return;
    const stops: Promise<() => void>[] = [
      bridge.onDesktopEvent("desktop:volume", payload => {
        const { level, muted } = payload as { level: number; muted: boolean };
        pushRef.current({ kind: "volume", group: "volume", icon: muted || level === 0 ? "mute" : "volume", value: muted ? "Mudo" : `${level}%`, label: "Volume", priority: 3, durationMs: 1600, width: 280, mood: "normal", tone: "neutral", meter: muted ? 0 : level });
      }),
      bridge.onDesktopEvent("desktop:network", payload => {
        const { online, wifi, ssid } = payload as { online: boolean; wifi: boolean; ssid: string | null };
        pushRef.current(online
          ? { kind: "network", group: "network", icon: wifi ? "wifi" : "wifi", value: wifi && ssid ? ssid : "Conectado", label: wifi ? "Wi-Fi conectado" : "Internet de volta", priority: 3, durationMs: 3500, width: 300, mood: "happy", tone: "ok" }
          : { kind: "network", group: "network", icon: "offline", value: "Sem internet", label: "Conexão perdida", priority: 4, durationMs: 4500, width: 280, mood: "worried", tone: "warn" });
      }),
      bridge.onDesktopEvent("desktop:notification", payload => {
        const { app, title, body } = payload as { app: string; title: string; body: string };
        pushRef.current({ kind: "message", group: "message", icon: "message", value: body || app, label: title || app, priority: 3, durationMs: 6000, width: 400, mood: "wide", tone: "neutral" });
      }),
    ];
    return () => { stops.forEach(stop => void stop.then(fn => fn()).catch(() => {})); };
  }, [bridge]);
  // Lembretes da agenda (locais e assinadas): 30 e 15 min antes e na hora; cada aviso sai uma vez.
  const reminded = useRef(new Set<string>());
  const agendaTick = useNow(true, 20_000);
  useEffect(() => {
    const feed = calendars.events.filter(event => !event.allDay).map(event => ({ id: event.id, title: event.title, at: event.at, remindMin: 0, reminders: defaultReminders }));
    for (const due of dueReminders([...notes.events, ...feed], agendaTick)) {
      if (reminded.current.has(due.key)) continue;
      reminded.current.add(due.key);
      const time = new Date(due.event.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      pushRef.current({ kind: "agenda", group: "agenda", icon: "calendar", value: due.event.title, label: due.kind === "now" ? `Agora · ${time}` : `Em ${due.minutes} min · ${time}`, priority: 4, durationMs: 7000, width: 380, mood: "wide", tone: "neutral" });
    }
  }, [agendaTick, notes.events, calendars.events]);
  const [notificationStatus, setNotificationStatus] = useState("");
  useEffect(() => {
    if (settings.loadState !== "ready" || !bridge.configureNotifications) return;
    void bridge.configureNotifications(Boolean(settings.saved.modules.notifications), ["WhatsApp"]).then(setNotificationStatus).catch(() => setNotificationStatus("unsupported"));
  }, [bridge, settings.loadState, settings.saved.modules.notifications]);
  const activity = useActivity(context.desktop.failed ? null : desktop ?? null, activityEnabled, sports.snapshot, sports.config?.teams ?? [], waterNudge, pushed.pending);
  useEffect(() => {
    if (!activity) return;
    const kinds: Partial<Record<string, SoundKind>> = { message: "notification", file: "notification", agenda: "reminder", water: "reminder", score: "goal", kickoff: "kickoff", plugged: "charger", unplugged: "unplug", "battery-low": "warn", "battery-critical": "warn", track: "track" };
    const kind = activity.kind === "network" ? (activity.tone === "warn" ? "warn" : "notification") : kinds[activity.kind];
    if (kind) play(kind);
  }, [activity?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Letra ligada + música tocando: o compacto canta junto, linha a linha (Nusa).
  const lyricsOn = useLyricsOn();
  const media = playing ? desktop?.media ?? null : null;
  const lyrics = useLyrics(bridge, media, lyricsOn && playing);
  const lyricLines = lyrics?.state === "synced" ? lyrics.lines : [];
  const lyricAt = useLyricIndex(lyricLines, media, Boolean(lyricsOn && lyricLines.length && !island.expanded));
  const lyricLine = lyricAt >= 0 ? lyricLines[lyricAt].text || "♪" : null;
  // Jogo ao vivo de time seguido fica no compacto enquanto durar (atividades passam por cima).
  const liveGame = !island.hidden ? sports.snapshot?.games.find(game => game.state === "in" && game.followed) ?? null : null;
  const waterShow = waterPending && !activity && !island.hidden;
  const waterPulse = waterShow ? Math.floor(waterTick / 300_000) : 0;
  useEffect(() => { if (waterShow) play("reminder"); }, [waterShow, waterPulse]); // eslint-disable-line react-hooks/exhaustive-deps
  const openedOnce = useRef(false);
  useEffect(() => { if (!openedOnce.current) { openedOnce.current = true; return; } play(island.expanded ? "open" : "close"); }, [island.expanded]); // eslint-disable-line react-hooks/exhaustive-deps
  const singing = Boolean(lyricLine && !activity && !liveGame && !waterShow);
  // Avisos (menos a troca de música, que tem animação própria) abrem em meio-notch.
  const toast = activity && activity.kind !== "track" ? activity : null;
  const recNow = useNow(recorder.busy, 500);
  const recShow = recorder.busy && !toast;
  const countShow = recorder.countdown != null;
  useEffect(() => { setActivitySize(countShow ? { width: 220, height: toastHeight } : toast ? { width: 372, height: toastHeight } : waterShow ? { width: 404, height: 104 } : recShow ? { width: 250, height: 32 } : activity ? { width: activity.width, height: 32 } : liveGame ? { width: 320, height: 32 } : singing ? { width: 380, height: 32 } : null); }, [activity?.width, activity?.id, Boolean(liveGame), singing, waterShow, recShow, countShow]); // eslint-disable-line react-hooks/exhaustive-deps
  // Clicar no notch com a água pendente abre direto na página Água.
  useEffect(() => { if (island.expanded && waterPending && page !== "water") selectPage("water", false, 1); }, [island.expanded]); // eslint-disable-line react-hooks/exhaustive-deps
  // O mascote anuncia: primeiro olha para o ícone que entra, depois reage ao evento.
  const [glance, setGlance] = useState(false);
  useEffect(() => {
    if (!activity) { setGlance(false); return; }
    setGlance(true);
    const timer = window.setTimeout(() => setGlance(false), 650);
    return () => window.clearTimeout(timer);
  }, [activity?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const mascotTouch = useMascotTouch(island.expanded && !island.hidden);
  useEffect(() => { const kind = mascotTouch.touch.reaction?.kind; if (kind === "giggle" || kind === "tickle") play("giggle"); else if (mascotTouch.touch.expression === "wink") play("tap"); }, [mascotTouch.touch.reaction?.key, mascotTouch.touch.expression]); // eslint-disable-line react-hooks/exhaustive-deps
  const resting = presence.phase === "rest" && !activity;
  const hour = new Date().getHours(), night = hour >= 22 || hour < 6;
  const compactExpression: MascotExpression = activity ? (glance ? "wide" : activity.mood)
    : resting ? "sleep" : presence.phase === "drowsy" ? "yawn" : island.hovered || presence.phase !== "context" ? "wide" : playing ? "happy" : night ? "sleepy" : "normal";
  const compactLook = activity && glance ? { x: -3.5, y: 0 } : presence.look;
  // Faixa nova: o mascote sai pelo topo, banda e música ocupam o centro e ele volta.
  const trackShow = activity?.kind === "track" ? activity : null;
  const [mascotBack, setMascotBack] = useState(0);
  const hadTrack = useRef(false);
  useEffect(() => {
    if (trackShow) { hadTrack.current = true; return; }
    if (hadTrack.current) { hadTrack.current = false; setMascotBack(value => value + 1); }
  }, [Boolean(trackShow)]); // eslint-disable-line react-hooks/exhaustive-deps
  const openExpression: MascotExpression = page === "water" && waterPending ? waterMood : page === "media" && playing ? "happy" : page === "limits" && quotaLow(context) ? "worried" : "normal";

  useEffect(() => {
    if (!island.focusTarget) return;
    if (island.focusTarget.expanded) heading.current?.focus(); else openButton.current?.focus();
  }, [island.focusTarget]);
  useEffect(() => { if (keyboardPage) heading.current?.focus(); }, [page, keyboardPage]);
  useEffect(() => { if (menuOpen && menuKeyboard.current) menu.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [menuOpen]);
  // Sons: categoria ligada, volume e, se pedido, silêncio quando o Windows está em Não perturbe.
  const soundPrefs = { ...defaultSounds, ...settings.saved.sounds };
  const soundRef = useRef(soundPrefs);
  soundRef.current = soundPrefs;
  const quietCache = useRef({ at: 0, quiet: false });
  const play = useCallback((kind: SoundKind) => {
    const prefs = soundRef.current;
    if (!prefs.enabled || !prefs[soundCategory[kind]]) return;
    const go = () => playSound(kind, prefs.pack, prefs.volume);
    if (!prefs.respectDnd || !bridge.getQuiet) { go(); return; }
    const now = Date.now();
    if (now - quietCache.current.at < 10_000) { if (!quietCache.current.quiet) go(); return; }
    void bridge.getQuiet().then(quiet => { quietCache.current = { at: Date.now(), quiet }; if (!quiet) go(); }).catch(go);
  }, [bridge]);
  const lastContextPage = useRef<ContextPage>("home");
  if (contextPages.includes(page)) lastContextPage.current = page;
  useEffect(() => {
    if (island.expanded) return;
    setMenuOpen(false); setPinned(false); setAskTall(false); wheel.reset();
    // Preferência não é lugar para reabrir: a roda não navega a partir dela.
    if (!contextPages.includes(page)) { pageMotion.move(lastContextPage.current, 1, true); setPage(lastContextPage.current); }
  }, [island.expanded, wheel]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setAskOpen(page === "ask"); }, [page]);

  function selectPage(next: ContextPage, keyboard = false, direction = 1) {
    setMenuOpen(false); wheel.reset();
    // Preferências vivem na janela de configurações (no app); o painel segue na página atual.
    if (bridge.openSettings && settingsPageIds.includes(next)) { void bridge.openSettings(next); return; }
    if (next === page) return;
    setKeyboardPage(keyboard);
    pageMotion.move(next, direction, keyboard || preferences || next === "appearance" || next === "modules");
    setPage(next);
  }
  function movePage(direction: number, keyboard = false) {
    const index = preferences ? -1 : contextPages.indexOf(page);
    const next = contextPages[(index + direction + contextPages.length) % contextPages.length];
    // A roda preserva seu latch; uma seleção explícita o reinicia.
    setKeyboardPage(keyboard); pageMotion.move(next, direction, keyboard || preferences); setPage(next);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (settings.dirty && settings.saveState !== "saving") void settings.save();
  }
  const mascotPrefs = { ...defaultMascot, ...settings.draft.mascot };
  const glow = waterAngry ? ["#ff7a5c", "#ff453a", "#c81e3a"] : mascotPrefs.glow === "custom" ? [mascotPrefs.glowColor, mascotPrefs.glowColor, mascotPrefs.glowColor] : glowPresets[mascotPrefs.glow];
  // Cor de destaque pinta switches, sliders, progresso e botões primários. O vermelho
  // antigo (#EB0028, padrão de antes do redesenho) vale como neutro.
  const accent = /^#[0-9a-f]{6}$/i.test(settings.draft.appearance.accentColor) && settings.draft.appearance.accentColor.toUpperCase() !== "#EB0028" ? settings.draft.appearance.accentColor : "#E5E5E5";
  const accentLight = (([r, g, b]) => .2126 * r + .7152 * g + .0722 * b)([1, 3, 5].map(i => parseInt(accent.slice(i, i + 2), 16))) > 150;
  const style = { "--island-opacity": page === "prompter" && island.expanded ? (notes.prompter.opacity ?? 100) / 100 : settings.draft.appearance.opacity / 100, "--primary": accent, "--on-primary": accentLight ? "#171717" : "#ffffff",
    "--glow-a": glow[0], "--glow-b": glow[1], "--glow-c": glow[2], "--glow-shadow": `${glow[1]}cc`, "--glow-shadow-soft": `${glow[1]}66` } as CSSProperties;
  const mascotLook = mascotPrefs.look ? undefined : { x: 0, y: 0 };
  const feedback = !bridge.desktop ? "Salvar no aplicativo desktop." : settings.loadState === "loading" ? "Carregando…" : settings.loadState === "error" ? "Falha ao carregar." : settings.saveState === "error" ? "Falha ao salvar. Rascunho preservado." : settings.saveState === "saving" ? "Salvando…" : settings.saveState === "saved" ? "Configurações salvas." : settings.dirty ? "Alterações não salvas." : "";
  const pageIndex = contextPages.indexOf(page);

  return <main className={`shell ${bridge.desktop ? "desktop" : "preview"} ${island.expanded ? "expanded" : "compact"} ${island.peeking ? "peeking" : ""}`} style={style} data-prompter={(page === "prompter" && island.expanded) || undefined} data-reduced-motion={reducedMotion} data-mascot-phase={activity || liveGame || singing || waterShow ? "context" : presence.phase} data-water={waterShow ? "" : undefined} data-music={trackShow || singing ? "" : undefined} data-toast={toast || waterShow || countShow ? "" : undefined} data-rec={recShow && !countShow && !waterShow ? "" : undefined} data-live={!activity && liveGame ? "" : undefined} data-activity={activity?.kind} data-hidden={island.hidden} aria-hidden={island.hidden || undefined}
    onMouseMove={island.pointerMove} onMouseLeave={island.pointerLeave}
    onBlurCapture={event => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      setMenuOpen(false); island.resumeAutoCollapse();
    }}
    onFocusCapture={event => { if (!(event.target instanceof Element && event.target.closest('input[type="color"]'))) setColorPickerActive(false); }}
    onPointerDownCapture={event => {
      if (!(event.target instanceof Element && event.target.closest('input[type="color"]'))) setColorPickerActive(false);
      if (menuOpen && !(event.target instanceof Element && event.target.closest('[data-preferences-popup], [data-preferences-trigger]'))) setMenuOpen(false);
    }}
    onWheel={event => {
      if (!island.expanded || preferences || menuOpen || editableTarget(event.target)) return;
      // Conversa expandida do Ask tem rolagem própria: a roda rola o texto, não a página.
      const scroller = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-scroll]") : null;
      if (scroller && scroller.scrollHeight > scroller.clientHeight) return;
      // Listener do React é passivo: preventDefault só gerava erro no console.
      const direction = wheel.accept(event.deltaY, event.deltaMode, performance.now());
      if (direction) movePage(direction);
    }}
    onKeyDown={event => {
      if (editableTarget(event.target)) return;
      if (menuOpen && event.key === "Escape") { event.preventDefault(); setMenuOpen(false); preferencesButton.current?.focus(); return; }
      if (menuOpen && ["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault(); const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); return;
      }
      if (event.key === "Escape" && island.expanded) { event.preventDefault(); island.change(false, true, true); return; }
      if (!island.expanded || preferences) return;
      if (["ArrowDown", "PageDown", "ArrowUp", "PageUp"].includes(event.key)) { event.preventDefault(); movePage(event.key === "ArrowDown" || event.key === "PageDown" ? 1 : -1, true); }
    }}>
    <svg className="island-surface" ref={island.surfaceRef} aria-hidden="true"><path data-notch-path="" /></svg>
    {island.viewportExpanded && <section className="panel" data-tall={askTall && page === "ask" || undefined} data-no-face={mascotPrefs.inPanel === false || undefined} data-home={page === "home" || undefined} data-prompter={page === "prompter" || undefined} ref={island.panelRef} tabIndex={-1} aria-labelledby="panel-heading" aria-hidden={!island.expanded}>
      <div className="panel-face" {...mascotTouch.handlers}><span className="face-glow" aria-hidden="true" /><Mascot size="large" expression={(mascotPrefs.reactions ? mascotTouch.touch.expression : null) ?? openExpression} active={island.expanded && !island.hidden} reducedMotion={reducedMotion} look={mascotLook ?? mascotTouch.touch.look} reaction={mascotPrefs.reactions ? mascotTouch.touch.reaction : null} shape={mascotPrefs.eyeShape} color={waterAngry && page === "water" ? "#ff453a" : mascotPrefs.eyeColor} blink={mascotPrefs.blink} bounce={mascotPrefs.bounce} pace={mascotPrefs.pace} /></div>
      <form className={`page-form ${preferences && page !== "sportsPrefs" && page !== "calendarPrefs" || settings.loadState === "error" || island.error ? "with-footer" : ""}`} onSubmit={submit}>
        <h1 id="panel-heading" className="sr-only" ref={heading} tabIndex={-1}>{pageNames[page]}</h1>
        <div className="page-viewport" ref={pageMotion.ref}>
          {pageMotion.previous && <div className="page-layer" key={`old-${pageMotion.previous}`} data-page-layer="outgoing" aria-hidden="true" ref={node => { if (node) node.inert = true; }}><ContextPages page={pageMotion.previous} bridge={bridge} settings={settings} context={context} editable={false} setColorPickerActive={() => {}} awake={awake} notes={notes} sports={sports} calendars={calendars} shelf={shelf} recorder={recorder} notificationStatus={notificationStatus} ask={{ ...assistant, tall: askTall, setTall: () => {} }} ghost /></div>}
          <div className="page-layer" key={pageMotion.current} data-page-layer="incoming"><ContextPages page={pageMotion.current} bridge={bridge} settings={settings} context={context} editable={editable} setColorPickerActive={setColorPickerActive} awake={awake} notes={notes} sports={sports} calendars={calendars} shelf={shelf} recorder={recorder} notificationStatus={notificationStatus} ask={{ ...assistant, tall: askTall, setTall: setAskTall }} go={next => selectPage(next, false, contextPages.indexOf(next) >= contextPages.indexOf(page) ? 1 : -1)} /></div>
        </div>
        {(preferences && page !== "sportsPrefs" && page !== "calendarPrefs" || settings.loadState === "error" || island.error) && <footer className="panel-footer"><div className="feedback" aria-live="polite"><span role={island.error || settings.saveState === "error" || settings.loadState === "error" ? "alert" : undefined}>{island.error || feedback}</span></div>{settings.loadState === "error" ? <button type="button" className="text-button" onClick={() => void settings.load()}>Tentar novamente</button> : preferences && <button className="save-button" type="submit" aria-label="Salvar alterações" disabled={!editable} aria-disabled={!editable || !settings.dirty || settings.saveState === "saving"}>Salvar</button>}</footer>}
      </form>
      <nav className="page-ticks" aria-label="Ações do painel">
        <button type="button" className="pin-button" aria-label="Fixar painel aberto" aria-pressed={pinned} onClick={() => setPinned(value => !value)}><svg width="12" height="12" viewBox="0 0 24 24" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z" /></svg></button>
        <button type="button" ref={preferencesButton} className="preferences-trigger" data-preferences-trigger="" aria-label="Preferências" aria-haspopup="menu" aria-expanded={menuOpen} aria-current={preferences ? "page" : undefined} onClick={event => { if (bridge.openSettings) { void bridge.openSettings("appearance").catch(() => setMenuOpen(true)); return; } menuKeyboard.current = event.detail === 0; setMenuOpen(value => !value); }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
          {settings.dirty && <i className="unsaved-dot" />}
        </button>
      </nav>
      {/* Dock de ícones (como o OmniNotch); a rolagem continua trocando de página. */}
      <nav className="page-dock" aria-label="Páginas do Heydesk" style={{ ["--dock" as string]: Math.max(0, pageIndex) }} data-idle={pageIndex < 0 || undefined}>
        <span className="dock-pill" aria-hidden="true" />
        {contextPages.map((key, index) => <button key={key} type="button" className="tick" data-label={pageNames[key]} aria-label={pageNames[key]} aria-current={page === key ? "page" : undefined} onClick={event => selectPage(key, event.detail === 0, index >= pageIndex ? 1 : -1)}><PageIcon page={key} /></button>)}
      </nav>
      {page === "prompter" && <PrompterGrip notes={notes} onResize={setPrompterDrag} />}
      {menuOpen && <div className="preferences-popup" ref={menu} role="menu" aria-label="Preferências" data-preferences-popup=""><button role="menuitem" onClick={event => selectPage("appearance", event.detail === 0)}>Aparência</button><button role="menuitem" onClick={event => selectPage("modules", event.detail === 0)}>Módulos</button><button role="menuitem" onClick={event => selectPage("pagesPrefs", event.detail === 0)}>Páginas</button><button role="menuitem" onClick={event => selectPage("sportsPrefs", event.detail === 0)}>Esportes</button><button role="menuitem" onClick={event => selectPage("calendarPrefs", event.detail === 0)}>Agendas</button><button role="menuitem" onClick={event => selectPage("mascotPrefs", event.detail === 0)}>Mascote</button><button role="menuitem" onClick={event => selectPage("soundPrefs", event.detail === 0)}>Sons</button><button role="menuitem" onClick={() => { setMenuOpen(false); void island.hide(); }}>Ocultar ilha</button></div>}
    </section>}
    <button className="compact-button" ref={compactRef} aria-label="Abrir Heydesk" aria-expanded={island.expanded} aria-hidden={island.expanded} tabIndex={island.expanded ? -1 : 0} onClick={event => island.change(true, true, event.detail === 0)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); island.change(true, true, true); } }}>
      <span className="mascot-ambient" aria-hidden="true" />
      {toast && (view => <span className="toast" key={`toast-${toast.id}`} data-tone={toast.tone} data-kind={toast.kind}>
        <span className="toast-icon" style={view.ring != null ? { ["--ring" as string]: `${view.ring}%` } : undefined} data-ring={view.ring != null || undefined}><ActivityIcon icon={toast.icon} /></span>
        <span className="toast-text"><b>{view.title}</b><span>{view.sub}</span></span>
        {view.big ? <span className="toast-big">{view.big}</span> : <span className="toast-face"><Mascot expression={toast.mood} active={!island.expanded} reducedMotion={reducedMotion} shape={mascotPrefs.eyeShape} color={mascotPrefs.eyeColor} blink={mascotPrefs.blink} bounce={mascotPrefs.bounce} pace={mascotPrefs.pace} /></span>}
      </span>)(toastView(toast))}
      {countShow && <span className="toast rec-count" key={`count-${recorder.countdown}`}><b>{recorder.countdown}</b><span>Gravando em…</span></span>}
      {recShow && !countShow && !waterShow && <span className="rec-compact" data-paused={recorder.state.state === "paused" || undefined}><i />{recorder.state.state === "paused" ? "Pausado" : "REC"}<b>{recClock(recordedMs(recorder.state, recNow))}</b></span>}
      {waterShow ? <span className="compact-side compact-left compact-water" key={`w${waterPulse}`}><ActivityIcon icon="drop" /></span>
        : !activity && liveGame ? <span className="compact-side compact-left compact-live"><span className="live-dot" /></span>
        : trackShow || singing ? <span className="compact-side compact-left">{singing && <span className="compact-media small" aria-hidden="true"><i /><i /><i /></span>}</span>
        : activity ? <span className="compact-side compact-left compact-activity" key={`icon-${activity.id}`} data-tone={activity.tone} title={activity.label}><ActivityIcon icon={activity.icon} /></span>
        : <span className="compact-side compact-left"><time>{clock}</time></span>}
      {/* Jogo ao vivo: o placar ocupa o centro; o mascote sai de cena. */}
      {!activity && !waterShow && liveGame && <span className="compact-score" title={`${liveGame.home.name} × ${liveGame.away.name} · ${liveGame.leagueName}`}>
        <span className="score-logo">{liveGame.home.logo ? <img src={liveGame.home.logo} alt="" /> : liveGame.home.name.slice(0, 1)}</span>
        <b className="score-team">{teamTag(liveGame.home)}</b>
        <span className="score-pill"><span>{liveGame.home.score ?? 0}</span><i>:</i><span>{liveGame.away.score ?? 0}</span></span>
        <b className="score-team">{teamTag(liveGame.away)}</b>
        <span className="score-logo">{liveGame.away.logo ? <img src={liveGame.away.logo} alt="" /> : liveGame.away.name.slice(0, 1)}</span>
      </span>}
      {!activity && (liveGame || waterShow) ? null : trackShow || singing ? null : <Mascot expression={compactExpression} active={!island.expanded && !away} reducedMotion={reducedMotion} look={mascotLook ?? compactLook} shape={mascotPrefs.eyeShape} color={mascotPrefs.eyeColor} blink={mascotPrefs.blink} bounce={mascotPrefs.bounce} pace={mascotPrefs.pace} reaction={!mascotPrefs.reactions ? null : activity ? { kind: "announce", key: activity.id } : mascotBack ? { kind: "back", key: mascotBack } : null} />}
      {singing && <span className="compact-lyric" key={`lyric-${lyricAt}`} aria-live="off">{lyricLine}</span>}
      {trackShow && <span className="compact-track" key={`track-${trackShow.id}`} title={`${trackShow.label} — ${trackShow.value}`}><b>{trackShow.label}</b><span>{trackShow.value}</span></span>}
      {waterShow ? <span className="compact-side compact-right compact-water"><span className="water-pill">abrir</span></span>
        : !activity && liveGame ? <span className="compact-side compact-right compact-live"><span className="live-map">{liveGame.clock ?? liveGame.detail}</span></span>
        : trackShow || singing ? <span className="compact-side compact-right" />
        : activity ? <span className="compact-side compact-right compact-activity" key={`value-${activity.id}`} data-tone={activity.tone}>{activity.meter != null && <span className="compact-meter"><i style={{ transform: `scaleX(${activity.meter / 100})` }} /></span>}<span className="compact-activity-value">{activity.kind === "message" || activity.kind === "agenda" ? <><b>{activity.label}</b> {activity.value}</> : activity.value}</span></span>
        : <span className="compact-side compact-right">
        {playing ? <span className="compact-media" aria-label="Música tocando"><i /><i /><i /><i /><i /></span>
          : weather?.temperatureC != null && <span className="compact-weather" title={`${weather.city ?? "Clima"} · ${weatherLabel(weather.weatherCode)}`}>{Math.round(weather.temperatureC)}°</span>}
        {/* Bateria saiu do compacto: carregador e bateria baixa aparecem como avisos. */}
      </span>}
      <span className="sr-only" aria-live="polite">{activity ? `${activity.label}: ${activity.value}` : ""}</span>
      {island.error && <span className="sr-only" role="alert">{island.error}</span>}
    </button>
    {/* Lembrete de água com botões (fora do botão do compacto: botão dentro de botão não vale). */}
    {waterShow && !toast && !countShow && !island.expanded && waterNow?.due && (copy => <div className="water-card" key={`wc-${waterPulse}-${waterNow.due}-${waterLevel}`} role="alertdialog" aria-label={copy.title} data-level={waterLevel} data-kind={waterNow.due}>
      <span className="water-card-face"><Mascot expression={waterMood} active reducedMotion={reducedMotion} shape={mascotPrefs.eyeShape} color={waterAngry ? "#ff453a" : mascotPrefs.eyeColor} blink={mascotPrefs.blink} bounce={mascotPrefs.bounce} pace="lively" /></span>
      <span className="toast-text"><b>{copy.title}</b><span>{copy.sub}</span></span>
      <span className="water-card-actions">
        <button type="button" className="water-no" onClick={notes.refuseWater}>{copy.no}</button>
        <button type="button" className="water-yes" onClick={() => waterNow.due === "refill" ? notes.refillWater() : notes.drink()}>{copy.yes}</button>
      </span>
    </div>)(waterCopy(waterNow, notes.water, waterTick))}
  <Tooltips /></main>;
}
