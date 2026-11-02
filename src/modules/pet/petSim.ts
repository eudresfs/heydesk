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
  | { kind: "focus"; minutes: number; id: string } | { kind: "task"; id: string }
  | { kind: "buy"; id: string } | { kind: "equip"; slot: keyof PetGear; id: string } | { kind: "rename"; name: string };
export interface PetGain { xp: number; coins: number; levelUp: boolean; capped?: "minigame" | "focus" | "drinks" | "pets" | "coins" | "level" | "snack" | "soon"; mission?: string }

export const defaultPet: Pet = {
  name: "Nusa", thirst: 70, energy: 80, joy: 70, focus: 60, updatedAt: 0, xp: 0, coins: 20,
  streak: { current: 0, best: 0, lastDate: "" }, owned: [], equipped: { hat: "", color: "", scene: "" },
  daily: { date: "", drinks: 0, goalMet: false, minigameCoins: 0, minigameXp: 0, games: 0, pets: 0, focusXp: 0, focusCoins: 0, breaks: 0, refusals: 0, tasks: 0, snack: false, credited: [] },
  lastBreakAt: 0, lastPetAt: 0, lastDrinkAt: 0, lastRefuseAt: 0,
};

/** Loja: acessórios (arte original do Heydesk, ver PetGear.tsx), cores e o petisco do dia. */
export const cosmetics: { id: string; slot: keyof PetGear | "snack"; name: string; price: number; minLevel: number; color?: string; hint?: string }[] = [
  { id: "snack", slot: "snack", name: "Petisco", price: 15, minLevel: 1, hint: "+20 de alegria, 1 por dia" },
  { id: "hat_cap", slot: "hat", name: "Boné", price: 60, minLevel: 1 },
  { id: "color_mint", slot: "color", name: "Olhos menta", price: 80, minLevel: 2, color: "#9CFFD9" },
  { id: "hat_scarf", slot: "hat", name: "Cachecol", price: 90, minLevel: 2 },
  { id: "hat_headphones", slot: "hat", name: "Fone", price: 120, minLevel: 4 },
  { id: "color_gold", slot: "color", name: "Olhos dourados", price: 160, minLevel: 6, color: "#FFD166" },
  { id: "hat_crown", slot: "hat", name: "Coroa", price: 220, minLevel: 8 },
  { id: "hat_beanie", slot: "hat", name: "Gorro", price: 250, minLevel: 10 },
  { id: "hat_glasses", slot: "hat", name: "Óculos", price: 350, minLevel: 15 },
  { id: "hat_halo", slot: "hat", name: "Auréola", price: 450, minLevel: 20 },
  { id: "hat_star", slot: "hat", name: "Coroa estelar", price: 600, minLevel: 30 },
];
export const colorOf = (id: string) => cosmetics.find(item => item.id === id)?.color;

/** Missões do dia: cada uma rende 20 XP e 5 moedas; as três juntas abrem um baú de 15. */
export const missions: { id: string; name: string }[] = [
  { id: "goal", name: "Bater a meta de água" },
  { id: "break", name: "Fazer uma pausa" },
  { id: "game", name: "Jogar uma partida" },
];
export const missionDone = (pet: Pet, id: string) => pet.daily.credited.includes(`mission:${id}`);

