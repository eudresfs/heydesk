import { strict as assert } from "node:assert";
import { test } from "node:test";
import { advanceActivities, detectActivities, enqueueActivities, idleActivity, type ActivityInput } from "../src/modules/activity/activity";
import { isTickle } from "../src/modules/context/useMascotTouch";
import { dueReminders, parseEventText, waterDue } from "../src/modules/context/useNotes";
import { kickoffAlert, sportsActivities, type SportGame } from "../src/modules/sports/useSports";
import type { DesktopSnapshot } from "../src/modules/context/types";

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

test("água fica pendente após o intervalo, só das 8h às 22h, e respeita o adiamento", () => {
  const at = (hour: number, minute = 0) => new Date(2026, 9, 30, hour, minute).getTime();
  const water = { goalMl: 2000, cupMl: 250, reminders: true, intervalMin: 60, log: [{ at: at(9), ml: 250 }], snoozeUntil: 0 };
  assert.equal(waterDue(water, at(9, 50)), false);
  assert.equal(waterDue(water, at(10, 1)), true);
  assert.equal(waterDue({ ...water, snoozeUntil: at(10, 30) }, at(10, 10)), false, "adiado");
  assert.equal(waterDue({ ...water, snoozeUntil: at(10, 30) }, at(10, 31)), true);
  assert.equal(waterDue(water, at(23)), false, "fora do horário");
  assert.equal(waterDue({ ...water, reminders: false }, at(11)), false);
  assert.equal(waterDue({ ...water, log: [] }, at(8, 50)), false, "sem gole: conta das 8h");
  assert.equal(waterDue({ ...water, log: [] }, at(9, 1)), true, "reiniciar o app não adia o lembrete");
});
