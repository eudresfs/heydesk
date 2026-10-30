import { strict as assert } from "node:assert";
import { afterEach, beforeEach, mock, test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { Mascot } from "../src/modules/context/Mascot";
import { advanceMascotPresence, initialMascotMachine, useMascotPresence, type MascotOptions, type MascotPresence, type NotchInteractionSnapshot } from "../src/modules/context/useMascotPresence";

const options: MascotOptions = { enabled: true, hovered: false, playing: false, reducedMotion: false };
const sample = (idleMs: number | null, x = 0, y = 0): NotchInteractionSnapshot => ({ idleMs, look: { x, y } });

test("repouso começa em quinze segundos e cede a reprodução e aproximação", () => {
  assert.equal(advanceMascotPresence(initialMascotMachine, sample(10999), options, 0).phase, "context");
  // Bocejo nos segundos antes do cochilo; música e hover não bocejam.
  assert.equal(advanceMascotPresence(initialMascotMachine, sample(14999), options, 0).phase, "drowsy");
  assert.equal(advanceMascotPresence(initialMascotMachine, sample(12000), { ...options, playing: true }, 0).phase, "context");
  const rest = advanceMascotPresence(initialMascotMachine, sample(15000), options, 0);
  assert.equal(rest.phase, "rest");
  assert.equal(advanceMascotPresence(rest, sample(25000), { ...options, playing: true }, 500).phase, "context");
  assert.equal(advanceMascotPresence(rest, sample(25000), { ...options, hovered: true }, 500).phase, "attention");
});

test("pré-hover sobre o compacto em contexto não troca relógio pelos olhos", () => {
  const hovered = advanceMascotPresence(initialMascotMachine, sample(200), { ...options, hovered: true }, 0);
  assert.equal(hovered.phase, "context");
  assert.equal(advanceMascotPresence(hovered, sample(400), { ...options, hovered: true }, 200).phase, "context");
});

test("retorno amostra direção uma vez, limita alcance e encerra saudação sem acompanhar cursor", () => {
  const rest = advanceMascotPresence(initialMascotMachine, sample(16000), options, 0);
  const greeting = advanceMascotPresence(rest, sample(20, 99, -99), options, 100);
  assert.equal(greeting.phase, "greeting");
  assert.deepEqual(greeting.look, { x: 3.5, y: -1 });
  const next = advanceMascotPresence(greeting, sample(40, -3, 2), options, 300);
  assert.deepEqual(next.look, greeting.look);
  assert.equal(next.greetingUntil, 900);
  const finished = advanceMascotPresence(next, sample(500), options, 900);
  assert.equal(finished.phase, "context"); assert.deepEqual(finished.look, { x: 0, y: 0 });
});

test("ausência de sensor não prova retorno; pausa e movimento reduzido não deixam deslocamento", () => {
  const rest = advanceMascotPresence(initialMascotMachine, sample(16000), options, 0);
  assert.notEqual(advanceMascotPresence(rest, sample(null), options, 50).phase, "greeting");
  const reduced = advanceMascotPresence(rest, sample(10, 3, 2), { ...options, reducedMotion: true }, 100);
  assert.equal(reduced.phase, "greeting"); assert.deepEqual(reduced.look, { x: 0, y: 0 });
  assert.deepEqual(advanceMascotPresence(reduced, sample(20), { ...options, enabled: false }, 200), initialMascotMachine);
});

class Clock {
  time = 0; sequence = 0;
  jobs = new Map<number, { at: number; run: () => void }>();
  schedule = (run: () => void, milliseconds = 0) => { const id = ++this.sequence; this.jobs.set(id, { at: this.time + milliseconds, run }); return id; };
  cancel = (id?: number) => { if (id != null) this.jobs.delete(id); };
  advance(milliseconds: number) {
    this.time += milliseconds;
    for (const [id, job] of [...this.jobs]) if (job.at <= this.time) { this.jobs.delete(id); job.run(); }
  }
}
const dom = new Window({ url: "http://localhost" });
Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement;
let clock: Clock;
let hidden = false;
beforeEach(() => {
  clock = new Clock(); hidden = false;
  mock.method(Date, "now", () => clock.time);
  dom.setTimeout = clock.schedule as typeof dom.setTimeout;
  dom.clearTimeout = clock.cancel as typeof dom.clearTimeout;
  Object.defineProperty(dom.document, "hidden", { configurable: true, get: () => hidden });
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); mock.restoreAll(); });

function harness(read?: () => Promise<NotchInteractionSnapshot>) {
  let value: MascotPresence = { phase: "context", look: { x: 0, y: 0 } }; let renders = 0;
  const bridge = { desktop: Boolean(read), getNotchInteraction: read };
  function Probe({ current }: { current: MascotOptions }) {
    value = useMascotPresence(bridge, current); renders++;
    return <Mascot expression={value.phase === "rest" ? "sleep" : "normal"} active={current.enabled} reducedMotion={current.reducedMotion} look={value.look} />;
  }
  return {
    get value() { return value; }, get renders() { return renders; },
    async render(current = options) {
      if (!root) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
      await act(async () => root!.render(<Probe current={current} />));
    },
    async tick(ms: number) { await act(async () => { clock.advance(ms); await Promise.resolve(); }); },
  };
}

