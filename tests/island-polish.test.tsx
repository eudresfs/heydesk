import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { useIsland } from "../src/hooks/useIsland";
import type { HitShape, ShellBridge, ShellEvent } from "../src/lib/shellBridge";
import { containsNotchPoint, notchGeometry, notchPath } from "../src/modules/motion/geometry";

const dom = new Window({ url: "http://localhost" });
let now = 0, sequence = 0;
const frames = new Map<number, FrameRequestCallback>();
Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; },
  cancelAnimationFrame: (id: number) => frames.delete(id),
});
Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => now } });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.navigator });
Object.defineProperty(dom, "innerWidth", { configurable: true, writable: true, value: 680 });
let root: Root | undefined, host: HTMLDivElement, island: ReturnType<typeof useIsland>;

// A janela nativa tem tamanho fixo: o bridge só recebe a forma do hit-test e
// entrega o ponteiro por `shell:pointer`. Nenhum teste aqui depende de resize.
function fakeBridge() {
  const events = new Map<string, (payload?: unknown) => void>();
  const shapes: HitShape[] = [];
  const bridge = {
    desktop: true,
    setHitShape: async (shape: HitShape) => { shapes.push(shape); },
    hide: async () => {},
    listen: async (event: ShellEvent, listener: (payload?: unknown) => void) => { events.set(event, listener); return () => events.delete(event); },
  } as unknown as ShellBridge;
  const pointer = async (inside: boolean) => { await act(async () => events.get("shell:pointer")!(inside)); await flush(); };
  const lastShape = () => shapes.at(-1) && `${shapes.at(-1)!.width}x${shapes.at(-1)!.height}`;
  return { bridge, events, shapes, pointer, lastShape };
}
function Harness({ bridge, reduced = false }: { bridge: ShellBridge; reduced?: boolean }) {
  island = useIsland(bridge, false, reduced);
  return <main data-phase={island.phase}>
    <svg ref={island.surfaceRef}><path data-notch-path="" /></svg>
    {island.viewportExpanded && <section ref={island.panelRef}><button>Conteúdo</button></section>}
    <button ref={island.compactRef}>Abrir</button>
  </main>;
}
async function flush() { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); }
async function mount(bridge: ShellBridge, reduced = false) {
  now = 0; frames.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<Harness bridge={bridge} reduced={reduced} />); }); await flush();
}
async function tick(ms = 1000 / 60) {
  await act(async () => { now += ms; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(now)); }); await flush();
}
async function settle() { for (let i = 0; i < 120 && frames.size; i++) await tick(); await flush(); assert.equal(frames.size, 0); }
async function wait(ms: number) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); await flush(); }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; frames.clear(); document.body.replaceChildren(); });

test("hit-test exclui margens transparentes e recortes, incluindo asas", () => {
  const shape = notchGeometry(340, 580, 200);
  assert.deepEqual([shape.radius, shape.wing], [42, 22]);
  assert.equal(containsNotchPoint(shape, 340, 120), true);
  assert.equal(containsNotchPoint(shape, 20, 100), false, "margem transparente lateral");
  assert.equal(containsNotchPoint(shape, 340, 215), false, "abaixo do corpo");
  assert.equal(containsNotchPoint(shape, 51, 199), false, "fora do canto arredondado");
  assert.equal(containsNotchPoint(shape, 49, 1), true, "asa");
  assert.equal(containsNotchPoint(shape, 29, 21), false, "recorte côncavo da asa");
  assert.equal(containsNotchPoint(shape, 340, 202, 3), true, "histerese de saída");
  assert.ok(notchPath(shape).startsWith("M28 0H652"));
});

test("forma inicial publicada é o compacto, centrada na janela fixa", async () => {
  const { bridge, lastShape } = fakeBridge(); await mount(bridge);
  assert.equal(lastShape(), "220x32");
  assert.match(host.querySelector("path")!.getAttribute("d")!, /^M220 0H460/);
});

test("hover entra em pré-hover e só abre depois de 250ms dentro da forma", async () => {
  const { bridge, pointer, lastShape } = fakeBridge(); await mount(bridge);
  await pointer(true);
  assert.equal(island.phase, "peek"); assert.equal(lastShape(), "232x36");
  await wait(150); assert.equal(island.phase, "peek");
  await wait(350); assert.equal(island.phase, "open");
  assert.equal(lastShape(), "580x200", "hit-test cobre o painel antes da mola chegar");
});

