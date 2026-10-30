import { strict as assert } from "node:assert";
import { test } from "node:test";
import { advanceActivities, detectActivities, enqueueActivities, idleActivity, type ActivityInput } from "../src/modules/activity/activity";
import { isTickle } from "../src/modules/context/useMascotTouch";
import { dueReminders, parseEventText } from "../src/modules/context/useNotes";
import { orderPages } from "../src/modules/context/ContextPages";
import { waterCopy, waterPlan } from "../src/modules/context/waterPlan";
import { csFinished, csFinishedMap, csMapScore, kickoffAlert, scoreLabel, sportsActivities, type SportGame } from "../src/modules/sports/useSports";
import type { DesktopSnapshot, Water } from "../src/modules/context/types";

const snapshot = (battery: Partial<NonNullable<DesktopSnapshot["battery"]>>, media: DesktopSnapshot["media"] = null): DesktopSnapshot => ({
  observedAt: null, cpuPercent: null, memory: null, weather: null, media,
  battery: { percent: 50, charging: false, plugged: false, hasBattery: true, ...battery },
});
const track = (title: string, state: "playing" | "paused" = "playing") => ({ state, title, artist: "Keane" });

test("primeira leitura não anuncia; tomada liga e desliga pela linha AC, não pela flag de carga", () => {
  assert.deepEqual(detectActivities(null, snapshot({ plugged: true })), []);
  const plugged = detectActivities(snapshot({ plugged: false, percent: 100 }), snapshot({ plugged: true, charging: false, percent: 100 }));
  assert.deepEqual(plugged.map(item => [item.kind, item.value, item.mood]), [["plugged", "100%", "happy"]]);
  assert.equal(detectActivities(snapshot({ plugged: true }), snapshot({ plugged: false }))[0].kind, "unplugged");
  assert.deepEqual(detectActivities(snapshot({ plugged: true }), snapshot({ plugged: true })), []);
});

test("bateria baixa anuncia só ao cruzar 20% e 10% fora da tomada", () => {
  assert.equal(detectActivities(snapshot({ percent: 21 }), snapshot({ percent: 20 }))[0].kind, "battery-low");
  assert.equal(detectActivities(snapshot({ percent: 11 }), snapshot({ percent: 10 }))[0].kind, "battery-critical");
  assert.deepEqual(detectActivities(snapshot({ percent: 19 }), snapshot({ percent: 18 })), []);
  assert.deepEqual(detectActivities(snapshot({ percent: 21, plugged: true }), snapshot({ percent: 20, plugged: true })), []);
});

test("troca de faixa tocando anuncia; pausa e primeira mídia não", () => {
  assert.equal(detectActivities(snapshot({}, track("A")), snapshot({}, track("B")))[0].value, "B");
  assert.deepEqual(detectActivities(snapshot({}, track("A")), snapshot({}, track("A"))), []);
  assert.deepEqual(detectActivities(snapshot({}, track("A")), snapshot({}, track("B", "paused"))), []);
  assert.deepEqual(detectActivities(snapshot({}, null), snapshot({}, track("B"))), []);
});

test("fila mostra um por vez, prioridade interrompe, mesmo grupo substitui e expira em ordem", () => {
  const item = (kind: ActivityInput["kind"], group: ActivityInput["group"], priority: number, durationMs = 1000): ActivityInput =>
    ({ kind, group, priority, durationMs, icon: "plug", value: kind, label: kind, width: 260, mood: "happy", tone: "neutral" });
  let state = enqueueActivities(idleActivity, [item("track", "track", 1)], 0);
  assert.equal(state.current?.kind, "track");
  state = enqueueActivities(state, [item("battery-low", "battery", 4)], 100);
  assert.equal(state.current?.kind, "battery-low");
  assert.deepEqual(state.queue.map(entry => entry.kind), ["track"]);
  state = enqueueActivities(state, [item("plugged", "power", 3)], 200);
  assert.equal(state.current?.kind, "battery-low");
  state = enqueueActivities(state, [item("unplugged", "power", 3)], 300);
  assert.deepEqual(state.queue.map(entry => entry.kind), ["track", "unplugged"]);
  state = advanceActivities(state, 1100);
  assert.equal(state.current?.kind, "unplugged");
  state = advanceActivities(state, 2100);
  assert.equal(state.current?.kind, "track");
  state = advanceActivities(state, 3200);
  assert.equal(state.current, null);
});

