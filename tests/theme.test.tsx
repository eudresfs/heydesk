import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { Mascot, type MascotExpression } from "../src/modules/context/Mascot";
import { combineThemes, emptyTheme, hudStyle, moodImage, themeWater } from "../src/modules/theme/useTheme";
import { isMajorGame, scoreLabel } from "../src/modules/sports/useSports";
import { playSound } from "../src/modules/sound/sounds";
import { noteLine } from "../src/modules/update/useUpdate";

test("aviso de atualização usa a primeira linha útil das notas, curta", () => {
  assert.equal(noteLine("## Novidades\n\n- Temas do mascote"), "Novidades");
  assert.equal(noteLine("\n\n- Temas do mascote e HUD"), "Temas do mascote e HUD");
  assert.equal(noteLine(null), "");
  const long = noteLine("x".repeat(200));
  assert.equal(long.length, 108);
  assert.ok(long.endsWith("…"));
});

const dom = new Window({ url: "http://localhost" });
Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); });

async function render(node: React.ReactNode) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

test("mascote com imagem do tema troca os olhos pela imagem e mantém os atributos de animação", async () => {
  const el = await render(<Mascot expression="happy" image="data:image/png;base64,AAAA" active={false} reducedMotion bounce={false} color="#ff0000" />);
  const mascot = el.querySelector(".mascot")!;
  const image = mascot.querySelector("svg image");
  assert.equal(image?.getAttribute("href"), "data:image/png;base64,AAAA");
  assert.equal(mascot.querySelectorAll("path, ellipse").length, 0);
  assert.equal(mascot.getAttribute("data-expression"), "happy");
  assert.equal(mascot.getAttribute("data-bounce"), "false");
  assert.ok(mascot.hasAttribute("data-image"));
  assert.equal((mascot as HTMLElement).style.color, "", "a cor dos olhos não se aplica a bitmap");
});

test("sem imagem continua desenhando os olhos", async () => {
  const el = await render(<Mascot expression="normal" active={false} reducedMotion />);
  assert.equal(el.querySelectorAll(".mascot svg ellipse").length, 2);
  assert.equal(el.querySelector(".mascot svg image"), null);
});

test("cada expressão cai no humor que o tema tiver", () => {
  const four = { calm: "c", happy: "h", angry: "a", sleepy: "s" };
  const expect: Record<MascotExpression, string> = { normal: "c", wide: "c", happy: "h", sleep: "s", worried: "c", sleepy: "s", yawn: "s", wink: "h", laugh: "h", angry: "a" };
  for (const [expression, image] of Object.entries(expect)) assert.equal(moodImage(expression as MascotExpression, four), image, expression);
  const full = { ...four, wide: "w", sleep: "z", worried: "p", wink: "k", laugh: "l" };
  assert.equal(moodImage("wide", full), "w");
  assert.equal(moodImage("sleep", full), "z");
  assert.equal(moodImage("worried", full), "p");
  assert.equal(moodImage("wink", full), "k");
  assert.equal(moodImage("laugh", full), "l");
  assert.equal(moodImage("happy", null), undefined, "tema sem imagens: olhos");
});

test("textos do tema substituem o título da água e o alerta de mapa", () => {
  const copy = { title: "Bebe água", sub: "x", yes: "y", no: "n" };
  assert.equal(themeWater(copy, 1, ["A", "B", "C"]).title, "B");
  assert.equal(themeWater(copy, 3, ["A", "B", "C"]).title, "C", "nível 3 usa a última linha");
  assert.equal(themeWater(copy, 0, undefined), copy);
  assert.equal(scoreLabel("hltv:cs2", "FURIA", "Rodada ganha por {team}!"), "Rodada ganha por FURIA!");
  assert.equal(scoreLabel("hltv:cs2", "FURIA"), "Mapa para FURIA");
  assert.equal(scoreLabel("espn:soccer/bra.1", "Flamengo", "{team}"), "Gol de Flamengo", "texto de mapa não vale para futebol");
});

