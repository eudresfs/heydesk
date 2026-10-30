import type { DesktopSnapshot } from "../context/types";
import type { MascotExpression } from "../context/Mascot";

export type ActivityKind = "plugged" | "unplugged" | "battery-low" | "battery-critical" | "track" | "score" | "kickoff" | "water" | "volume" | "network" | "message" | "agenda" | "file";
export type ActivityIcon = "plug" | "battery" | "note" | "ball" | "drop" | "volume" | "mute" | "wifi" | "offline" | "message" | "calendar" | "file";
export interface Activity {
  id: number;
  kind: ActivityKind;
  /** Itens do mesmo grupo se substituem: só a notícia mais nova importa. */
  group: "power" | "battery" | "track" | "sport" | "water" | "volume" | "network" | "message" | "agenda" | "file";
  /** 0–100: barra no compacto (volume). */
  meter?: number;
  icon: ActivityIcon;
  value: string;
  label: string;
  priority: number;
  durationMs: number;
  width: number;
  mood: MascotExpression;
  tone: "ok" | "warn" | "neutral";
}
export type ActivityInput = Omit<Activity, "id">;
export interface ActivityState { current: (Activity & { until: number }) | null; queue: Activity[]; seq: number }
export const idleActivity: ActivityState = { current: null, queue: [], seq: 0 };

const percent = (value: number | null | undefined) => value == null ? "" : `${Math.round(value)}%`;

// Eventos saem da diferença entre leituras consecutivas. A primeira leitura não
// anuncia nada: abrir o app não é "carregador conectado".
export function detectActivities(previous: DesktopSnapshot | null, next: DesktopSnapshot | null): ActivityInput[] {
  if (!previous || !next) return [];
  const found: ActivityInput[] = [];
  const before = previous.battery, after = next.battery;
  if (before?.hasBattery && after?.hasBattery) {
    if (!before.plugged && after.plugged) found.push({ kind: "plugged", group: "power", icon: "plug", value: percent(after.percent), label: "Carregador conectado", priority: 3, durationMs: 3500, width: 260, mood: "happy", tone: "ok" });
    else if (before.plugged && !after.plugged) found.push({ kind: "unplugged", group: "power", icon: "plug", value: percent(after.percent), label: "Carregador desconectado", priority: 3, durationMs: 3000, width: 260, mood: "wide", tone: "neutral" });
    const was = before.percent, now = after.percent;
    if (!after.plugged && was != null && now != null) {
      if (was > 10 && now <= 10) found.push({ kind: "battery-critical", group: "battery", icon: "battery", value: percent(now), label: "Bateria muito baixa", priority: 5, durationMs: 6000, width: 280, mood: "worried", tone: "warn" });
      else if (was > 20 && now <= 20) found.push({ kind: "battery-low", group: "battery", icon: "battery", value: percent(now), label: "Bateria baixa", priority: 4, durationMs: 5000, width: 280, mood: "worried", tone: "warn" });
    }
  }
  const media = next.media, old = previous.media;
  if (old && media?.state === "playing" && media.title && (media.title !== old.title || media.artist !== old.artist)) {
    found.push({ kind: "track", group: "track", icon: "note", value: media.title, label: media.artist ?? media.source ?? "Tocando agora", priority: 1, durationMs: 3200, width: 340, mood: "happy", tone: "neutral" });
  }
  return found;
}

function start(state: ActivityState, item: Activity, now: number): ActivityState {
  return { ...state, current: { ...item, until: now + item.durationMs }, queue: state.queue.filter(other => other.id !== item.id) };
}
function next(queue: Activity[]) {
  return queue.reduce<Activity | null>((best, item) => !best || item.priority > best.priority ? item : best, null);
}

// Fila com prioridade: um item por vez; prioridade maior interrompe; mesmo grupo
// substitui (no ar ou na fila) em vez de empilhar avisos velhos.
export function enqueueActivities(state: ActivityState, items: ActivityInput[], now: number): ActivityState {
  let result = advanceActivities(state, now);
  for (const input of items) {
    const item: Activity = { ...input, id: ++result.seq };
    const queue = result.queue.filter(other => other.group !== item.group);
    const current = result.current;
    if (!current || current.group === item.group || item.priority > current.priority) {
      result = start({ ...result, queue: current && current.group !== item.group ? [...queue, current] : queue }, item, now);
    } else result = { ...result, queue: [...queue, item] };
  }
  return result;
}

export function advanceActivities(state: ActivityState, now: number): ActivityState {
  if (state.current && state.current.until > now) return state;
  const following = next(state.queue);
  return following ? start({ ...state, current: null }, following, now) : state.current ? { ...state, current: null } : state;
}

/** Aviso em meio-notch (como no Nusa): título, linha de apoio e, à direita, um número grande. */
export interface ToastView { title: string; sub: string; big?: string; ring?: number }
export const toastHeight = 60;
export function toastView(activity: Activity): ToastView {
  const pct = /^(\d+)%$/.exec(activity.value);
  const ring = pct ? Number(pct[1]) : activity.meter;
  switch (activity.kind) {
    case "plugged": return { title: "Carregando", sub: "Carregador conectado", big: activity.value, ring };
    case "unplugged": return { title: "Na bateria", sub: "Carregador desconectado", big: activity.value, ring };
    case "battery-low": case "battery-critical": return { title: activity.label, sub: "Conecte o carregador", big: activity.value, ring };
    case "volume": return { title: activity.label, sub: activity.meter === 0 || activity.icon === "mute" ? "Som desligado" : "Saída de áudio", big: activity.value, ring: activity.meter };
    case "agenda": return { title: activity.value, sub: activity.label };
    case "file": return { title: activity.value, sub: activity.label };
    default: return { title: activity.label, sub: activity.value };
  }
}