test("cócegas pedem quatro idas e voltas em 700 ms", () => {
  assert.equal(isTickle([0, 100, 200], 250), false);
  assert.equal(isTickle([0, 100, 200, 300], 350), true);
  assert.equal(isTickle([0, 100, 200, 900], 950), false);
});

test("esporte: placar que muda anuncia e o mascote comemora só ponto do time seguido; aviso de início uma vez", () => {
  const game = (homeScore: string, awayScore: string, state: SportGame["state"] = "in", start = 0): SportGame => ({ id: "l|1", league: "l", leagueName: "Liga", start, state, detail: "", clock: "60'", followed: true,
    home: { id: "h", name: "Casa", short: "CAS", logo: null, score: homeScore }, away: { id: "v", name: "Visita", short: "VIS", logo: null, score: awayScore } });
  const snap = (item: SportGame, observedAt = 0) => ({ games: [item], observedAt, errors: [] });
  const goal = sportsActivities(snap(game("0", "0")), snap(game("1", "0")), 0, ["l|h"]);
  assert.deepEqual(goal.map(item => [item.kind, item.value, item.mood]), [["score", "CAS 1–0 VIS", "happy"]]);
  assert.equal(sportsActivities(snap(game("1", "0")), snap(game("1", "1")), 0, ["l|h"])[0].mood, "worried");
  assert.deepEqual(sportsActivities(snap(game("1", "0")), snap(game("1", "0")), 0, ["l|h"]), []);
  const start = 30 * 60_000 - 30_000;
  assert.equal(kickoffAlert(game("", "", "pre", start), 0), 30);
  const first = sportsActivities(snap(game("", "", "pre", start), -60_000), snap(game("", "", "pre", start)), 0, []);
  assert.deepEqual(first.map(item => item.value), ["CAS × VIS em 30 min"]);
  assert.deepEqual(sportsActivities(snap(game("", "", "pre", start), 0), snap(game("", "", "pre", start)), 10_000, []), [], "não repete no mesmo minuto");
});

test("agenda entende hora no texto e avisa 10 min antes e na hora, uma janela de 1 minuto", () => {
  const day = new Date(2026, 9, 30), now = new Date(2026, 9, 30, 9, 12).getTime();
  const parsed = parseEventText("Reunião com time 15:30", day, now)!;
  assert.equal(parsed.title, "Reunião com time"); assert.equal(new Date(parsed.at).getHours(), 15); assert.equal(new Date(parsed.at).getMinutes(), 30);
  assert.equal(new Date(parseEventText("Dentista às 9h", day, now)!.at).getHours(), 9);
  assert.equal(new Date(parseEventText("Ligar pro banco", day, now)!.at).getHours(), 10, "sem hora: próxima hora cheia");
  assert.equal(parseEventText("   ", day, now), null);
  const event = { id: "e", title: "Dentista", at: new Date(2026, 9, 30, 15, 0).getTime(), remindMin: 10 };
  assert.deepEqual(dueReminders([event], event.at - 10 * 60_000 + 5_000).map(due => due.kind), ["before"]);
  assert.deepEqual(dueReminders([event], event.at + 30_000).map(due => due.kind), ["now"]);
  assert.deepEqual(dueReminders([event], event.at - 5 * 60_000), []);
  // Campo de horário vale quando o texto não traz hora; número solto não é hora.
  const picked = parseEventText("Reunião 2", day, now, "16:45")!;
  assert.equal(picked.title, "Reunião 2"); assert.equal(new Date(picked.at).getHours(), 16); assert.equal(new Date(picked.at).getMinutes(), 45);
  assert.equal(new Date(parseEventText("Café 8h30", day, now, "16:45")!.at).getHours(), 8, "hora no texto vence o campo");
  // Lembretes múltiplos: 30 e 15 min antes, cada um com chave própria.
  const both = { ...event, remindMin: 0, reminders: [30, 15] };
  assert.deepEqual(dueReminders([both], both.at - 30 * 60_000 + 1_000).map(due => [due.kind, due.minutes]), [["before", 30]]);
  assert.deepEqual(dueReminders([both], both.at - 15 * 60_000 + 1_000).map(due => due.key), ["e:b15"]);
});

