// Lembrete de água: quando lembrar, de quê (gole ou encher a garrafa) e com que
// humor. O período (padrão 9h–17h, dias escolhidos) é dividido pelo que falta da
// meta: tempo restante ÷ goles restantes, recalculado a cada gole, recusa ou atraso.
// Atrasou, os próximos ficam mais próximos; adiantou, mais espaçados.
import type { Water } from "./types";

export const SNOOZE_MIN = 15;
const MIN_GAP = 10 * 60_000;

export interface WaterPlan {
  /** Dia e horário dentro do período configurado, lembretes ligados. */
  active: boolean;
  drunk: number; remaining: number; sipsLeft: number;
  /** Próximo lembrete (ms); null fora do período ou com a meta batida. */
  nextAt: number | null;
  due: "drink" | "refill" | null;
  /** Humor do lembrete: 0 gentil … 3 furioso (recusas e atrasos de hoje). */
  level: 0 | 1 | 2 | 3;
  /** Período de hoje (ms) e os goles previstos daqui até o fim dele. */
  from: number; to: number; upcoming: number[];
}

const at = (now: number, minutes: number) => { const date = new Date(now); date.setHours(0, minutes, 0, 0); return date.getTime(); };

export function waterSettings(water: Water) {
  return {
    sip: water.cupMl, bottle: water.bottleMl ?? 500, left: water.bottleLeftMl ?? water.bottleMl ?? 500,
    start: water.startMin ?? 540, end: water.endMin ?? 1020, days: water.days ?? [1, 2, 3, 4, 5], snooze: water.snooze ?? true,
  };
}

export function waterPlan(water: Water, now: number): WaterPlan {
  const { sip, left, start, end, days, snooze } = waterSettings(water);
  const from = at(now, start), to = at(now, end), today = at(now, 0);
  const drunk = water.log.filter(drink => drink.at >= today).reduce((sum, drink) => sum + drink.ml, 0);
  const remaining = Math.max(0, water.goalMl - drunk), sipsLeft = Math.ceil(remaining / Math.max(1, sip));
  const active = water.reminders && days.includes(new Date(now).getDay()) && now >= from && now < to;
  const idle: WaterPlan = { active, drunk, remaining, sipsLeft, nextAt: null, due: null, level: 0, from, to, upcoming: [] };
  if (!active || !sipsLeft) return idle;
  // Ponto de partida: início do período, último gole e, sem soneca, a última recusa.
  const skips = (water.skips ?? []).filter(time => time >= today);
  const lastDrink = water.log.filter(drink => drink.at >= today).slice(-1)[0]?.at ?? 0;
  const anchor = Math.max(from, lastDrink, snooze ? 0 : skips[skips.length - 1] ?? 0);
  const gap = Math.max(MIN_GAP, (to - anchor) / sipsLeft);
  const nextAt = Math.min(anchor + gap, to - 60_000);
  // Acabou de encher a garrafa: pergunta já pelo gole.
  const asked = (water.askAt ?? 0) > 0 && now >= water.askAt!;
  const waiting = now < (water.snoozeUntil ?? 0);
  const ready = asked || now >= nextAt;
  const due = ready && !waiting ? (left < sip && !asked ? "refill" : "drink") : null;
  const late = due && now > nextAt ? Math.floor((now - nextAt) / gap) : 0;
  const level = Math.min(3, skips.length + late) as WaterPlan["level"];
  // Agenda prevista: o próximo (mesmo atrasado) e os seguintes até o fim do período.
  const upcoming = Array.from({ length: sipsLeft }, (_, index) => Math.min(anchor + gap * (index + 1), to));
  return { ...idle, nextAt: waiting ? water.snoozeUntil! : nextAt, due, level, upcoming };
}

/** Textos do lembrete, estilo Duolingo: o mascote fala em primeira pessoa, faz chantagem
 * emocional, finge que não liga e piora a cada recusa ou atraso. A recusa já começa culpada. */
const drinkCopy: [string, string][][] = [
  [["Oi! Sou eu, seu lembrete 💧", "Seu rim pediu {sip} ml. Eu só tô repassando o recado."], ["{sip} ml. Cinco segundos.", "Eu cronometrei. Você não tem desculpa."], ["Hora do gole!", "Faltam {left}. Eu acredito em você. Por enquanto."]],
  [["Você me ignorou.", "Tudo bem. Eu fico aqui, secando por dentro. {sip} ml?"], ["Eu vi que você viu.", "E não bebeu. Interessante. Muito interessante."], ["Não tô bravo.", "Só decepcionado. Faltam {left}."]],
  [["Seu rim me ligou chorando", "Disse que você parou de responder. {sip} ml, por ele."], ["Isso tá ficando constrangedor", "Até o cacto da sua mesa bebeu mais que você hoje."], ["Lembra de mim? 🥲", "Eu lembro de você. Toda hora. Faltam {left}."]],
  [["Esses lembretes não estão funcionando.", "Talvez eu pare de mandar. Brincadeira. BEBE ÁGUA."], ["Eu sei onde você mora.", "Moro no seu notch. {sip} ml. Agora."], ["Ok. Você venceu.", "Vou avisar seu rim que a culpa foi sua. 💀"]],
];
const refuseCopy = ["Prefiro desidratar", "Quero ferrar meu rim", "Meu rim que se vire", "Quero fuder o meu rim"];
const yesCopy = ["Sou responsável e bebi", "Tá, tá, bebi", "Bebi, juro por Deus", "BEBI. PARA."];
const refillCopy: [string, string][] = [["Sua garrafa tá vazia 🫙", "Enche ela. Eu espero. Eu sempre espero."], ["Garrafa vazia de novo?", "Água não brota do nada. Ainda."], ["Eu vou ser sincero", "Garrafa vazia não hidrata ninguém. Levanta."], ["LEVANTA E ENCHE.", "Não me faça repetir. Eu vou repetir."]];

const liters = (ml: number) => `${(ml / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`;
export function waterCopy(plan: WaterPlan, water: Water, now: number) {
  const { sip } = waterSettings(water);
  // Varia o texto ao longo do dia sem trocar a cada render.
  const pick = Math.floor(now / (SNOOZE_MIN * 60_000));
  const fill = (text: string) => text.replace("{sip}", String(sip)).replace("{left}", liters(plan.remaining));
  if (plan.due === "refill") {
    const [title, sub] = refillCopy[plan.level];
    return { title, sub, yes: plan.level >= 2 ? "Enchi, satisfeito?" : "Enchi a garrafa", no: refuseCopy[plan.level] };
  }
  const options = drinkCopy[plan.level];
  const [title, sub] = options[pick % options.length];
  return { title: fill(title), sub: fill(sub), yes: yesCopy[plan.level], no: refuseCopy[plan.level] };
}