const DAY = 86_400_000;
const FLOOR = 30; // o tempo sozinho não derruba Água, Alegria e Foco abaixo disto
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
// Variação por hora em cada período (positivo: recupera). Dormir recupera energia e foco.
const rates: Record<Period, Record<PetStat, number>> = {
  work: { thirst: -5, energy: -3, joy: -2, focus: -2 },
  off: { thirst: -1, energy: -1, joy: -1, focus: -1 },
  night: { thirst: -.5, energy: 12, joy: 0, focus: 3 },
};
export function periodAt(time: number, window: PetWindow): Period {
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
const freshDaily = (date: string): Pet["daily"] => ({ ...defaultPet.daily, date, credited: [] });

/** Barras até `now`, em passos de 15 min (no máximo 7 dias), e virada de dia. */
export function project(pet: Pet, window: PetWindow, now: number): Pet {
  const next: Pet = { ...defaultPet, ...pet, daily: { ...defaultPet.daily, ...pet.daily }, streak: { ...pet.streak } };
  // Relógio voltou (mudança manual de data/hora): não recalcula nem reabre o dia.
  if (pet.updatedAt > now + 5 * 60_000) return next;
  if (pet.updatedAt > 0 && now > pet.updatedAt) {
    const step = 15 * 60_000;
    for (let at = Math.max(pet.updatedAt, now - 7 * DAY); at < now; at += step) {
      const span = Math.min(step, now - at) / 3_600_000, rate = rates[periodAt(at, window)];
      for (const stat of ["thirst", "energy", "joy", "focus"] as PetStat[]) {
        const change = rate[stat] * span;
        // Queda passiva para no piso; acima dele (ou subindo) vale normal.
        next[stat] = change < 0 && stat !== "energy" ? Math.max(Math.min(next[stat], FLOOR), next[stat] + change) : clamp(next[stat] + change);
      }
    }
  }
  const today = dayKey(now);
  if (next.daily.date < today) {
    // Dias úteis sem meta desde a última meta quebram a sequência (mesmo com o app fechado).
    if (next.streak.current && next.streak.lastDate < previousWorkDay(today, window.days)) next.streak.current = 0;
    next.daily = freshDaily(today);
  }
  next.updatedAt = Math.max(next.updatedAt, now);
  return next;
}

/** Retrato até agora + o efeito do evento. Devolve o bichinho novo e o que rendeu. */
export function apply(pet: Pet, event: PetEvent, window: PetWindow, now: number): { pet: Pet; gain: PetGain } {
  const next = project(pet, window, now);
  const before = levelOf(next.xp);
  let xp = 0, coins = 0;
  let capped: PetGain["capped"], mission: string | undefined;
  const daily = next.daily;
  const add = (stat: PetStat, amount: number) => { next[stat] = clamp(next[stat] + amount); };
  const credit = (id: string) => { if (daily.credited.includes(id)) return false; daily.credited = [...daily.credited, id].slice(-30); return true; };
  const completeMission = (id: string) => {
    if (!credit(`mission:${id}`)) return;
    xp += 20; coins += 5; mission = missions.find(item => item.id === id)?.name;
    if (missions.every(item => daily.credited.includes(`mission:${item.id}`)) && credit("mission:chest")) coins += 15;
  };
  switch (event.kind) {
    case "drink": {
      // A água sempre sobe; XP e moedas só com goles espaçados (10 min) e até 12 por dia.
      add("thirst", Math.min(20, 15 * event.ml / Math.max(1, event.cupMl))); add("joy", 1);
      if (daily.drinks >= 12) capped = "drinks";
      else if (now - next.lastDrinkAt < 10 * 60_000) capped = "soon";
      else { xp = 5; coins = 2; daily.drinks = Math.min(255, daily.drinks + 1); next.lastDrinkAt = now; }
      break;
    }
    case "goalMet": {
      if (daily.goalMet) break;
      daily.goalMet = true;
      xp = 40; coins = 15; add("joy", 15);
      // Fim de semana (fora dos dias de trabalho) dá o bônus, mas não mexe na sequência.
      if (isWorkDay(daily.date, window.days)) {
        const streak = next.streak.lastDate >= previousWorkDay(daily.date, window.days) ? next.streak.current + 1 : 1;
        next.streak = { current: Math.min(3650, streak), best: Math.max(next.streak.best, Math.min(3650, streak)), lastDate: daily.date };
        xp += 5 * Math.min(streak, 10); coins += Math.min(streak, 10);
      }
      completeMission("goal");
      break;
    }
    case "refuse": {
      // Recusar já tem o lembrete insistindo: aqui pesa pouco, 1 vez por hora e até 3 por dia.
      if (now - next.lastRefuseAt < 3_600_000 || daily.refusals >= 3) break;
      next.lastRefuseAt = now; daily.refusals++; add("joy", -3);
      break;
    }
    case "break": {
      if (now - next.lastBreakAt < 45 * 60_000 || daily.breaks >= 6 || periodAt(now, window) !== "work") break;
      next.lastBreakAt = now; daily.breaks++; xp = 10; coins = 4; add("energy", 15); add("focus", 10);
      completeMission("break");
      break;
    }
    case "teamWin": if (credit(`game:${event.id}`)) { xp = 20; coins = 10; add("joy", 25); } break;
    case "teamLoss": if (credit(`game:${event.id}`)) add("joy", -10); break;
    case "petting": {
      if (now - next.lastPetAt < 3000) break;
      next.lastPetAt = now;
      if (daily.pets < 10) { add("joy", 3); xp = 1; daily.pets++; } else capped = "pets";
      break;
    }
    case "minigame": {
      const score = Math.max(0, event.score);
      const earnedXp = Math.min(30, Math.round(score / 4)), earnedCoins = Math.min(10, Math.floor(score / 10));
      xp = Math.min(earnedXp, Math.max(0, 90 - daily.minigameXp));
      coins = Math.min(earnedCoins, Math.max(0, 40 - daily.minigameCoins));
      if (xp < earnedXp || coins < earnedCoins) capped = "minigame";
      daily.minigameXp += xp; daily.minigameCoins += coins;
      if (score > 0 && daily.games < 4) add("joy", 5);
      daily.games = Math.min(255, daily.games + 1);
      if (score > 0) completeMission("game");
      break;
    }
    case "focus": {
      if (!credit(`focus:${event.id}`)) break;
      const minutes = Math.max(0, Math.min(event.minutes, 30));
      if (periodAt(now, window) !== "work") { add("energy", -5); break; } // fora do expediente: cansa e não rende
      xp = Math.min(minutes, Math.max(0, 60 - daily.focusXp)); if (xp < minutes) capped = "focus";
      coins = Math.min(Math.floor(minutes / 5), Math.max(0, 12 - daily.focusCoins));
      daily.focusXp += xp; daily.focusCoins += coins;
      add("focus", Math.min(30, minutes * 1.5)); add("energy", -minutes * .3);
      break;
    }
    case "task": {
      if (daily.tasks >= 10 || !credit(`task:${event.id}`)) break;
      daily.tasks++; xp = 3; add("focus", 5);
      break;
    }
    case "buy": {
      const item = cosmetics.find(entry => entry.id === event.id);
      if (!item) break;
      if (levelOf(next.xp) < item.minLevel) { capped = "level"; break; }
      if (next.coins < item.price) { capped = "coins"; break; }
      if (item.slot === "snack") {
        if (daily.snack) { capped = "snack"; break; }
        daily.snack = true; next.coins -= item.price; add("joy", 20);
        break;
      }
      if (next.owned.includes(item.id)) break;
      next.coins -= item.price; next.owned = [...next.owned, item.id];
      next.equipped = { ...next.equipped, [item.slot]: item.id };
      break;
    }
    case "equip": if (event.id === "" || next.owned.includes(event.id)) next.equipped = { ...next.equipped, [event.slot]: event.id }; break;
    case "rename": { const name = event.name.trim().slice(0, 20); if (name) next.name = name; break; }
  }
  next.xp = Math.min(10_000_000, next.xp + xp);
  next.coins = Math.min(1_000_000, next.coins + coins);
  return { pet: next, gain: { xp, coins, levelUp: levelOf(next.xp) > before, capped, mission } };
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

export const statNames: Record<PetStat, string> = { thirst: "Água", energy: "Energia", joy: "Alegria", focus: "Foco" };
/** Como cada barra sobe (dica na página). */
export const statHints: Record<PetStat, string> = {
  thirst: "Sobe quando você bebe água.",
  energy: "Sobe com pausas longe do PC e à noite.",
  joy: "Sobe com carinho, metas, jogos, petisco e vitórias do seu time.",
  focus: "Sobe com pausas, tarefas concluídas, gravações e à noite.",
};
export const stageNames: Record<PetStage, string> = { filhote: "Filhote", jovem: "Jovem", adulto: "Adulto", lenda: "Lenda" };