test("HUD do tema vira variáveis CSS do notch; sem HUD nada muda", () => {
  assert.deepEqual(hudStyle(undefined), {});
  const vars = hudStyle({ surface: "#0a1428", text: "#f0e6d2", accent: "#c89b3c", border: "#785a28", frame: "data:image/png;base64,AA", frameSlice: 24 });
  assert.equal(vars["--island-fill"], "#0a1428");
  assert.match(vars["--surface-2"], /color-mix\(in srgb, #0a1428/);
  assert.equal(vars["--text"], "#f0e6d2");
  assert.match(vars["--text-muted"], /#f0e6d2 72%/);
  assert.match(vars["--art-bg"], /color-mix\(in srgb, #0a1428 76%, #c89b3c\)/);
  assert.match(vars["--art-ring"], /#c89b3c 35%/);
  assert.equal(vars["--primary"], "#c89b3c");
  assert.equal(vars["--island-stroke"], "#785a28");
  assert.equal(vars["--hud-frame"], 'url("data:image/png;base64,AA")');
  assert.equal(vars["--hud-slice"], "24");
  assert.equal(hudStyle({ muted: "#999999", frameSlice: 16 })["--text-muted"], "#999999");
  assert.equal(hudStyle({ frameSlice: 16 })["--hud-frame"], undefined);
  const neutral = hudStyle({ surface: "#1c1c1e", accent: "#0a84ff", card: "#2c2c2e", frameSlice: 16 });
  assert.equal(neutral["--card-a"], "#2c2c2e", "cor de cartão tira o tom de destaque");
  assert.doesNotMatch(neutral["--art-bg"], /#0a84ff/);
  assert.doesNotMatch(neutral["--art-ring"], /#0a84ff/);
});

test("som do tema toca o arquivo no lugar da melodia", () => {
  const made: string[] = [];
  const node = () => ({ connect: (next: unknown) => next ?? node(), disconnect() {}, gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} } });
  class FakeContext {
    state = "running"; currentTime = 0; destination = {};
    createGain() { made.push("gain"); return node(); }
    createBufferSource() { made.push("buffer"); return { ...node(), buffer: null, start() { made.push("start"); }, onended: null }; }
    createOscillator() { made.push("osc"); return { ...node(), type: "", frequency: { value: 0 }, start() {}, stop() {} }; }
  }
  Object.assign(dom, { AudioContext: FakeContext });
  Object.assign(globalThis, { AudioContext: FakeContext });
  playSound("goal", "soft", 50, {} as AudioBuffer);
  assert.deepEqual(made.filter(kind => kind !== "gain"), ["buffer", "start"]);
  made.length = 0;
  playSound("goal", "soft", 50);
  assert.ok(made.includes("osc") && !made.includes("buffer"));
});

test("mascote de um pacote e visual do notch de outro", () => {
  const geleu = { ...emptyTheme, id: "geleu", images: { calm: "data:image/svg+xml,a" }, pixelated: true, glow: ["#1", "#2", "#3"] as [string, string, string], copy: { water: ["glub"] } };
  const reliquia = { ...emptyTheme, id: "reliquia", glow: ["#a", "#b", "#c"] as [string, string, string], hud: { surface: "#16120d", frameSlice: 16, textureOpacity: .5, bevel: true, shimmer: true, panelOpacity: .9, lines: [] } };
  const both = combineThemes(geleu, reliquia);
  assert.equal(both.images?.calm, "data:image/svg+xml,a");
  assert.deepEqual(both.copy, { water: ["glub"] });
  assert.equal(both.hud?.surface, "#16120d");
  assert.deepEqual(both.glow, ["#a", "#b", "#c"], "o brilho segue o notch quando há HUD");
  const plain = combineThemes(geleu, emptyTheme);
  assert.equal(plain.hud, undefined);
  assert.deepEqual(plain.glow, ["#1", "#2", "#3"]);
});

test("Major de CS2 pelo nome do evento", () => {
  assert.ok(isMajorGame({ league: "hltv:cs2", leagueName: "IEM Cologne Major 2026 · Playoffs" }));
  assert.ok(isMajorGame({ league: "hltv:cs2", leagueName: "PGL Major Copenhagen" }));
  assert.ok(!isMajorGame({ league: "hltv:cs2", leagueName: "Stake Ranked · Final" }));
  assert.ok(!isMajorGame({ league: "hltv:cs2", leagueName: "Majorca Cup" }), "palavra inteira");
  assert.ok(!isMajorGame({ league: "soccer/bra.1", leagueName: "Major League" }), "só CS2");
});
