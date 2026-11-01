import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CodexUsageSnapshot } from "../modules/codex-usage/types";
import type { ClaudeQuotaSnapshot, CodexQuotaSnapshot, DesktopSnapshot, Lyrics, MediaAction, Notes } from "../modules/context/types";

export interface AppSettings {
  schemaVersion: 3;
  appearance: { opacity: number; accentColor: string };
  motion: { reducedMotion: "system" | "on" | "off" };
  modules: { codexUsage: boolean; claudeUsage: boolean; hideInFullscreen?: boolean; notifications?: boolean; systemInfo: boolean; media: boolean; weather: boolean };
  weatherLocation: { city: string; latitude: number; longitude: number } | null;
  mascot?: MascotSettings;
  /** Páginas fora do ciclo do notch. */
  hiddenPages?: string[];
  /** Ordem das páginas no dock (vazia: padrão). */
  pageOrder?: string[];
  sounds?: SoundSettings;
}
export interface MascotSettings { eyeShape: "oval" | "round" | "pixel" | "line" | "heart"; eyeColor: string; glow: "aurora" | "amber" | "mint" | "rose" | "mono" | "custom"; glowColor: string; blink: boolean; look: boolean; reactions: boolean; bounce: boolean; pace: "calm" | "lively"; inPanel?: boolean; theme?: string }
export interface SoundSettings { enabled: boolean; volume: number; pack: "soft" | "retro" | "minimal"; notifications: boolean; reminders: boolean; sports: boolean; interactions: boolean; respectDnd: boolean }
export const defaultMascot: MascotSettings = { eyeShape: "oval", eyeColor: "#FFFFFF", glow: "aurora", glowColor: "#2D5BFF", blink: true, look: true, reactions: true, bounce: true, pace: "calm", inPanel: true, theme: "eyes" };
export const defaultSounds: SoundSettings = { enabled: true, volume: 55, pack: "soft", notifications: true, reminders: true, sports: true, interactions: false, respectDnd: true };

export const defaultSettings: AppSettings = {
  schemaVersion: 3,
  appearance: { opacity: 94, accentColor: "#EB0028" },
  motion: { reducedMotion: "system" },
  modules: { codexUsage: true, claudeUsage: true, hideInFullscreen: true, notifications: false, systemInfo: true, media: true, weather: false },
  weatherLocation: null,
};

/** Humores que um pacote de tema pode desenhar. */
export type ThemeMood = "calm" | "happy" | "angry" | "sleepy" | "worried" | "wide" | "sleep" | "wink" | "laugh";
export interface ThemeManifest {
  schema: 1; name: string; author?: string | null; version?: string | null;
  images?: (Record<"calm" | "happy" | "angry" | "sleepy", string> & Partial<Record<ThemeMood, string | null>> & { pixelated?: boolean }) | null;
  font?: string | null; sounds?: Record<string, string>;
  colors?: { ground?: string | null; accent?: string | null; text?: string | null; glow?: [string, string, string] | null } | null;
  copy?: { water?: string[] | null; mapFor?: string | null } | null;
  /** Visual do notch: cores, borda, moldura do painel aberto e imagem de fundo. */
  hud?: { surface?: string | null; text?: string | null; muted?: string | null; accent?: string | null; border?: string | null; frame?: string | null; frameSlice?: number | null; panel?: string | null;
    texture?: string | null; textureOpacity?: number | null; corner?: string | null; crest?: string | null; bevel?: boolean | null; shimmer?: boolean | null; panelOpacity?: number | null;
    lines?: { color: string; inset: number; width: number; glow?: boolean }[] } | null;
}
export interface ThemeSummary { id: string; name: string; builtIn: boolean; hasImages: boolean; hasFont: boolean; soundKinds: string[]; glow: [string, string, string] | null; preview: string | null; error: string | null; surface?: string | null; border?: string | null }
export interface ThemeBlob { mime: string; base64: string }
export interface ThemeBundle { id: string; name: string; builtIn: boolean; manifest: ThemeManifest; images: Partial<Record<ThemeMood, string>>; font: ThemeBlob | null; sounds: Record<string, ThemeBlob>; hud?: Partial<Record<"frame" | "panel" | "texture" | "corner" | "crest", string>> }

