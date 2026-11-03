import { useCallback, useEffect, useRef, useState } from "react";
import type { ShellBridge } from "../../lib/shellBridge";
import type { CalendarEvent, Notes, Pet, Prompter, Todo, Water } from "./types";
import { SNOOZE_MIN } from "./waterPlan";
import { apply as applyPet, defaultPet, windowOf, type PetEvent, type PetGain } from "../pet/petSim";

export const defaultPrompter: Prompter = { text: "", speed: 4, size: 26, mirror: false, opacity: 100, height: 300 };
export const defaultWater: Water = { goalMl: 2000, cupMl: 250, reminders: true, intervalMin: 60, log: [], snoozeUntil: 0, bottleMl: 500, bottleLeftMl: 500, startMin: 540, endMin: 1020, days: [1, 2, 3, 4, 5], snooze: true, skips: [], askAt: 0 };
const empty: Notes = { note: "", todos: [], water: defaultWater };
const dayStart = (now: number) => { const date = new Date(now); date.setHours(0, 0, 0, 0); return date.getTime(); };
/** Total bebido hoje, em ml. */
export function waterToday(water: Water, now: number) { const start = dayStart(now); return water.log.filter(drink => drink.at >= start).reduce((sum, drink) => sum + drink.ml, 0); }
/** Goles de hoje por hora (0–23), em ml. */
export function waterByHour(water: Water, now: number) { const hours = new Array(24).fill(0) as number[]; const start = dayStart(now); for (const drink of water.log) if (drink.at >= start) hours[new Date(drink.at).getHours()] += drink.ml; return hours; }
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** "Reunião 15:30" → título "Reunião" às 15:30 do dia; sem hora, a próxima hora cheia. */
/** Horário no texto ("15:30", "15h30", "às 9h", "9h") vence; sem ele, vale `time` ("HH:MM"). */
export function parseEventText(text: string, day: Date, now: number, time?: string) {
  const match = text.match(/(?:^|\s)(?:às\s+)?(2[0-3]|[01]?\d)(?:[:h]([0-5]\d))?(h)?(?=\s|$)/i);
  // Número solto sem ":"/"h" ("Reunião 2") não é horário.
  const timed = match && (match[2] != null || match[3] != null || /às\s/i.test(match[0])) ? match : null;
  const title = (timed ? text.replace(timed[0], " ") : text).replace(/\s+/g, " ").trim();
  const at = new Date(day);
  const field = time?.match(/^(\d{2}):(\d{2})$/);
  if (timed) at.setHours(Number(timed[1]), Number(timed[2] ?? 0), 0, 0);
  else if (field) at.setHours(Number(field[1]), Number(field[2]), 0, 0);
  else { const next = new Date(now); at.setHours(next.getHours() + 1, 0, 0, 0); }
  return title ? { title: title.slice(0, 140), at: at.getTime() } : null;
}
export const defaultReminders = [30, 15];
const remindersOf = (event: CalendarEvent) => event.reminders ?? (event.remindMin > 0 ? [event.remindMin] : []);
/** Aviso "na hora" ainda vale até 10 min depois do início (app voltando de suspensão, tela cheia). */
const NOW_GRACE = 10 * 60_000;
/** Avisos devidos agora, um por evento: o "antes" mais próximo já alcançado vale até o início
 * (não se perde se o tique atrasar ou o painel estiver aberto); depois, "na hora" por 10 min.
 * Quem chama marca a chave como dada só quando o aviso aparece. */
export function dueReminders(events: CalendarEvent[], now: number) {
  const due: { event: CalendarEvent; kind: "before" | "now"; key: string; minutes: number }[] = [];
  for (const event of events) {
    if (now >= event.at) {
      if (now < event.at + NOW_GRACE) due.push({ event, kind: "now", key: `${event.id}:n`, minutes: 0 });
      continue;
    }
    const reached = remindersOf(event).filter(minutes => minutes > 0 && now >= event.at - minutes * 60_000);
    if (reached.length) { const minutes = Math.min(...reached); due.push({ event, kind: "before", key: `${event.id}:b${minutes}`, minutes }); }
  }
  return due;
}

/** Ordem da lista: favoritas primeiro, depois as mais antigas. Concluídas saem da vista. */
export function pendingTodos(todos: Todo[]) {
  return todos.filter(todo => !todo.done).sort((a, b) => Number(b.starred) - Number(a.starred) || a.createdAt - b.createdAt);
}

