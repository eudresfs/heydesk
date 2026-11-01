import { strict as assert } from "node:assert";
import { test } from "node:test";
import { apply, dayKey, defaultPet, levelOf, petMood, previousWorkDay, project, stageOf, type PetWindow } from "../src/modules/pet/petSim";
import type { Pet } from "../src/modules/context/types";

const window: PetWindow = { startMin: 540, endMin: 1020, days: [1, 2, 3, 4, 5] };
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();
// 2026-11-02 é segunda-feira.
const monday10 = at(2026, 11, 2, 10);
const pet = (patch: Partial<Pet> = {}): Pet => ({ ...defaultPet, daily: { ...defaultPet.daily }, streak: { ...defaultPet.streak }, ...patch });

test("bichinho novo não seca desde 1970", () => {
  const fresh = project(pet(), window, monday10);
  assert.equal(fresh.thirst, 70);
  assert.equal(fresh.updatedAt, monday10);
});

test("3 h de trabalho tiram 15 de sede; noite recupera energia sem passar de 100", () => {
  const start = project(pet(), window, monday10);
  const later = project(start, window, monday10 + 3 * 3_600_000);
  assert.equal(Math.round(later.thirst), 55);
  const night = project(pet({ energy: 90, updatedAt: at(2026, 11, 2, 22, 30), daily: { ...defaultPet.daily, date: "2026-11-02" } }), window, at(2026, 11, 3, 5));
  assert.equal(night.energy, 100);
});

test("30 dias parado: nada negativo e só 7 dias contam", () => {
  const old = project(pet({ updatedAt: monday10 - 30 * 86_400_000 }), window, monday10);
  for (const value of [old.thirst, old.energy, old.joy, old.focus]) assert.ok(value >= 0 && value <= 100);
});

test("nível e estágio nas fronteiras", () => {
  assert.deepEqual([99, 100, 299, 300, 1000].map(levelOf), [1, 2, 2, 3, 5]);
  assert.deepEqual([1, 5, 12, 25].map(stageOf), ["filhote", "jovem", "adulto", "lenda"]);
});

test("gole rende só nos 12 primeiros do dia; sede sobe sempre", () => {
  let current = project(pet(), window, monday10);
  let gain;
  for (let i = 0; i < 12; i++) ({ pet: current, gain } = apply(current, { kind: "drink", ml: 250, cupMl: 250 }, window, monday10 + i));
  assert.equal(gain!.xp, 5);
  const thirst = current.thirst;
  ({ pet: current, gain } = apply({ ...current, thirst: 10 }, { kind: "drink", ml: 250, cupMl: 250 }, window, monday10 + 20));
  assert.equal(gain.xp, 0);
  assert.equal(gain.capped, "drinks");
  assert.ok(current.thirst > 10 && thirst >= 0);
});

test("sequência pula o fim de semana e quebra em dia útil sem meta", () => {
  assert.equal(previousWorkDay("2026-11-02", window.days), "2026-10-30");
  const friday = pet({ streak: { current: 3, best: 3, lastDate: "2026-10-30" }, daily: { ...defaultPet.daily, date: "2026-10-30", goalMet: true }, updatedAt: at(2026, 10, 30, 18) });
  const { pet: monday, gain } = apply(friday, { kind: "goalMet" }, window, monday10);
  assert.equal(monday.streak.current, 4);
  assert.equal(gain.xp, 60);
  const missedTuesday = project(pet({ ...monday, daily: { ...monday.daily, goalMet: false, date: "2026-11-03" }, streak: { ...monday.streak }, updatedAt: at(2026, 11, 3, 18) }), window, at(2026, 11, 4, 10));
  assert.equal(missedTuesday.streak.current, 0);
  assert.equal(missedTuesday.daily.date, dayKey(at(2026, 11, 4, 10)));
});

test("mini-jogo para de dar moedas depois de 40 no dia", () => {
  let current = project(pet(), window, monday10), gain;
  for (let i = 0; i < 4; i++) ({ pet: current, gain } = apply(current, { kind: "minigame", game: "gota", score: 60 }, window, monday10 + i));
  assert.equal(current.daily.minigameCoins, 40);
  ({ pet: current, gain } = apply(current, { kind: "minigame", game: "gota", score: 60 }, window, monday10 + 9));
  assert.equal(gain.coins, 0);
  assert.equal(gain.capped, "minigame");
  assert.equal(gain.xp, 30);
});

test("carinho tem intervalo de 3 s; loja exige moedas e nível", () => {
  const first = apply(project(pet(), window, monday10), { kind: "petting" }, window, monday10);
  const spam = apply(first.pet, { kind: "petting" }, window, monday10 + 1000);
  assert.equal(first.gain.xp, 1);
  assert.equal(spam.gain.xp, 0);
  const broke = apply(pet({ coins: 10 }), { kind: "buy", id: "hat_cap" }, window, monday10);
  assert.equal(broke.gain.capped, "coins");
  assert.deepEqual(broke.pet.owned, []);
  const crown = apply(pet({ coins: 999 }), { kind: "buy", id: "hat_crown" }, window, monday10);
  assert.equal(crown.gain.capped, "level");
  const cap = apply(pet({ coins: 100 }), { kind: "buy", id: "hat_cap" }, window, monday10);
  assert.equal(cap.pet.coins, 40);
  assert.equal(cap.pet.equipped.hat, "hat_cap");
});

test("time vence uma vez por jogo", () => {
  const win = apply(pet(), { kind: "teamWin", id: "hltv:cs2|1" }, window, monday10);
  const again = apply(win.pet, { kind: "teamWin", id: "hltv:cs2|1" }, window, monday10 + 10);
  assert.equal(win.gain.coins, 10);
  assert.equal(again.gain.coins, 0);
});

test("humor sai das barras", () => {
  assert.equal(petMood(pet({ thirst: 90, energy: 90, joy: 90, focus: 90 })).expression, "happy");
  assert.deepEqual(petMood(pet({ thirst: 10 })), { expression: "worried", critical: "thirst", sick: false });
  assert.equal(petMood(pet({ energy: 10 })).expression, "sleepy");
  assert.equal(petMood(pet({ energy: 10, joy: 10 })).sick, true);
});