export const shellEvents = { open: "shell:open", collapse: "shell:collapse", hidden: "shell:hidden", pointer: "shell:pointer" } as const;
export type ShellEvent = typeof shellEvents[keyof typeof shellEvents];
export interface HitShape { width: number; height: number; radius: number; wing: number }
export interface ShellBridge {
  desktop: boolean;
  loadSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  /** Forma em pixels lógicos usada pelo hit-test nativo; a janela tem tamanho fixo. */
  setHitShape(shape: HitShape): Promise<void>;
  hide(): Promise<void>;
  listen(event: ShellEvent, callback: (payload: unknown) => void): Promise<() => void>;
  getCodexUsage(): Promise<CodexUsageSnapshot>;
  refreshCodexUsage(): Promise<CodexUsageSnapshot>;
  getCodexLimits(): Promise<CodexQuotaSnapshot>;
  getClaudeLimits(): Promise<ClaudeQuotaSnapshot>;
  getDesktopStatus(): Promise<DesktopSnapshot>;
  getNotchInteraction?(): Promise<{ idleMs: number | null; look: { x: number; y: number } | null }>;
  mediaControl?(action: MediaAction): Promise<void>;
  /** LRCLIB sob demanda: envia título, artista e duração. */
  getLyrics?(title: string, artist: string, durationMs: number | null): Promise<Lyrics>;
  setKeepAwake?(on: boolean): Promise<boolean>;
  loadNotes?(): Promise<Notes>;
  /** Pergunta ao Claude pelo CLI logado; `onText` recebe a resposta em pedaços. */
  ask?(prompt: string, onText: (text: string) => void): Promise<void>;
  askCancel?(): Promise<void>;
  getMediaArt?(): Promise<string | null>;
  /** Eventos do Windows (volume, rede, notificações) emitidos pelo backend na hora. */
  onDesktopEvent?(name: "desktop:volume" | "desktop:network" | "desktop:notification" | "shelf:changed" | "recorder:state" | "recorder:hotkey" | "camera:closed" | "shell:occluded" | "settings:changed" | "settings:section" | "notes:changed" | "hltv:live" | "hltv:status" | "app:update" | "app:update-progress", callback: (payload: unknown) => void): Promise<() => void>;
  configureNotifications?(enabled: boolean, apps: string[]): Promise<string>;
  /** Windows em silêncio (Não perturbe/tela cheia), melhor esforço. */
  getQuiet?(): Promise<boolean>;
  recorderCapabilities?(): Promise<import("../modules/prompter/useRecorder").RecorderCapabilities>;
  recorderState?(): Promise<import("../modules/prompter/useRecorder").RecorderState>;
  recorderStart?(options: import("../modules/prompter/useRecorder").RecorderOptions): Promise<import("../modules/prompter/useRecorder").RecorderState>;
  recorderControl?(action: "pause" | "resume" | "stop"): Promise<import("../modules/prompter/useRecorder").RecorderState>;
  recorderOpen?(path: string, reveal: boolean): Promise<void>;
  cameraBubble?(show: boolean): Promise<boolean>;
  cursorOverlay?(show: boolean): Promise<void>;
  /** Abre (ou traz para frente) a janela de configurações na seção pedida. */
  openSettings?(section: string): Promise<void>;
  countdownOverlay?(show: boolean): Promise<void>;
  shelfList?(): Promise<import("../modules/context/useShelf").ShelfItem[]>;
  shelfReceiveStart?(): Promise<import("../modules/context/useShelf").ReceiveInfo>;
  shelfReceiveStop?(): Promise<void>;
  shelfReceiveStatus?(): Promise<import("../modules/context/useShelf").ReceiveInfo | null>;
  shelfOpen?(id: string): Promise<void>;
  shelfReveal?(id: string): Promise<void>;
  shelfAdd?(file: File): Promise<import("../modules/context/useShelf").ShelfItem>;
  shelfAddPaths?(paths: string[]): Promise<import("../modules/context/useShelf").ShelfItem[]>;
  shelfThumbnail?(id: string): Promise<string | null>;
  /** Arrasta o arquivo da prateleira para fora (Explorador, área de trabalho, outros apps). */
  shelfDrag?(id: string): Promise<void>;
  /** Arquivos arrastados do Explorador sobre a janela. */
  onFileDrag?(callback: (event: { type: "enter" | "over" | "drop" | "leave"; paths: string[] }) => void): Promise<() => void>;
  shelfRemove?(id: string): Promise<import("../modules/context/useShelf").ShelfItem[]>;
  getCalendarEvents?(): Promise<import("../modules/context/useCalendars").CalendarSnapshot>;
  getCalendarFeeds?(): Promise<import("../modules/context/useCalendars").PublicFeed[]>;
  saveCalendarFeeds?(feeds: import("../modules/context/useCalendars").FeedInput[]): Promise<import("../modules/context/useCalendars").PublicFeed[]>;
  getSports?(): Promise<import("../modules/sports/useSports").SportsSnapshot>;
  getSportsConfig?(): Promise<[import("../modules/sports/useSports").SportsConfig, import("../modules/sports/useSports").SportsCatalog]>;
  /** `token` ausente mantém a chave salva; "" apaga. */
  saveSportsConfig?(leagues: string[], teams: string[], token?: string): Promise<import("../modules/sports/useSports").SportsConfig>;
  getLeagueTeams?(league: string): Promise<import("../modules/sports/useSports").TeamOption[]>;
  getCsLive?(): Promise<import("../modules/sports/useSports").CsLive | null>;
  setCsPinned?(id: string | null): Promise<void>;
  /** Abre (url) ou fecha (null) a transmissão em PiP abaixo do notch. */
  streamPip?(url: string | null): Promise<void>;
  getCsStatus?(): Promise<{ gameId: string; state: "searching" | "live" | "missing" | "blocked" } | null>;
  saveNotes?(notes: Notes): Promise<Notes>;
  getKeepAwake?(): Promise<boolean>;
  /** Temas embutidos e os importados pelo usuário. */
  themeList?(): Promise<ThemeSummary[]>;
  themeRead?(id: string): Promise<ThemeBundle>;
  /** Copia uma pasta escolhida para os temas; devolve o id criado. */
  themeImport?(files: File[], folder: string): Promise<string>;
  themeRemove?(id: string): Promise<void>;
  /** Iniciar com o Windows. */
  getAutostart?(): Promise<boolean>;
  setAutostart?(on: boolean): Promise<boolean>;
  /** Procura versão nova agora (não instala). */
  updateCheck?(): Promise<UpdateInfo>;
  /** Baixa, instala e reabre o Heydesk. */
  updateInstall?(): Promise<void>;
  /** "Depois": cala o aviso dessa versão por 24 h. */
  updateDismiss?(version: string): Promise<void>;
  appVersion?(): Promise<string>;
}
export interface UpdateInfo { current: string; version: string | null; notes: string | null }