test("sair antes de 250ms cancela a abertura e volta ao compacto", async () => {
  const { bridge, pointer, lastShape } = fakeBridge(); await mount(bridge);
  await pointer(true); await tick(); await tick();
  await pointer(false); await settle(); await wait(300);
  assert.equal(island.phase, "compact"); assert.equal(lastShape(), "220x32");
});

test("recolher mantém a forma maior até o repouso e só então publica o compacto", async () => {
  const { bridge, pointer, lastShape } = fakeBridge(); await mount(bridge);
  await act(async () => island.change(true, false)); await settle();
  await pointer(true); await pointer(false);
  assert.equal(island.phase, "compact"); assert.equal(lastShape(), "580x200");
  await settle();
  assert.equal(lastShape(), "220x32"); assert.equal(island.viewportExpanded, false);
});

test("voltar à forma durante o fechamento reverte direto, conservando a mola", async () => {
  const { bridge, pointer } = fakeBridge(); await mount(bridge);
  await act(async () => island.change(true, false)); await settle();
  await pointer(true); await pointer(false);
  for (let i = 0; i < 5; i++) await tick();
  const width = Number(/H(\d+(?:\.\d+)?)/.exec(host.querySelector("path")!.getAttribute("d")!)![1]);
  await pointer(true);
  assert.equal(island.phase, "open", "sem novo pré-hover de 250ms");
  await tick();
  const after = Number(/H(\d+(?:\.\d+)?)/.exec(host.querySelector("path")!.getAttribute("d")!)![1]);
  assert.ok(Math.abs(after - width) < 40, "continua da largura atual, sem salto");
  await settle();
});

test("recolhimento explícito sob o cursor não reabre até o ponteiro sair", async () => {
  const { bridge, pointer } = fakeBridge(); await mount(bridge);
  await pointer(true); await wait(300); assert.equal(island.phase, "open");
  await act(async () => island.change(false, false)); await settle();
  await wait(300);
  assert.equal(island.phase, "compact");
  await pointer(false); await pointer(true); await wait(300);
  assert.equal(island.phase, "open", "nova entrada abre normalmente");
  await settle();
});

test("ocultação ignora o ponteiro e a bandeja reabre com foco", async () => {
  const { bridge, events, pointer } = fakeBridge(); await mount(bridge);
  await act(async () => events.get("shell:hidden")!()); await flush();
  assert.equal(island.hidden, true);
  await pointer(true); await wait(300);
  assert.equal(island.phase, "compact"); assert.equal(island.hovered, false);
  await act(async () => events.get("shell:open")!()); await settle();
  assert.equal(island.hidden, false); assert.equal(island.phase, "open");
  assert.equal(island.focusTarget?.expanded, true);
});

test("movimento reduzido troca de estado sem quadros de mola", async () => {
  const { bridge, pointer } = fakeBridge(); await mount(bridge, true);
  await pointer(true); await wait(300);
  assert.equal(island.phase, "open"); assert.equal(frames.size, 0);
  assert.ok(host.querySelector("section"));
});

test("conteúdo só aceita interação quando revelado e é bloqueado no início do fecho", async () => {
  const { bridge } = fakeBridge(); await mount(bridge);
  await act(async () => island.change(true, false)); await flush();
  const panel = host.querySelector("section")!;
  assert.ok(panel, "painel já montado antes de avançar a mola");
  assert.equal(panel.inert, true, "controles transparentes não devem aceitar foco ou clique");
  await tick(); await tick(); await tick();
  assert.equal(panel.inert, true);
  await settle();
  assert.equal(panel.inert, false, "conteúdo revelado fica interativo");
  await act(async () => island.change(false, false));
  assert.equal(panel.inert, true, "fechamento bloqueia controles antes do próximo frame");
  await settle();
});

test("abertura pela bandeja com foco interno só recolhe quando o foco sai", async () => {
  const { bridge, events } = fakeBridge(); await mount(bridge);
  await act(async () => events.get("shell:open")!()); await settle();
  const button = host.querySelector("section button") as HTMLButtonElement;
  await act(async () => button.focus());
  await act(async () => island.resumeAutoCollapse()); await wait(5); await settle();
  assert.equal(island.expanded, true);
  const outside = document.createElement("button"); document.body.append(outside);
  await act(async () => outside.focus());
  await act(async () => island.resumeAutoCollapse()); await wait(5); await settle();
  assert.equal(island.expanded, false, "saída explícita do foco ainda pode recolher");
});