test("água divide a meta pelo período, recalcula a cada gole e azeda com recusas", () => {
  const at = (hour: number, minute = 0, day = 30) => new Date(2026, 9, day, hour, minute).getTime(); // 30/10/2026: sexta
  const water: Water = { goalMl: 2000, cupMl: 250, reminders: true, intervalMin: 60, log: [], snoozeUntil: 0, bottleMl: 750, bottleLeftMl: 750, startMin: 540, endMin: 1020, days: [1, 2, 3, 4, 5], snooze: true, skips: [] };
  // 9h–17h para 8 goles de 250 ml: um a cada hora, a partir das 9h.
  assert.equal(waterPlan(water, at(9, 59)).due, null);
  assert.equal(waterPlan(water, at(10, 1)).due, "drink");
  assert.equal(waterPlan(water, at(8, 30)).active, false, "antes do período");
  assert.equal(waterPlan(water, at(17, 30)).active, false, "depois do período");
  assert.equal(waterPlan(water, at(11, 0, 31)).active, false, "sábado fora dos dias escolhidos");
  // Gole às 10h05: 7 goles restantes no que sobra do dia (~59 min cada).
  const after = waterPlan({ ...water, log: [{ at: at(10, 5), ml: 250 }] }, at(10, 30));
  assert.equal(after.due, null); assert.equal(after.sipsLeft, 7);
  assert.ok(Math.abs(after.nextAt! - (at(10, 5) + (at(17) - at(10, 5)) / 7)) < 1000);
  // Atraso faz o humor subir; recusas também.
  assert.equal(waterPlan(water, at(12, 30)).level, 2);
  const refused = { ...water, skips: [at(10, 2)], snoozeUntil: at(10, 17) };
  assert.equal(waterPlan(refused, at(10, 10)).due, null, "soneca de 15 min");
  assert.equal(waterPlan(refused, at(10, 18)).due, "drink");
  assert.ok(waterPlan(refused, at(10, 18)).level >= 1);
  // Sem soneca, a recusa pula o gole: o próximo conta a partir dela.
  assert.equal(waterPlan({ ...water, snooze: false, skips: [at(10, 2)] }, at(10, 30)).due, null);
  // Garrafa sem o suficiente para um gole: lembra de encher; encheu, pede o gole na hora.
  assert.equal(waterPlan({ ...water, bottleLeftMl: 100 }, at(10, 1)).due, "refill");
  assert.equal(waterPlan({ ...water, log: [{ at: at(10), ml: 250 }], askAt: at(10, 20) }, at(10, 21)).due, "drink");
  // Meta batida: sem lembrete.
  assert.equal(waterPlan({ ...water, log: [{ at: at(9, 30), ml: 2000 }] }, at(12)).due, null);
  assert.equal(waterPlan({ ...water, reminders: false }, at(11)).due, null);
  assert.match(waterCopy(waterPlan(water, at(12, 30)), water, at(12, 30)).no, /rim|bebo/);
});

test("ordem das páginas: Início sempre primeiro e páginas novas na posição padrão", () => {
  const pages = ["home", "media", "sports", "tasks", "water"] as const;
  assert.deepEqual(orderPages(pages, []), ["home", "media", "sports", "tasks", "water"]);
  assert.deepEqual(orderPages(pages, ["water", "tasks", "home"]), ["home", "water", "tasks", "media", "sports"]);
});

test("placar de jogo acompanhado: mapa no CS2, gol no futebol e mascote neutro sem time seguido", () => {
  const side = (id: string, name: string, score: string) => ({ id, name, short: name.slice(0, 4).toUpperCase(), logo: null, score });
  const game = (league: string, home: string, away: string) => ({ id: `${league}|1`, league, leagueName: "X", start: 0, state: "in" as const, detail: "", clock: null, home: side("1", "MOUZ", home), away: side("2", "FURIA", away), followed: true });
  const before = { games: [game("hltv:cs2", "0", "0")], observedAt: 0, errors: [] };
  const after = { games: [game("hltv:cs2", "1", "0")], observedAt: 1, errors: [] };
  const [alert] = sportsActivities(before, after, 1, []);
  assert.equal(alert.label, "Mapa para MOUZ");
  assert.equal(alert.mood, "wide", "jogo só acompanhado não deixa o mascote preocupado");
  assert.equal(sportsActivities(before, after, 1, ["hltv:cs2|2"])[0].mood, "worried", "mapa do adversário do time seguido");
  assert.equal(sportsActivities(before, after, 1, ["hltv:cs2|1"])[0].mood, "happy");
  assert.equal(scoreLabel("espn:soccer/bra.1", "Bahia"), "Gol de Bahia");
});