test("poll repetido idêntico não rerenderiza e abrir/ocultar para coleta e animação", async () => {
  let reads = 0;
  const view = harness(async () => { reads++; return sample(16000); });
  await view.render(); assert.equal(view.value.phase, "rest");
  const renders = view.renders;
  await view.tick(1500); assert.equal(reads, 2); assert.equal(view.renders, renders);
  await view.render({ ...options, enabled: false });
  assert.equal(clock.jobs.size, 0); assert.equal(host.querySelector(".mascot")?.getAttribute("data-animated"), "false");
  await view.tick(5000); assert.equal(reads, 2);
});

test("falha da leitura não inventa entrada; evento local acorda e captura só uma direção", async () => {
  let reads = 0;
  const view = harness(async () => { if (++reads === 1) return sample(16000); throw new Error("indisponível"); });
  await view.render(); assert.equal(view.value.phase, "rest");
  await view.tick(500); assert.equal(view.value.phase, "rest");
  await act(async () => window.dispatchEvent(new dom.MouseEvent("pointermove", { clientX: dom.innerWidth / 2 + 120, clientY: 40 })));
  assert.equal(view.value.phase, "greeting"); assert.deepEqual(view.value.look, { x: 2, y: .5 });
  await act(async () => window.dispatchEvent(new dom.MouseEvent("pointermove", { clientX: 0, clientY: 0 })));
  assert.deepEqual(view.value.look, { x: 2, y: .5 });
  await view.tick(800); assert.equal(view.value.phase, "context");
});

test("resposta pendente ao desativar não atualiza nem sobrepõe uma nova coleta", async () => {
  let resolve!: (value: NotchInteractionSnapshot) => void;
  let reads = 0;
  const view = harness(() => ++reads === 1 ? new Promise(done => { resolve = done; }) : Promise.resolve(sample(20)));
  await view.render(); assert.equal(reads, 1);
  await view.render({ ...options, enabled: false });
  await view.render(); assert.equal(reads, 1, "nova ativação aguarda leitura anterior");
  await act(async () => resolve(sample(16000)));
  assert.equal(reads, 2); assert.equal(view.value.phase, "context");
});

test("reativar depois de longo tempo aberto não fabrica repouso nem saudação antes do sensor", async () => {
  let resolve!: (value: NotchInteractionSnapshot) => void;
  let reads = 0;
  const view = harness(() => ++reads === 1 ? Promise.resolve(sample(10)) : new Promise(done => { resolve = done; }));
  await view.render();
  await view.render({ ...options, enabled: false });
  await view.tick(20000);
  await view.render();
  assert.equal(view.value.phase, "context", "tempo oculto/expandido não equivale a inatividade observada");
  assert.equal(reads, 2);
  await act(async () => resolve(sample(0, 3, 1)));
  assert.equal(view.value.phase, "context", "primeira leitura da nova época não é um retorno de repouso falso");
});

test("documento oculto interrompe timers e reduced motion mantém expressão estática", async () => {
  const view = harness(async () => sample(17000));
  await view.render({ ...options, reducedMotion: true });
  assert.equal(view.value.phase, "rest"); assert.equal(host.querySelector(".mascot")?.getAttribute("data-animated"), "false");
  assert.equal(host.querySelector(".mascot")?.getAttribute("data-expression"), "sleep");
  await act(async () => { hidden = true; document.dispatchEvent(new dom.Event("visibilitychange")); });
  assert.equal(clock.jobs.size, 0); assert.equal(view.value.phase, "context");
  assert.equal(host.querySelector(".mascot")?.getAttribute("data-animated"), "false");
});

test("formato e cor dos olhos personalizam o mascote e animações podem ser desligadas", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = (props: Partial<React.ComponentProps<typeof Mascot>>) => renderToStaticMarkup(<Mascot expression="normal" active reducedMotion={false} {...props} />);
  assert.match(html({}), /<ellipse class="mascot-eye"/);
  assert.match(html({ shape: "round" }), /<circle class="mascot-eye"/);
  assert.equal(html({ shape: "pixel" }).match(/<rect class="mascot-eye"/g)?.length, 2);
  assert.match(html({ shape: "heart" }), /<path class="mascot-eye"/);
  // Expressões não neutras continuam em traço, qualquer que seja o formato.
  assert.doesNotMatch(html({ shape: "heart", expression: "happy" }), /<path class="mascot-eye"/);
  const custom = html({ color: "#FFE08A", blink: false, bounce: false, pace: "lively" });
  assert.match(custom, /color:#FFE08A/);
  assert.match(custom, /data-blink="false"/);
  assert.match(custom, /data-bounce="false"/);
  assert.match(custom, /data-pace="lively"/);
});