// Nota grava com atraso (digitação); tarefas gravam a cada mudança. Falha mantém
// o texto na tela e avisa, sem perder o que foi digitado.
export function useNotes(bridge: ShellBridge) {
  const [notes, setNotes] = useState<Notes>(empty);
  const [state, setState] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [error, setError] = useState("");
  const latest = useRef(notes);
  const timer = useRef<number>();
  // Só grava depois de ler o arquivo com sucesso: com a leitura falhando, as notas em
  // memória estão vazias e gravar apagaria nota, tarefas e água do disco.
  const loaded = useRef(!bridge.loadNotes);
  const persist = useCallback((next: Notes) => {
    if (!loaded.current) return;
    if (!bridge.saveNotes) { setState("ready"); return; }
    setState("saving");
    bridge.saveNotes(next).then(() => { if (latest.current === next) { setState("ready"); setError(""); } })
      .catch(reason => { setState("error"); setError(typeof reason === "string" ? reason : "Não foi possível salvar."); });
  }, [bridge]);
  const update = useCallback((next: Notes, delay = 0) => {
    latest.current = next; setNotes(next);
    window.clearTimeout(timer.current);
    if (delay) { setState("saving"); timer.current = window.setTimeout(() => { timer.current = undefined; persist(latest.current); }, delay); }
    else persist(next);
  }, [persist]);
  useEffect(() => {
    let active = true;
    if (!bridge.loadNotes) { setState("ready"); return; }
    bridge.loadNotes().then(value => { if (active) { loaded.current = true; latest.current = value; setNotes(value); setState("ready"); } })
      .catch(reason => { if (active) { setState("error"); setError(typeof reason === "string" ? reason : "Não foi possível ler as notas."); } });
    return () => { active = false; };
  }, [bridge]);
  // Gravado em outra janela (ajustes da água nas configurações): adota, salvo edição pendente aqui.
  useEffect(() => {
    if (!bridge.onDesktopEvent) return;
    let stop: (() => void) | undefined, alive = true;
    void bridge.onDesktopEvent("notes:changed", payload => {
      let next = payload as Notes;
      if (JSON.stringify(next) === JSON.stringify(latest.current)) return;
      // Digitação pendente aqui (nota, teleprompter): adota o resto e mantém o texto local.
      if (timer.current) next = { ...next, note: latest.current.note, prompter: latest.current.prompter };
      // A outra janela grava com a cópia dela do bichinho: fica o mais novo.
      if ((latest.current.pet?.updatedAt ?? 0) > (next.pet?.updatedAt ?? 0)) next = { ...next, pet: latest.current.pet };
      if (!loaded.current) loaded.current = true;
      latest.current = next; setNotes(next);
    }).then(fn => { if (alive) stop = fn; else fn(); });
    return () => { alive = false; stop?.(); };
  }, [bridge]);
  // Sair do app com a nota pendente: grava o que estiver na fila.
  useEffect(() => () => { if (timer.current) { window.clearTimeout(timer.current); persist(latest.current); } }, [persist]);
  const current = () => latest.current;
  /** Bichinho depois de um ou mais eventos (mesma gravação do que os causou) e o que rendeu. */
  const fed = (notes: Notes, events: PetEvent[], now: number): { pet: Pet; gain: PetGain } => {
    let pet = notes.pet ?? defaultPet;
    const gain: PetGain = { xp: 0, coins: 0, levelUp: false };
    for (const event of events) {
      const result = applyPet(pet, event, windowOf(notes.water), now);
      pet = result.pet;
      gain.xp += result.gain.xp; gain.coins += result.gain.coins; gain.levelUp ||= result.gain.levelUp;
      gain.capped ??= result.gain.capped; gain.mission ??= result.gain.mission;
    }
    return { pet, gain };
  };
  return {
    notes, state, error,
    setNote: (note: string) => update({ ...current(), note }, 600),
    prompter: notes.prompter ?? defaultPrompter,
    /** Texto grava com atraso (digitação); controles na hora. */
    setPrompter: (patch: Partial<Prompter>) => update({ ...current(), prompter: { ...(current().prompter ?? defaultPrompter), ...patch } }, "text" in patch ? 600 : 0),
    addTodo: (text: string) => {
      const clean = text.trim().slice(0, 280);
      if (!clean) return;
      update({ ...current(), todos: [...current().todos, { id: newId(), text: clean, done: false, starred: false, createdAt: Date.now() }] });
    },
    toggleTodo: (id: string, key: "done" | "starred") => {
      const base = current(), todo = base.todos.find(item => item.id === id);
      const todos = base.todos.map(item => item.id === id ? { ...item, [key]: !item[key] } : item);
      // Concluir tarefa dá foco ao bichinho (uma vez por tarefa no dia).
      const pet = key === "done" && todo && !todo.done ? fed(base, [{ kind: "task", id }], Date.now()).pet : base.pet;
      update({ ...base, todos, pet });
    },
    removeTodo: (id: string) => update({ ...current(), todos: current().todos.filter(todo => todo.id !== id) }),
    clearDone: () => update({ ...current(), todos: current().todos.filter(todo => !todo.done) }),
    // Água: o registro guarda 7 dias; o resto sai ao gravar.
    water: notes.water ?? defaultWater,
    drink: (ml?: number) => {
      const water = current().water ?? defaultWater, now = Date.now(), sip = ml ?? water.cupMl;
      const left = Math.max(0, (water.bottleLeftMl ?? water.bottleMl ?? 500) - sip);
      const nextWater = { ...water, snoozeUntil: 0, askAt: 0, bottleLeftMl: left, log: [...water.log.filter(drink => now - drink.at < 7 * 86_400_000), { at: now, ml: sip }] };
      // O gole mata a sede do bichinho; bater a meta rende o bônus do dia.
      const events: PetEvent[] = [{ kind: "drink", ml: sip, cupMl: water.cupMl }];
      if (waterToday(nextWater, now) >= nextWater.goalMl) events.push({ kind: "goalMet" });
      const result = fed({ ...current(), water: nextWater }, events, now);
      update({ ...current(), water: nextWater, pet: result.pet });
      return result.gain;
    },
    /** Garrafa cheia de novo; logo em seguida o lembrete já pede o gole. */
    refillWater: () => { const water = current().water ?? defaultWater; update({ ...current(), water: { ...water, bottleLeftMl: water.bottleMl ?? 500, snoozeUntil: 0, askAt: Date.now() } }); },
    /** Recusa do lembrete: com soneca, volta em 15 min; sem, pula e redistribui a meta. Conta para o humor do dia. */
    refuseWater: () => {
      const water = current().water ?? defaultWater, now = Date.now();
      const skips = [...(water.skips ?? []).filter(time => now - time < 86_400_000), now].slice(-50);
      update({ ...current(), water: { ...water, skips, askAt: 0, snoozeUntil: water.snooze ?? true ? now + SNOOZE_MIN * 60_000 : 0 }, pet: fed(current(), [{ kind: "refuse" }], now).pet });
    },
    pet: notes.pet ?? defaultPet,
    /** Evento do bichinho (carinho, mini-jogo, loja…) gravado na hora. */
    petEvent: (event: PetEvent) => {
      const now = Date.now(), base = current(), before = base.pet ?? defaultPet;
      const result = applyPet(before, event, windowOf(base.water), now);
      // Evento sem efeito (dentro do intervalo, limite do dia): não grava o disco à toa.
      const changed = JSON.stringify({ ...result.pet, updatedAt: 0 }) !== JSON.stringify({ ...before, updatedAt: 0 });
      if (changed) update({ ...base, pet: result.pet });
      return result.gain;
    },
    /** Grava só a virada do dia / queda acumulada (sem evento). */
    setPet: (pet: Pet) => update({ ...current(), pet }),
    undoDrink: () => {
      const water = current().water ?? defaultWater, last = water.log[water.log.length - 1];
      update({ ...current(), water: { ...water, log: water.log.slice(0, -1), bottleLeftMl: Math.min(water.bottleMl ?? 500, (water.bottleLeftMl ?? 0) + (last?.ml ?? 0)) } });
    },
    events: notes.events ?? [],
    addEvent: (title: string, at: number, reminders: number[] = defaultReminders) => update({ ...current(), events: [...(current().events ?? []).filter(event => event.at > Date.now() - 30 * 86_400_000), { id: newId(), title, at, remindMin: 0, reminders: [...reminders].sort((a, b) => b - a) }].sort((a, b) => a.at - b.at) }),
    removeEvent: (id: string) => update({ ...current(), events: (current().events ?? []).filter(event => event.id !== id) }),
    setWater: (patch: Partial<Water>) => update({ ...current(), water: { ...(current().water ?? defaultWater), ...patch } }),
  };
}
export type NotesControl = ReturnType<typeof useNotes>;
