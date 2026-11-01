// Simulação do bichinho, sem efeitos: o que está gravado é um retrato (barras em
// `updatedAt`); `project` calcula a queda até agora e `apply` soma um evento. Assim nada
// grava a cada minuto, a queda vale mesmo com o app fechado e tudo é testável.
import type { MascotExpression } from "../context/Mascot";
import type { Pet, PetGear, Water } from "../context/types";

export type PetStat = "thirst" | "energy" | "joy" | "focus";
export type PetStage = "filhote" | "jovem" | "adulto" | "lenda";
export interface PetWindow { startMin: number; endMin: number; days: number[] }
export type PetEvent =
  | { kind: "drink"; ml: number; cupMl: number } | { kind: "goalMet" } | { kind: "refuse" }
  | { kind: "break"; minutes: number } | { kind: "teamWin"; id: string } | { kind: "teamLoss"; id: string }
  | { kind: "petting" } | { kind: "minigame"; game: "gole" | "gota"; score: number }
  | { kind: "focus"; minutes: number; id: string }
  | { kind: "buy"; id: string } | { kind: "equip"; slot: keyof PetGear; id: string } | { kind: "rename"; name: string };
export interface PetGain { xp: number; coins: number; levelUp: boolean; capped?: "minigame" | "focus" | "drinks" | "pets" | "coins" | "level" }

export const defaultPet: Pet = {
  name: "Nusa", thirst: 70, energy: 80, joy: 70, focus: 60, updatedAt: 0, xp: 0, coins: 20,
  streak: { current: 0, best: 0, lastDate: "" }, owned: [], equipped: { hat: "", color: "", scene: "" },
  daily: { date: "", drinks: 0, goalMet: false, minigameCoins: 0, pets: 0, focusXp: 0, breaks: 0, credited: [] }, lastBreakAt: 0, lastPetAt: 0,
};

/** Itens da loja: arte original do Heydesk (ver PetGear.tsx). */
export const cosmetics: { id: string; slot: keyof PetGear; name: string; price: number; minLevel: number; color?: string }[] = [
  { id: "hat_cap", slot: "hat", name: "Boné", price: 60, minLevel: 1 },
  { id: "hat_scarf", slot: "hat", name: "Cachecol", price: 90, minLevel: 2 },
  { id: "hat_headphones", slot: "hat", name: "Fone", price: 120, minLevel: 4 },
  { id: "hat_crown", slot: "hat", name: "Coroa", price: 220, minLevel: 8 },
  { id: "color_mint", slot: "color", name: "Menta", price: 80, minLevel: 2, color: "#9CFFD9" },
  { id: "color_gold", slot: "color", name: "Dourado", price: 160, minLevel: 6, color: "#FFD166" },
  { id: "scene_night", slot: "scene", name: "Noite", price: 120, minLevel: 3 },
  { id: "scene_beach", slot: "scene", name: "Praia", price: 180, minLevel: 5 },
];
export const colorOf = (id: string) => cosmetics.find(item => item.id === id)?.color;

const DAY = 86_400_000;
const clamp = (value: number) => Math.max(0, Math.min(100, value));
const pad = (value: number) => String(value).padStart(2, "0");
/** Dia local "AAAA-MM-DD". */
export const dayKey = (now: number) => { const date = new Date(now); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; };
export const windowOf = (water?: Water): PetWindow => ({ startMin: water?.startMin ?? 540, endMin: water?.endMin ?? 1020, days: water?.days ?? [1, 2, 3, 4, 5] });

/** Nível pela experiência: 100 xp para o 2, 300 para o 3, 1000 para o 5… (máx. 50). */
export const levelOf = (xp: number) => Math.min(50, Math.max(1, Math.floor((50 + Math.sqrt(2500 + 200 * Math.max(0, xp))) / 100)));
export const levelFloor = (level: number) => 50 * level * (level - 1);
export const stageOf = (level: number): PetStage => level >= 25 ? "lenda" : level >= 12 ? "adulto" : level >= 5 ? "jovem" : "filhote";