// Cancelar mata o processo; o processo morto não envia "done", então o pedido em
// curso é encerrado aqui.
let cancelAsk: (() => void) | null = null;

export function createShellBridge(): ShellBridge {
  return {
    desktop: isTauri(),
    loadSettings: () => invoke<AppSettings>("load_settings"),
    saveSettings: settings => invoke<AppSettings>("save_settings", { settings }),
    setHitShape: shape => invoke<void>("set_hit_shape", { shape }),
    hide: () => invoke<void>("hide_island"),
    listen: (event, callback) => listen(event, message => callback(message.payload)),
    getCodexUsage: () => invoke<CodexUsageSnapshot>("get_codex_usage"),
    refreshCodexUsage: () => invoke<CodexUsageSnapshot>("refresh_codex_usage"),
    getCodexLimits: () => invoke<CodexQuotaSnapshot>("get_codex_limits"),
    getClaudeLimits: () => invoke<ClaudeQuotaSnapshot>("get_claude_limits"),
    getDesktopStatus: () => invoke<DesktopSnapshot>("get_desktop_status"),
    mediaControl: action => invoke<void>("media_control", { action }),
    getLyrics: (title, artist, durationMs) => invoke<Lyrics>("get_lyrics", { title, artist, durationMs }),
    setKeepAwake: on => invoke<boolean>("set_keep_awake", { on }),
    loadNotes: () => invoke<Notes>("load_notes"),
    ask: async (prompt, onText) => {
      const id = Date.now();
      let finish!: () => void, fail!: (reason: string) => void;
      const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      cancelAsk = () => fail("Cancelado.");
      const stops = [
        await listen<{ id: number; text: string }>("ask:delta", message => { if (message.payload.id === id) onText(message.payload.text); }),
        await listen<{ id: number; error: string | null }>("ask:done", message => { if (message.payload.id === id) { if (message.payload.error) fail(message.payload.error); else finish(); } }),
      ];
      try { await invoke<void>("ask_start", { id, prompt }); await done; }
      finally { stops.forEach(stop => stop()); cancelAsk = null; }
    },
    getMediaArt: () => invoke<string | null>("get_media_art"),
    onDesktopEvent: (name, callback) => listen(name, message => callback(message.payload)),
    configureNotifications: (enabled, apps) => invoke<string>("configure_notifications", { enabled, apps }),
    getQuiet: () => invoke<boolean>("get_quiet"),
    recorderCapabilities: () => invoke("recorder_capabilities"),
    recorderState: () => invoke("recorder_state"),
    recorderStart: options => invoke("recorder_start", { options: { ...options, window: options.window ?? null, microphone: options.microphone || null, fps: options.fps ?? null } }),
    recorderControl: action => invoke("recorder_control", { action }),
    recorderOpen: (path, reveal) => invoke("recorder_open", { path, reveal }),
    cameraBubble: show => invoke("camera_bubble", { show }),
    cursorOverlay: show => invoke("cursor_overlay", { show }),
    openSettings: section => invoke("open_settings", { section }),
    countdownOverlay: show => invoke("countdown_overlay", { show }),
    shelfList: () => invoke("shelf_list"),
    shelfReceiveStart: () => invoke("shelf_receive_start"),
    shelfReceiveStop: () => invoke("shelf_receive_stop"),
    shelfReceiveStatus: () => invoke("shelf_receive_status"),
    shelfOpen: id => invoke("shelf_open", { id }),
    shelfReveal: id => invoke("shelf_reveal", { id }),
    shelfRemove: id => invoke("shelf_remove", { id }),
    shelfAdd: async file => invoke("shelf_add", new Uint8Array(await file.arrayBuffer()), { headers: { "x-name": encodeURIComponent(file.name) } }),
    shelfAddPaths: paths => invoke("shelf_add_paths", { paths }),
    shelfThumbnail: id => invoke("shelf_thumbnail", { id }),
    shelfDrag: async id => {
      const [path, icon] = await invoke<[string, string]>("shelf_drag_info", { id });
      await (await import("@crabnebula/tauri-plugin-drag")).startDrag({ item: [path], icon });
    },
    onFileDrag: async callback => (await import("@tauri-apps/api/webview")).getCurrentWebview().onDragDropEvent(event => {
      const payload = event.payload as { type: "enter" | "over" | "drop" | "leave"; paths?: string[] };
      callback({ type: payload.type, paths: payload.paths ?? [] });
    }),
    getCalendarEvents: () => invoke("get_calendar_events"),
    getCalendarFeeds: () => invoke("get_calendar_feeds"),
    saveCalendarFeeds: feeds => invoke("save_calendar_feeds", { feeds: feeds.map(feed => ({ ...feed, url: feed.url ?? null })) }),
    getSports: () => invoke("get_sports"),
    getSportsConfig: () => invoke("get_sports_config"),
    saveSportsConfig: (leagues, teams, token) => invoke("save_sports_config", { leagues, teams, token: token ?? null }),
    getLeagueTeams: league => invoke("get_league_teams", { league }),
    getCsLive: () => invoke("get_cs_live"),
    setCsPinned: id => invoke("set_cs_pinned", { id }),
    getCsStatus: () => invoke("get_cs_status"),
    streamPip: url => invoke("stream_pip", { url }),
    themeList: () => invoke("theme_list"),
    themeRead: id => invoke("theme_read", { id }),
    themeImport: async (files, folder) => {
      const token = await invoke<number>("theme_import_begin");
      try {
        for (const file of files) await invoke("theme_import_file", new Uint8Array(await file.arrayBuffer()), { headers: { "x-token": String(token), "x-name": encodeURIComponent(file.name) } });
        return await invoke<string>("theme_import_commit", { token, folder });
      } catch (error) { void invoke("theme_import_cancel", { token }).catch(() => {}); throw error; }
    },
    themeRemove: id => invoke("theme_remove", { id }),
    getAutostart: () => invoke("get_autostart"),
    setAutostart: on => invoke("set_autostart", { on }),
    updateCheck: () => invoke("update_check"),
    updateInstall: () => invoke("update_install"),
    updateDismiss: version => invoke("update_dismiss", { version }),
    appVersion: () => invoke("app_version"),
    askCancel: async () => { cancelAsk?.(); await invoke<void>("ask_cancel"); },
    saveNotes: notes => invoke<Notes>("save_notes", { notes }),
    getKeepAwake: () => invoke<boolean>("get_keep_awake"),
    getNotchInteraction: () => invoke<{ idleMs: number | null; look: { x: number; y: number } | null }>("get_notch_interaction"),
  };
}