test("troca de mapa no CS2: placar final vai para o mapa encerrado e o novo começa em 0–0", () => {
  const side = (id: string, name: string, score: string) => ({ id, name, short: name, logo: null, score });
  const game = { id: "hltv:cs2|9", league: "hltv:cs2", leagueName: "PGL", start: 0, state: "in" as const, detail: "MD3", clock: null, home: side("1", "MOUZ", "0"), away: side("2", "FURIA", "1"), followed: true,
    maps: [{ name: null, result: "done" as const, homeRounds: null, awayRounds: null }, { name: null, result: "live" as const, homeRounds: 6, awayRounds: 13 }, { name: null, result: "pending" as const, homeRounds: null, awayRounds: null }] };
  const live = { gameId: "hltv:cs2|9", map: "Dust2", round: 19, ctTeam: "FURIA", tTeam: "MOUZ", ctScore: 13, tScore: 6, phase: "", history: [] };
  assert.equal(csFinished(live), true);
  assert.deepEqual(csMapScore(game, live), { home: 0, away: 0, map: "Mapa 2" });
  assert.deepEqual(csFinishedMap(game, 0), { name: "Dust2", home: 6, away: 13 });
  assert.equal(csFinished({ ...live, ctScore: 12, tScore: 10 }), false);
  assert.equal(csFinished({ ...live, ctScore: 16, tScore: 14 }), true, "fim da prorrogação");
});

test("água: depois de beber, o humor zera (recusas antigas não contam)", () => {
  const at = (hour: number, minute = 0) => new Date(2026, 9, 30, hour, minute).getTime();
  const water: Water = { goalMl: 2000, cupMl: 250, reminders: true, intervalMin: 60, log: [{ at: at(11), ml: 250 }], snoozeUntil: 0, bottleMl: 500, bottleLeftMl: 100, startMin: 540, endMin: 1020, days: [1, 2, 3, 4, 5], snooze: true, skips: [at(10, 10), at(10, 30)] };
  const plan = waterPlan(water, at(11, 59));
  assert.equal(plan.due, "refill");
  assert.equal(plan.level, 0, "recusas antes do gole das 11h não deixam o próximo lembrete bravo");
  assert.equal(waterPlan({ ...water, skips: [...water.skips!, at(11, 58)], snoozeUntil: 0 }, at(11, 59)).level, 1);
});

test("CS2 com a lista de mapas da página: mapa novo que nem começou fica 0–0, não herda o anterior", () => {
  const side = (id: string, name: string, score: string) => ({ id, name, short: name, logo: null, score });
  const game = { id: "hltv:cs2|7", league: "hltv:cs2", leagueName: "PGL", start: 0, state: "in" as const, detail: "MD3", clock: null, home: side("1", "MOUZ", "1"), away: side("2", "FURIA", "1"), followed: true,
    maps: [{ name: null, result: "done" as const, homeRounds: null, awayRounds: null }, { name: null, result: "done" as const, homeRounds: null, awayRounds: null }, { name: null, result: "live" as const, homeRounds: 13, awayRounds: 9 }] };
  const maps = [{ name: "Dust2", home: 6, away: 13, winner: "away" as const }, { name: "Mirage", home: 13, away: 9, winner: "home" as const }, { name: "Cache", home: null, away: null, winner: "" as const }];
  const live = { gameId: "hltv:cs2|7", map: "Mirage", round: 22, ctTeam: "MOUZ", tTeam: "FURIA", ctScore: 13, tScore: 9, phase: "", history: [], maps };
  assert.deepEqual(csMapScore(game, live), { home: 0, away: 0, map: "Cache" });
  assert.deepEqual(csMapScore(game, { ...live, map: "Cache", ctScore: 3, tScore: 1 }), { home: 3, away: 1, map: "Cache" });
});