type Period = "work" | "off" | "night";
// Queda por hora em cada período (positivo na noite: dormir recupera energia).
const rates: Record<Period, Record<PetStat, number>> = {
  work: { thirst: -5, energy: -3, joy: -2, focus: -4 },
  off: { thirst: -2, energy: -1, joy: -1, focus: -1 },
  night: { thirst: -.5, energy: 12, joy: 0, focus: 0 },
};
function periodAt(time: number, window: PetWindow): Period {
  const date = new Date(time), minute = date.getHours() * 60 + date.getMinutes();
  if (date.getHours() >= 22 || date.getHours() < 7) return "night";
  return window.days.includes(date.getDay()) && minute >= window.startMin && minute < window.endMin ? "work" : "off";
}
const isWorkDay = (date: string, days: number[]) => { const [y, m, d] = date.split("-").map(Number); return days.includes(new Date(y, m - 1, d).getDay()); };
/** Último dia de trabalho antes de `date` (fim de semana não quebra a sequência). */
export function previousWorkDay(date: string, days: number[]) {
  const [y, m, d] = date.split("-").map(Number);
  for (let back = 1; back <= 7; back++) { const day = new Date(y, m - 1, d - back); if (days.includes(day.getDay()) || !days.length) return dayKey(day.getTime()); }
  return dayKey(new Date(y, m - 1, d - 1).getTime());
}

/** Barras até `now`, em passos de 15 min (no máximo 7 dias), e virada de dia. */
export function project(pet: Pet, window: PetWindow, now: number): Pet {
  const next: Pet = { ...pet, daily: { ...pet.daily }, streak: { ...pet.streak } };
  if (pet.updatedAt > 0 && now > pet.updatedAt) {
    const step = 15 * 60_000;
    for (let at = Math.max(pet.updatedAt, now - 7 * DAY); at < now; at += step) {
      const span = Math.min(step, now - at) / 3_600_000, rate = rates[periodAt(at, window)];
      next.thirst = clamp(next.thirst + rate.thirst * span); next.energy = clamp(next.energy + rate.energy * span);
      next.joy = clamp(next.joy + rate.joy * span); next.focus = clamp(next.focus + rate.focus * span);
    }
  }
  const today = dayKey(now);
  if (next.daily.date !== today) {
    // Dia de trabalho que passou sem bater a meta quebra a sequência.
    const missed = next.daily.date && isWorkDay(next.daily.date, window.days) && !next.daily.goalMet && next.streak.lastDate !== next.daily.date;
    if (missed) next.streak.current = 0;
    next.daily = { date: today, drinks: 0, goalMet: false, minigameCoins: 0, pets: 0, focusXp: 0, breaks: 0, credited: [] };
  }
  next.updatedAt = now;
  return next;
}

