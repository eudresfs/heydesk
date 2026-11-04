export interface QuotaWindow {
  id: string;
  usedPercent: number;
  remainingPercent: number | null;
  lastKnownRemainingPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
  state: "available" | "stale" | "reset_pending";
}

export interface CodexQuotaSnapshot {
  enabled: boolean;
  providerId: string;
  providerName: string;
  state: "available" | "stale" | "unavailable" | "disabled";
  source: string;
  observedAt: string | null;
  windows: QuotaWindow[];
}

export interface ClaudeLimit {
  kind: string;
  group: string;
  label: string;
  percent: number;
  severity: string;
  /** Época Unix em ms. */
  resetsAt: number | null;
  windowMinutes: number | null;
  active: boolean;
}

export interface ClaudeQuotaSnapshot {
  enabled: boolean;
  state: "available" | "stale" | "unavailable" | "disabled";
  plan: string | null;
  observedAt: number | null;
  limits: ClaudeLimit[];
  reason: string | null;
}

export interface DesktopSnapshot {
  observedAt: string | null;
  cpuPercent: number | null;
  memory: { usedBytes: number; totalBytes: number } | null;
  disk?: { usedBytes: number; totalBytes: number } | null;
  /** Bytes por segundo nas interfaces físicas ativas. */
  network?: { downBps: number; upBps: number } | null;
  /** `plugged` vem da linha AC; em 100% na tomada `charging` é falso. */
  battery: { percent: number | null; charging: boolean; plugged?: boolean; hasBattery: boolean } | null;
  media: MediaStatus | null;
  weather: { state: "ready" | "stale" | "unavailable" | "unconfigured"; city: string | null; temperatureC: number | null; weatherCode: number | null; isDay: boolean | null; observedAt: string | null; source: string } | null;
}

export interface MediaStatus {
  state: "playing" | "paused" | "empty" | "unavailable";
  title: string | null;
  artist: string | null;
  source?: string | null;
  /** Muda quando há capa nova; a imagem vem por `getMediaArt`. */
  artKey?: string | null;
  /** Posição no instante `positionAtMs` (época Unix, ms); extrapolar enquanto toca. */
  positionMs?: number | null;
  durationMs?: number | null;
  positionAtMs?: number | null;
  canPrevious?: boolean;
  canNext?: boolean;
  canToggle?: boolean;
}
export type MediaAction = "toggle" | "next" | "previous";
export interface Todo { id: string; text: string; done: boolean; starred: boolean; createdAt: number }
export interface Drink { at: number; ml: number }
/** Água: meta do dia, volume do gole (`cupMl`) e da garrafa, período (minutos do dia),
 * dias da semana (0 = domingo), soneca de 15 min, recusas de hoje e pedido de gole após encher. */
export interface Water {
  goalMl: number; cupMl: number; reminders: boolean; intervalMin: number; log: Drink[]; snoozeUntil?: number;
  bottleMl?: number; bottleLeftMl?: number; startMin?: number; endMin?: number; days?: number[]; snooze?: boolean; skips?: number[]; askAt?: number;
}
export interface CalendarEvent { id: string; title: string; at: number; remindMin: number; reminders?: number[] }
export interface Prompter { text: string; speed: number; size: number; mirror: boolean; opacity?: number; height?: number }
export interface Notes { note: string; todos: Todo[]; water?: Water; events?: CalendarEvent[]; prompter?: Prompter; pet?: Pet }
export interface PetStreak { current: number; best: number; lastDate: string }
export interface PetGear { hat: string; color: string; scene: string }
export interface PetDaily {
  date: string; drinks: number; goalMet: boolean; minigameCoins: number; minigameXp: number; games: number; pets: number;
  focusXp: number; focusCoins: number; breaks: number; refusals: number; tasks: number; snack: boolean; credited: string[];
}
/** Bichinho: barras de 0 a 100 gravadas em `updatedAt`; a queda com o tempo é calculada na hora. */
export interface Pet {
  name: string; thirst: number; energy: number; joy: number; focus: number; updatedAt: number;
  xp: number; coins: number; streak: PetStreak; owned: string[]; equipped: PetGear; daily: PetDaily; lastBreakAt: number; lastPetAt: number;
  lastDrinkAt: number; lastRefuseAt: number;
}
export interface LyricLine { atMs: number; text: string }
/** Ficha da faixa vinda do iTunes (só com o Player aberto). */
export interface TrackInfo { album: string | null; year: number | null; genre: string | null; art: string | null }
export interface Lyrics { state: "synced" | "plain" | "instrumental" | "none" | "error"; lines: LyricLine[]; plain: string | null }