/** Retrato até agora + o efeito do evento. Devolve o bichinho novo e o que rendeu. */
export function apply(pet: Pet, event: PetEvent, window: PetWindow, now: number): { pet: Pet; gain: PetGain } {
  const next = project(pet, window, now);
  const before = levelOf(next.xp);
  let xp = 0, coins = 0;
  let capped: PetGain["capped"];
  const daily = next.daily;
  const add = (stat: PetStat, amount: number) => { next[stat] = clamp(next[stat] + amount); };
  const credit = (id: string) => { if (daily.credited.includes(id)) return false; daily.credited = [...daily.credited, id].slice(-30); return true; };
  switch (event.kind) {
    case "drink": {
      add("thirst", Math.min(20, 15 * event.ml / Math.max(1, event.cupMl))); add("joy", 1);
      if (daily.drinks < 12) { xp = 5; coins = 2; } else capped = "drinks";
      daily.drinks = Math.min(255, daily.drinks + 1);
      break;
    }
    case "goalMet": {
      if (daily.goalMet) break;
      daily.goalMet = true;
      const streak = next.streak.lastDate === previousWorkDay(daily.date, window.days) ? next.streak.current + 1 : 1;
      next.streak = { current: Math.min(3650, streak), best: Math.max(next.streak.best, Math.min(3650, streak)), lastDate: daily.date };
      xp = 40 + 5 * Math.min(streak, 10); coins = 15 + Math.min(streak, 10); add("joy", 15);
      break;
    }
    case "refuse": add("joy", -6); add("thirst", -5); break;
    case "break": {
      if (now - next.lastBreakAt < 45 * 60_000 || daily.breaks >= 6 || periodAt(now, window) !== "work") break;
      next.lastBreakAt = now; daily.breaks++; xp = 10; coins = 4; add("energy", 15); add("focus", 5);
      break;
    }
    case "teamWin": if (credit(`game:${event.id}`)) { xp = 20; coins = 10; add("joy", 25); } break;
    case "teamLoss": if (credit(`game:${event.id}`)) add("joy", -10); break;
    case "petting": {
      if (now - next.lastPetAt < 3000) break;
      next.lastPetAt = now;
      if (daily.pets < 10) { add("joy", 3); xp = 1; daily.pets++; } else { add("joy", .5); capped = "pets"; }
      break;
    }
    case "minigame": {
      xp = Math.min(30, Math.max(0, Math.round(event.score)));
      const earned = Math.min(10, Math.floor(Math.max(0, event.score) / 3));
      coins = Math.max(0, Math.min(earned, 40 - daily.minigameCoins));
      if (coins < earned) capped = "minigame";
      daily.minigameCoins += coins; add("joy", 5);
      break;
    }
    case "focus": {
      if (!credit(`focus:${event.id}`)) break;
      const minutes = Math.max(0, Math.min(event.minutes, 30));
      const date = new Date(now), minute = date.getHours() * 60 + date.getMinutes();
      if (minute > window.endMin + 60) { add("energy", -5); break; } // hora extra cansa e não rende
      xp = Math.min(minutes, Math.max(0, 60 - daily.focusXp)); if (xp < minutes) capped = "focus";
      daily.focusXp += xp; coins = Math.min(6, Math.floor(minutes / 5));
      add("focus", Math.min(30, minutes * 1.5)); add("energy", -minutes * .3);
      break;
    }
    case "buy": {
      const item = cosmetics.find(entry => entry.id === event.id);
      if (!item || next.owned.includes(item.id)) break;
      if (levelOf(next.xp) < item.minLevel) { capped = "level"; break; }
      if (next.coins < item.price) { capped = "coins"; break; }
      next.coins -= item.price; next.owned = [...next.owned, item.id];
      next.equipped = { ...next.equipped, [item.slot]: item.id };
      break;
    }
    case "equip": if (event.id === "" || next.owned.includes(event.id)) next.equipped = { ...next.equipped, [event.slot]: event.id }; break;
    case "rename": { const name = event.name.trim().slice(0, 20); if (name) next.name = name; break; }
  }
  next.xp = Math.min(10_000_000, next.xp + xp);
  next.coins = Math.min(1_000_000, next.coins + coins);
  return { pet: next, gain: { xp, coins, levelUp: levelOf(next.xp) > before, capped } };
}

/** Humor pelo estado: todas altas → feliz; barra crítica → a expressão dela. */
export function petMood(pet: Pet): { expression: MascotExpression; critical: PetStat | null; sick: boolean } {
  const stats: [PetStat, number][] = [["thirst", pet.thirst], ["energy", pet.energy], ["joy", pet.joy], ["focus", pet.focus]];
  const lowest = stats.reduce((low, item) => item[1] < low[1] ? item : low);
  const critical = lowest[1] < 20 ? lowest[0] : null;
  const sick = stats.filter(([, value]) => value < 20).length >= 2 || lowest[1] < 5;
  if (stats.every(([, value]) => value >= 70)) return { expression: "happy", critical: null, sick: false };
  const expression: MascotExpression = critical === "energy" ? "sleepy" : critical === "focus" ? "yawn" : critical ? "worried" : "normal";
  return { expression, critical, sick };
}

export const statNames: Record<PetStat, string> = { thirst: "Sede", energy: "Energia", joy: "Alegria", focus: "Foco" };
export const stageNames: Record<PetStage, string> = { filhote: "Filhote", jovem: "Jovem", adulto: "Adulto", lenda: "Lenda" };
