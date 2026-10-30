import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../src/App";
import { defaultWater } from "../src/modules/context/useNotes";
import { createShellBridge, type ShellBridge, type ShellEvent, type AppSettings } from "../src/lib/shellBridge";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { readFileSync } from "node:fs";
import type { ClaudeLimit, ClaudeQuotaSnapshot, DesktopSnapshot } from "../src/modules/context/types";
import type { CodexUsageSnapshot } from "../src/modules/codex-usage/types";
import { WheelPaging } from "../src/modules/navigation/wheelPaging";
import { claudePace, lyricIndex, mediaPosition, rate } from "../src/modules/context/ContextPages";
import { askPrompt } from "../src/modules/context/useAsk";

const dom = new Window({ url: "http://localhost" });
Object.assign(globalThis, {
  window: dom, document: dom.document,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16),
  cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.navigator });
const defaults: AppSettings = { schemaVersion: 3, appearance: { opacity: 94, accentColor: "#EB0028" }, motion: { reducedMotion: "system" }, modules: { codexUsage: true, claudeUsage: true, systemInfo: true, media: true, weather: false }, weatherLocation: null };
// Dados sintéticos, sem conteúdo de sessões reais.
function usageSnapshot(overrides: Partial<CodexUsageSnapshot> = {}): CodexUsageSnapshot {
  return { enabled: true, status: "empty", lastUpdated: null, scanning: false, scannedFiles: 0, pendingFiles: 0, legacyOnlyFiles: 0, invalidRecords: 0, conflicts: 0, today: null, days: [], error: null, ...overrides };
}
function quotaSnapshot() {
  return { enabled: true, providerId: "codex", providerName: "Codex", state: "unavailable" as const, source: "local", observedAt: null, windows: [] };
}
function claudeLimit(overrides: Partial<ClaudeLimit> = {}): ClaudeLimit {
  return { kind: "session", group: "session", label: "Sessão", percent: 30, severity: "normal", resetsAt: Date.now() + 2.5 * 3_600_000, windowMinutes: 300, active: false, ...overrides };
}
function claudeSnapshot(overrides: Partial<ClaudeQuotaSnapshot> = {}): ClaudeQuotaSnapshot {
  return { enabled: true, state: "unavailable", plan: null, observedAt: null, limits: [], reason: null, ...overrides };
}
function desktopSnapshot(overrides: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  return { observedAt: null, cpuPercent: null, memory: null, battery: null, media: null, weather: null, ...overrides };
}
let root: Root | undefined;
let host: HTMLDivElement;
let pointerListener: ((payload: unknown) => void) | undefined;
function fakeBridge() {
  const listeners = new Map<ShellEvent, (payload?: unknown) => void>();
  const calls: string[] = [];
  const bridge: ShellBridge = {
    desktop: true,
    loadSettings: async () => { calls.push("load"); return structuredClone(defaults); },
    saveSettings: async settings => { calls.push("save"); return settings; },
    // Lembrete de água desligado por padrão: o cartão dele não pode depender do horário em que o teste roda.
    loadNotes: async () => ({ note: "", todos: [], water: { ...defaultWater, reminders: false } }),
    setHitShape: async shape => { calls.push(`shape:${shape.width}x${shape.height}`); },
    hide: async () => { calls.push("hide"); },
    listen: async (event, callback) => {
      calls.push(event); listeners.set(event, callback);
      if (event === "shell:pointer") pointerListener = callback;
      return () => { listeners.delete(event); if (pointerListener === callback) pointerListener = undefined; };
    },
    getCodexLimits: async () => quotaSnapshot(),
    getClaudeLimits: async () => claudeSnapshot(),
    getDesktopStatus: async () => desktopSnapshot(),
    getNotchInteraction: async () => ({ idleMs: 0, look: { x: 0, y: 0 } }),
    getCodexUsage: async () => usageSnapshot(),
    refreshCodexUsage: async () => usageSnapshot(),
  };
  const result = { bridge, listeners, calls };
  return result;
}
async function mount(bridge: ShellBridge) {
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<App bridge={bridge} />); });
}
async function click(label: string, modality: "mouse" | "keyboard" = "mouse") {
  if (label === "Ocultar") label = "Ocultar ilha";
  const find = () => [...host.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === label || button.textContent === label);
  if (!find() && ["Aparência", "Módulos", "Ocultar ilha"].includes(label)) await click("Preferências", modality);
  const target = find();
  assert.ok(target, `Botão ausente: ${label}`);
  if (modality === "mouse") await hover(true);
  await act(async () => {
    target.focus();
    if (modality === "keyboard") {
      target.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      if (label !== "Abrir Heydesk") target.click();
    } else {
      target.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true }));
      target.dispatchEvent(new dom.MouseEvent("click", { detail: 1, bubbles: true }));
    }
  });
  if (label === "Abrir Heydesk") await advance(1000);
  if (label === "Recolher") await advance(1450);
}
async function open() { await click("Abrir Heydesk"); await click("Aparência"); await hover(true); }
afterEach(async () => {
  if (root) { await act(async () => root!.unmount()); root = undefined; }
  pointerListener = undefined;
  document.body.replaceChildren();
});

// Campo controlado no happy-dom: chama o onChange do React direto.
function reactChange(input: Element, value: string) {
  const props = (input as unknown as Record<string, { onChange(event: unknown): void }>)[Object.keys(input).find(key => key.startsWith("__reactProps$"))!];
  props.onChange({ target: { value } });
}

test("expande por clique e recolhe por Escape com foco no botão compacto", async () => {
  const { bridge, calls } = fakeBridge(); await mount(bridge);
  await open(); assert.ok(host.querySelector("h1"));
  await act(async () => { host.querySelector("main")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(Boolean(host.querySelector("h1")), false);
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Abrir Heydesk");
  assert.ok(calls.includes("shape:640x280"));
});

test("registra eventos antes de ajustar a janela e responde à bandeja", async () => {
  const { bridge, calls, listeners } = fakeBridge(); await mount(bridge);
  await act(async () => { listeners.get("shell:open")!(); }); await advance(55);
  assert.ok(host.querySelector("h1"));
  await act(async () => { host.querySelector("main")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(Boolean(host.querySelector("h1")), false);
  await act(async () => { listeners.get("shell:open")!(); }); await advance(55);
  await click("Ocultar"); assert.ok(calls.includes("hide"));
  await act(async () => { listeners.get("shell:collapse")!(); }); await advance(1450);
  assert.equal(Boolean(host.querySelector("h1")), false);
});

test("erro de leitura bloqueia gravação até tentar novamente", async () => {
  const { bridge, calls } = fakeBridge();
  bridge.loadSettings = async () => { throw new Error("arquivo inválido"); };
  await mount(bridge); await open();
  assert.match(host.textContent!, /Falha ao carregar/);
  assert.equal(host.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled ?? true, true);
  assert.equal(calls.includes("save"), false);
  bridge.loadSettings = async () => structuredClone(defaults);
  await click("Tentar novamente");
  assert.equal(Boolean(host.querySelector("[role=alert]")), false);
  assert.equal(host.querySelector<HTMLInputElement>("input[type=color]")?.matches(":disabled"), false);
});

test("salva explicitamente e erro posterior remove sucesso preservando rascunho", async () => {
  const { bridge } = fakeBridge(); await mount(bridge); await open();
  const select = host.querySelector<HTMLInputElement>("#opacity")!;
  await act(async () => { reactChange(select, "80"); });
  await click("Salvar alterações"); assert.match(host.textContent!, /Configurações salvas/);
  await act(async () => { reactChange(select, "90"); });
  bridge.saveSettings = async () => { throw new Error("disco indisponível"); };
  await click("Salvar alterações");
  assert.match(host.textContent!, /Falha ao salvar/);
  assert.doesNotMatch(host.textContent!, /Configurações salvas/);
  assert.equal(select.value, "90");
});

test("browser permite abrir sem simular persistência e desabilita os campos", async () => {
  const { bridge, calls } = fakeBridge(); bridge.desktop = false;
  await mount(bridge); await open();
  assert.match(host.textContent!, /aplicativo desktop/);
  assert.equal(host.querySelector<HTMLInputElement>("input[type=color]")?.matches(":disabled"), true);
  assert.equal(host.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled, true);
  assert.deepEqual(calls, []);
});

test("limpa listeners normais e os que terminam de registrar após unmount", async () => {
  const { bridge, listeners } = fakeBridge(); await mount(bridge);
  await act(async () => { root!.unmount(); }); root = undefined;
  assert.equal(listeners.size, 0);
  let resolve!: (cleanup: () => void) => void; let cleanups = 0;
  bridge.listen = () => new Promise(done => { resolve = done; });
  await mount(bridge);
  await act(async () => { root!.unmount(); }); root = undefined;
  await act(async () => { resolve(() => { cleanups++; }); });
  assert.equal(cleanups, 1);
});

test("conserva uma edição feita enquanto a gravação está em andamento", async () => {
  const { bridge } = fakeBridge();
  let resolveSave!: (settings: AppSettings) => void;
  bridge.saveSettings = () => new Promise(resolve => { resolveSave = resolve; });
  await mount(bridge); await open();
  const select = host.querySelector<HTMLInputElement>("#opacity")!;
  await act(async () => { reactChange(select, "80"); });
  await click("Salvar alterações");
  await act(async () => { reactChange(select, "90"); });
  await act(async () => { resolveSave({ ...defaults, motion: { reducedMotion: "on" } }); });
  assert.equal(select.value, "90");
  assert.doesNotMatch(host.textContent!, /Configurações salvas/);
  assert.equal(host.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled, false);
});

test("a última transição vence cliques e eventos concorrentes", async () => {
  const { bridge, listeners } = fakeBridge(); await mount(bridge);
  await act(async () => { listeners.get("shell:open")!(); }); await advance(55);
  await act(async () => { listeners.get("shell:collapse")!(); }); await advance(1450);
  assert.equal(Boolean(host.querySelector("h1")), false);
});

test("acompanha movimento reduzido do sistema e respeita override", async () => {
  const original = dom.matchMedia.bind(dom);
  let change: (() => void) | undefined;
  let matches = false; let removed = false;
  Object.defineProperty(dom, "matchMedia", { configurable: true, value: () => ({
    get matches() { return matches; },
    addEventListener: (_event: string, callback: () => void) => { change = callback; },
    removeEventListener: () => { removed = true; },
  }) });
  try {
    const { bridge } = fakeBridge(); await mount(bridge); await open();
    assert.equal(host.firstElementChild?.getAttribute("data-reduced-motion"), "false");
    await act(async () => { matches = true; change!(); });
    assert.equal(host.firstElementChild?.getAttribute("data-reduced-motion"), "true");
    const full = [...host.querySelectorAll<HTMLButtonElement>(".segmented [role=radio]")].find(button => button.textContent === "Completo")!;
    await act(async () => { full.click(); });
    assert.equal(full.getAttribute("aria-checked"), "true");
    assert.equal(host.firstElementChild?.getAttribute("data-reduced-motion"), "false");
    // Cor de destaque vira --primary; o vermelho legado vale como neutro.
    const main = host.firstElementChild as HTMLElement;
    assert.equal(main.style.getPropertyValue("--primary"), "#E5E5E5");
    const color = host.querySelector<HTMLInputElement>("#accent-color")!;
    await act(async () => { (color as unknown as Record<string, { onChange(event: unknown): void }>)[Object.keys(color).find(key => key.startsWith("__reactProps$"))!].onChange({ target: { value: "#00ff40" } }); });
    assert.equal(main.style.getPropertyValue("--primary"), "#00FF40");
    assert.equal(main.style.getPropertyValue("--on-primary"), "#171717");
    await act(async () => { root!.unmount(); }); root = undefined;
    assert.equal(removed, true);
  } finally { Object.defineProperty(dom, "matchMedia", { configurable: true, value: original }); }
});

test("aguarda ambos listeners antes de ajustar a janela mesmo com clique antecipado", async () => {
  const { bridge, calls } = fakeBridge();
  let releaseSecond!: (cleanup: () => void) => void;
  bridge.listen = async event => {
    calls.push(event);
    if (event === "shell:collapse") return new Promise(resolve => { releaseSecond = resolve; });
    return () => {};
  };
  await mount(bridge); await click("Abrir Heydesk");
  await act(async () => { releaseSecond(() => {}); }); await advance(1000);
  assert.ok(host.querySelector("h1"));
  assert.equal(document.activeElement?.tagName, "H1");
});

// Desktop: o hit-test é nativo e chega por `shell:pointer`. Preview: DOM.
async function hover(inside: boolean) {
  await act(async () => {
    if (pointerListener) { pointerListener(inside); return; }
    const clientX = inside ? window.innerWidth / 2 : 0, clientY = inside ? 15 : 500;
    host.querySelector("main")!.dispatchEvent(new dom.MouseEvent(inside ? "mousemove" : "mouseout", { bubbles: true, relatedTarget: document.body, clientX, clientY }));
  });
}
async function advance(milliseconds: number) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, milliseconds)); });
}
// A mola usa RAF via setTimeout; sob carga o relógio de parede não mede o fim dela.
async function closed(limit = 5000) {
  for (let waited = 0; waited < limit && host.querySelector("h1"); waited += 50) await advance(50);
  return !host.querySelector("h1");
}

test("hover abre sem clique nem roubar foco e retorno cancela recolhimento", async () => {
  const { bridge, calls } = fakeBridge(); await mount(bridge);
  const external = document.createElement("button"); document.body.append(external); external.focus();
  await hover(true); await advance(350);
  assert.match(host.textContent!, /Boa (tarde|noite|dia)|Bom dia/);
  assert.equal(document.activeElement, external);
  assert.ok(calls.includes("shape:640x280"));
  await hover(false); await advance(100); await hover(true); await advance(300);
  assert.ok(host.querySelector("h1"));
  await hover(false); await advance(1450);
  assert.equal(Boolean(host.querySelector("h1")), false);
  assert.equal(document.activeElement, external);
});

test("saída rápida cancela abertura e unmount limpa timer de hover", async () => {
  const { bridge, calls } = fakeBridge(); await mount(bridge);
  await hover(true); await hover(false); await advance(350);
  assert.equal(Boolean(host.querySelector("h1")), false);
  await hover(true);
  await act(async () => root!.unmount()); root = undefined;
  await advance(350);
  assert.equal(calls.includes("shape:580x200"), false);
});

test("Escape recolhe sob o ponteiro sem reabrir até uma nova entrada", async () => {
  const { bridge } = fakeBridge(); await mount(bridge);
  await hover(true); await advance(350);
  await act(async () => host.querySelector("main")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await hover(true); await advance(350);
  assert.equal(Boolean(host.querySelector("h1")), false);
  await hover(false); await hover(true); await advance(350);
  assert.ok(host.querySelector("h1"));
});

test("campo em edição, rascunho e gravação pendente impedem recolhimento automático", async () => {
  const { bridge } = fakeBridge(); await mount(bridge); await open();
  const select = host.querySelector<HTMLInputElement>("#opacity")!;
  await act(async () => select.focus());
  await hover(false); await advance(1450);
  assert.ok(host.querySelector("h1"));
  await act(async () => {
    reactChange(select, "80"); select.blur();
  });
  await hover(true); await hover(false); await advance(1450);
  assert.ok(host.querySelector("h1"));
  let finish!: (settings: AppSettings) => void;
  bridge.saveSettings = () => new Promise(resolve => { finish = resolve; });
  await click("Salvar alterações");
  await hover(true); await hover(false); await advance(1450);
  assert.ok(host.querySelector("h1"));
  await act(async () => finish({ ...defaults, motion: { reducedMotion: "on" } }));
  await advance(1450);
  assert.equal(Boolean(host.querySelector("h1")), false);
});

test("consulta pendente de listeners preserva saída antes de terminar conexão", async () => {
  const { bridge } = fakeBridge();
  let finish!: (cleanup: () => void) => void;
  bridge.listen = async event => event === "shell:collapse" ? new Promise(resolve => { finish = resolve; }) : () => {};
  await mount(bridge); await hover(true); await advance(350); await hover(false);
  await act(async () => finish(() => {}));
  await advance(1450);
  assert.equal(Boolean(host.querySelector("h1")), false);
});

test("o bridge real expõe os dois comandos de consumo sem argumentos de caminho", async () => {
  const commands: string[] = [];
  mockIPC((command, args) => {
    commands.push(command); assert.equal(args === undefined || Object.keys(args).length === 0, true);
    return usageSnapshot();
  });
  try {
    const bridge = createShellBridge();
    assert.equal((await bridge.getCodexUsage()).status, "empty");
    assert.equal((await bridge.refreshCodexUsage()).status, "empty");
    assert.deepEqual(commands, ["get_codex_usage", "refresh_codex_usage"]);
  } finally { clearMocks(); }
});

test("evento passivo de recolhimento não pede foco ao botão compacto", async () => {
  const { bridge, listeners } = fakeBridge(); await mount(bridge); await open();
  await act(async () => { listeners.get("shell:collapse")!(); });
  assert.equal(await closed(), true);
  assert.notEqual(document.activeElement?.getAttribute("aria-label"), "Abrir Heydesk");
});

test("o bridge real do SDK recebe os canais publicados pelo backend", async () => {
  const previousTauri = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  const changes: boolean[] = [];
  Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
  mockIPC((command, args) => {
    if (command === "load_settings") return structuredClone(defaults);
    if (command === "get_codex_usage" || command === "refresh_codex_usage") return usageSnapshot();
    if (command === "get_codex_limits") return quotaSnapshot();
    if (command === "get_desktop_status") return desktopSnapshot();
    if (command === "get_notch_interaction") return { idleMs: 0, look: { x: 0, y: 0 } };
    if (command === "set_hit_shape") { changes.push((args?.shape as { width: number }).width >= 580); return; }
    throw new Error(`IPC inesperado no teste: ${command}`);
  }, { shouldMockEvents: true });
  try {
    await mount(createShellBridge());
    await act(async () => { await emit("shell:open"); }); await advance(55);
    assert.equal(Boolean(host.querySelector("h1")), true);
    assert.equal(changes.at(-1), true);
    await act(async () => { await emit("shell:collapse"); }); await advance(1450);
    assert.equal(Boolean(host.querySelector("h1")), false);
    assert.equal(changes.at(-1), false);
  } finally {
    if (root) { await act(async () => root!.unmount()); root = undefined; }
    clearMocks();
    if (previousTauri) Object.defineProperty(globalThis, "isTauri", previousTauri);
    else Reflect.deleteProperty(globalThis, "isTauri");
  }
});

test("cota do Claude destaca o limite mais perto de acabar, com ritmo e linhas, sem tokens ou tabs", async () => {
  const { bridge } = fakeBridge();
  bridge.getCodexUsage = async () => { throw new Error("Ledger não pertence à UI contextual"); };
  bridge.getClaudeLimits = async () => claudeSnapshot({ state: "available", plan: "Max 5x", observedAt: Date.now(), limits: [
    claudeLimit(), claudeLimit({ kind: "weekly_scoped", group: "weekly", label: "Semana · Fable", percent: 93, severity: "critical", windowMinutes: 10080, resetsAt: Date.now() + 2 * 86_400_000 }) ] });
  await mount(bridge);
  assert.match(host.querySelector(".compact-button")!.textContent!, /\d\d:\d\d/);
  assert.doesNotMatch(host.textContent!, /tokens/i);
  await click("Abrir Heydesk"); await click("Claude");
  assert.equal(host.querySelector(".statement-number")?.textContent, "93%");
  assert.equal(host.querySelector(".statement-number")?.getAttribute("data-tone"), "warn");
  assert.match(host.textContent!, /Claude Max 5x/); assert.match(host.textContent!, /Semana · Fable/);
  assert.match(host.querySelector(".statement-row")!.textContent!, /Sessão.*30%/);
  assert.ok(host.querySelector(".pace-bar b"), "marcador de ritmo");
  assert.equal(host.querySelectorAll(".page-dock .tick").length, 12);
  assert.equal(host.querySelector('[role="tablist"], .panel-tabs'), null);
  assert.doesNotMatch(host.textContent!, /tokens/i);
});

test("cota antiga do Claude fica cinza, diz quando foi lida e não mostra ritmo", async () => {
  const { bridge } = fakeBridge();
  bridge.getClaudeLimits = async () => claudeSnapshot({ state: "stale", observedAt: Date.parse("2026-01-01T12:00:00"), reason: "Sem conexão com a Anthropic.", limits: [claudeLimit({ percent: 39 })] });
  await mount(bridge); await click("Abrir Heydesk"); await click("Claude");
  assert.equal(host.querySelector(".statement-number")!.textContent, "39%");
  assert.equal(host.querySelector(".statement-number")!.getAttribute("data-tone"), "stale");
  assert.match(host.textContent!, /lido 12:00 · Sem conexão/);
  assert.equal(host.querySelector(".pace-bar b"), null);
});

test("ritmo projeta sobra ou esgotamento só com tempo decorrido suficiente", () => {
  const now = Date.parse("2026-10-29T12:00:00Z"), hour = 3_600_000;
  const half = claudePace(claudeLimit({ percent: 25, resetsAt: now + 2.5 * hour }), now)!;
  assert.equal(Math.round(half.expected), 50); assert.equal(Math.round(half.leftAtReset!), 50); assert.equal(half.exhaustsAt, null);
  const fast = claudePace(claudeLimit({ percent: 80, resetsAt: now + 2.5 * hour }), now)!;
  assert.equal(fast.leftAtReset, 0); assert.equal(Math.round((fast.exhaustsAt! - now) / 60_000), 38);
  const early = claudePace(claudeLimit({ percent: 10, resetsAt: now + 4.9 * hour }), now)!;
  assert.equal(early.leftAtReset, null);
  assert.equal(claudePace(claudeLimit({ resetsAt: null }), now), null);
});

test("módulos aguardam salvar schema 3 e descartam resposta desativada", async () => {
  const { bridge } = fakeBridge(); let reads = 0; let saved: AppSettings | undefined;
  bridge.loadSettings = async () => ({ ...defaults, modules: { ...defaults.modules, claudeUsage: false } });
  let finish!: (snapshot: ClaudeQuotaSnapshot) => void;
  bridge.getClaudeLimits = () => { reads++; return new Promise(resolve => { finish = resolve; }); };
  bridge.saveSettings = async settings => { saved = settings; return settings; };
  await mount(bridge); await click("Abrir Heydesk"); await click("Módulos");
  await act(async () => host.querySelector<HTMLInputElement>("#module-claudeUsage")!.click());
  assert.equal(reads, 0); await click("Salvar alterações"); assert.equal(reads, 1);
  assert.equal(saved?.schemaVersion, 3);
  await act(async () => host.querySelector<HTMLInputElement>("#module-claudeUsage")!.click());
  await click("Salvar alterações"); await click("Claude");
  await act(async () => finish(claudeSnapshot({ state: "available", limits: [claudeLimit()] })));
  assert.match(host.textContent!, /Uso do Claude desativado/); assert.equal(reads, 1);
});

test("página Sistema não inventa zero para primeira amostra ou bateria ausente", async () => {
  const { bridge } = fakeBridge(); await mount(bridge); await click("Abrir Heydesk"); await click("Sistema");
  assert.match(host.querySelector(".system-rows")!.textContent!, /CPUaguardando/);
  assert.match(host.textContent!, /Sem bateria/);
  assert.doesNotMatch(host.textContent!, /0%/);
  assert.doesNotMatch(host.querySelector(".compact-button")!.textContent!, /0%/);
});

test("contexto compacto usa clima e mídia reais apenas após ativação salva, sem bateria fixa", async () => {
  const { bridge } = fakeBridge(); let playing = true;
  bridge.loadSettings = async () => ({ ...defaults, modules: { ...defaults.modules, weather: true }, weatherLocation: { city: "Natal/RN", latitude: -5.795, longitude: -35.20944 } });
  bridge.getDesktopStatus = async () => desktopSnapshot({ battery: { percent: 72, charging: true, plugged: true, hasBattery: true }, media: { state: playing ? "playing" : "paused", title: "Faixa de teste", artist: "Artista de teste" }, weather: { state: "ready", city: "Natal/RN", temperatureC: 28, weatherCode: 1, isDay: true, observedAt: new Date().toISOString(), source: "Open-Meteo" } });
  await mount(bridge);
  // Tocando, as barras de música ocupam o lugar do clima; a bateria fica.
  assert.ok(host.querySelector('[aria-label="Música tocando"]'));
  assert.doesNotMatch(host.querySelector(".compact-button")!.textContent!, /72%/, "bateria não fica no compacto");
  await click("Abrir Heydesk");
  assert.match(host.textContent!, /Faixa de teste/); assert.match(host.textContent!, /Artista de teste/);
  playing = false;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  assert.match(host.querySelector(".compact-button")!.textContent!, /28°/);
});

test("navegação vertical guarda um impulso e preserva teclas de campos", async () => {
  const { bridge } = fakeBridge(); await mount(bridge); await click("Abrir Heydesk");
  assert.equal(host.querySelector("h1")?.textContent, "Início");
  async function key(value: string, target: Element = host.querySelector("main")!) { await act(async () => { target.dispatchEvent(new dom.KeyboardEvent("keydown", { key: value, bubbles: true })); }); }
  await key("ArrowDown"); assert.equal(host.querySelector("h1")?.textContent, "Player");
  await key("ArrowDown"); assert.equal(host.querySelector("h1")?.textContent, "Esportes");
  await key("PageUp"); assert.equal(host.querySelector("h1")?.textContent, "Player");
  await key("PageDown"); assert.equal(host.querySelector("h1")?.textContent, "Esportes");
  const wheel = () => host.querySelector("main")!.dispatchEvent(new dom.WheelEvent("wheel", { deltaY: 20, bubbles: true }));
  await act(async () => { wheel(); wheel(); wheel(); });
  assert.equal(host.querySelector("h1")?.textContent, "Esportes", "60px de touchpad ainda não completa um gesto");
  await act(async () => { wheel(); wheel(); });
  assert.equal(host.querySelector("h1")?.textContent, "Claude");
  await click("Aparência"); await key("ArrowDown", host.querySelector<HTMLInputElement>("#opacity")!);
  assert.equal(host.querySelector("h1")?.textContent, "Aparência");
});

test("reentrada durante fechamento cancela redução obsoleta", async () => {
  const { bridge, calls } = fakeBridge(); await mount(bridge);
  await click("Abrir Heydesk"); await advance(1450); await hover(true); await hover(false); await advance(60);
  assert.equal(host.querySelector("main")!.classList.contains("expanded"), false);
  const closedBefore = calls.filter(value => value === "shape:220x32").length;
  await hover(true); await advance(70);
  assert.equal(host.querySelector("main")!.classList.contains("expanded"), true);
  assert.equal(calls.filter(value => value === "shape:220x32").length, closedBefore);
});

test("movimento reduzido aplica abertura e fechamento sem espera", async () => {
  const { bridge, calls } = fakeBridge();
  bridge.loadSettings = async () => ({ ...defaults, motion: { reducedMotion: "on" } });
  await mount(bridge);
  assert.equal(host.querySelector(".compact-button .mascot")?.getAttribute("data-animated"), "false");
  await act(async () => host.querySelector<HTMLButtonElement>(".compact-button")!.click());
  assert.equal(host.querySelector("main")!.classList.contains("expanded"), true);
  await act(async () => { host.querySelector("main")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(calls.at(-1), "shape:220x32");
  assert.equal(host.querySelector(".panel"), null);
});

test("CSS fixa páginas sem scroll e preserva raios da superfície sem escalar texto", () => {
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  // Rolagens permitidas: o popover do teleprompter (painel baixo) e a conversa do Ask expandida.
  const scrollRules = css.split(/\r?\n/).filter(line => /overflow(?:-y)?:\s*(auto|scroll)/.test(line));
  assert.deepEqual(scrollRules.map(line => line.split("{")[0].trim()), [".prompter-pop", ".ask-page[data-tall] .ask-log", ".settings-body", ".pip-menu"]); // a janela de configurações rola; o notch não
  assert.doesNotMatch(css, /transition:\s*all/);
  assert.doesNotMatch(css, /scale\(\.7142857143|scaleY\(\.15/);
  assert.match(css, /width: 220px; height: 32px/);
  assert.match(css, /width: 580px; height: 200px/);
  assert.match(css, /\.island-surface path/);
  assert.match(css, /\.page-viewport[^}]*overflow: hidden/);
  assert.doesNotMatch(css, /transition:\s*(width|height)/);
  assert.match(css, /width: min\(680px, 100vw\); height: 430px/);
  assert.match(css, /mascot\[data-animated=true\]/);
});

test("Início abre primeiro e a página Claude explica a espera pela cota", async () => {
  const { bridge } = fakeBridge(); await mount(bridge); await click("Abrir Heydesk");
  assert.equal(host.querySelector("h1")?.textContent, "Início");
  assert.equal(host.querySelector(".panel")?.getAttribute("aria-hidden"), "false");
  await click("Claude"); assert.match(host.textContent!, /Consultando a cota do Claude/);
});

test("picker de cor protege expansão até foco voltar à página", async () => {
  const { bridge } = fakeBridge(); await mount(bridge); await open();
  await act(async () => host.querySelector<HTMLInputElement>("#accent-color")!.click());
  await hover(false); await advance(1450);
  assert.ok(host.querySelector("h1"));
  await act(async () => host.querySelector<HTMLInputElement>("#opacity")!.focus());
  await act(async () => host.querySelector<HTMLInputElement>("#opacity")!.blur());
  assert.equal(await closed(), true);
});

test("poll desktop não sobrepõe consulta pendente e mantém último dado identificado", async () => {
  const { bridge } = fakeBridge(); let reads = 0;
  let finish!: (value: DesktopSnapshot) => void;
  bridge.getDesktopStatus = () => { reads++; return new Promise(resolve => { finish = resolve; }); };
  await mount(bridge); await click("Abrir Heydesk"); await click("Sistema");
  await advance(2100); assert.equal(reads, 1);
  await act(async () => finish(desktopSnapshot({ cpuPercent: 25, observedAt: new Date().toISOString() })));
  assert.match(host.textContent!, /25%/);
  bridge.getDesktopStatus = async () => { throw new Error("temporariamente indisponível"); };
  // O bridge é estável em produção; este rerender troca o getter só para simular falha.
  await act(async () => root!.render(<App bridge={bridge} />));
  assert.match(host.textContent!, /25%/);
  assert.ok(host.querySelector(".system-rows[data-stale]"));
});

test("hover normal aguarda 250ms e saída solicita fechamento sem atraso artificial", async () => {
  // Relógio controlado: carga da máquina não pode transformar a espera de 200ms
  // do teste em mais de250ms e fazê-lo acusar uma abertura antecipada inexistente.
  const originalTimeout = dom.setTimeout, originalClear = dom.clearTimeout;
  let time = 0, sequence = 0;
  const jobs = new Map<number, { at: number; run: () => void }>();
  dom.setTimeout = ((handler: (...args: unknown[]) => void, milliseconds = 0, ...args: unknown[]) => {
    const id = ++sequence; jobs.set(id, { at: time + milliseconds, run: () => handler(...args) }); return id;
  }) as typeof dom.setTimeout;
  dom.clearTimeout = ((id?: number) => { if (id != null) jobs.delete(id); }) as typeof dom.clearTimeout;
  async function tick(milliseconds: number) {
    await act(async () => {
      time += milliseconds;
      for (const [id, job] of [...jobs]) if (job.at <= time) { jobs.delete(id); job.run(); }
      for (let index = 0; index < 8; index++) await Promise.resolve();
    });
  }
  try {
    const { bridge, calls } = fakeBridge();
    bridge.loadSettings = async () => ({ ...defaults, motion: { reducedMotion: "on" } });
    await mount(bridge); await hover(true); await tick(249);
    assert.equal(calls.includes("shape:580x200"), false);
    assert.equal(host.querySelector("main")!.classList.contains("peeking"), true);
    await tick(1); assert.equal(host.querySelector("main")!.classList.contains("expanded"), true);
    await hover(false); assert.equal(calls.at(-1), "shape:220x32");
  } finally {
    if (root) { await act(async () => root!.unmount()); root = undefined; }
    jobs.clear(); dom.setTimeout = originalTimeout; dom.clearTimeout = originalClear;
  }
});

test("mascote é suspenso aberto, oculto e com movimento reduzido", async t => {
  // À noite (22h–6h) o mascote dorme, sem olhos abertos: fixa a tarde para o teste não depender do relógio.
  const getHours = Date.prototype.getHours; Date.prototype.getHours = function () { return 14; };
  t.after(() => { Date.prototype.getHours = getHours; });
  const { bridge } = fakeBridge(); await mount(bridge);
  const compactMascot = () => host.querySelector(".compact-button .mascot");
  assert.equal(host.querySelector("main")?.getAttribute("data-mascot-phase"), "context");
  assert.equal(compactMascot()?.getAttribute("data-animated"), "true", "olhos sempre presentes no compacto");
  assert.equal(host.querySelectorAll(".compact-button .mascot-eye").length, 2);
  await click("Abrir Heydesk");
  assert.equal(compactMascot()?.getAttribute("data-animated"), "false");
  assert.equal(host.querySelector(".panel-face .mascot")?.getAttribute("data-animated"), "true");
  await act(async () => host.querySelector("main")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(compactMascot()?.getAttribute("data-animated"), "true");
  await click("Abrir Heydesk"); await click("Ocultar");
  assert.equal(compactMascot()?.getAttribute("data-animated"), "false");
});

test("paginação é circular e Escape preserva o campo editável", async () => {
  const { bridge } = fakeBridge(); await mount(bridge); await click("Abrir Heydesk");
  await act(async () => host.querySelector("main")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
  assert.equal(host.querySelector("h1")?.textContent, "Perguntar");
  await act(async () => host.querySelector("main")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  assert.equal(host.querySelector("h1")?.textContent, "Início");
  await click("Aparência");
  const event = new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => host.querySelector<HTMLInputElement>("#opacity")!.dispatchEvent(event));
  assert.equal(event.defaultPrevented, false);
  assert.equal(host.querySelector("main")!.classList.contains("expanded"), true);
});

test("bridge SDK publica a forma do hit-test nativo", async () => {
  const args: unknown[] = []; mockIPC((command, payload) => { assert.equal(command, "set_hit_shape"); args.push(payload); });
  try { await createShellBridge().setHitShape({ width: 580, height: 160, radius: 42, wing: 22 }); }
  finally { clearMocks(); }
  assert.deepEqual(args, [{ shape: { width: 580, height: 160, radius: 42, wing: 22 } }]);
});

test("abertura por Enter e foco interno não recolhem sem mouseenter", async () => {
  const { bridge } = fakeBridge(); await mount(bridge);
  const button = host.querySelector<HTMLButtonElement>(".compact-button")!;
  await act(async () => { button.focus(); button.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  await advance(20);
  assert.equal(host.querySelector("main")!.classList.contains("expanded"), true);
  assert.equal(document.activeElement?.tagName, "H1");
  await act(async () => host.querySelector<HTMLButtonElement>('.page-dock button[aria-label="Claude"]')!.focus());
  await advance(20);
  assert.equal(host.querySelector("main")!.classList.contains("expanded"), true);
  const external = document.createElement("button"); document.body.append(external);
  await act(async () => external.focus()); await advance(20);
  assert.equal(host.querySelector("main")!.classList.contains("expanded"), false);
});

test("movimento reduzido ativado durante a abertura conclui sem mola", async () => {
  const original = dom.matchMedia.bind(dom); let matches = false; let update!: () => void;
  Object.defineProperty(dom, "matchMedia", { configurable: true, value: () => ({ get matches() { return matches; }, addEventListener: (_name: string, callback: () => void) => { update = callback; }, removeEventListener: () => {} }) });
  try {
    const { bridge, calls } = fakeBridge();
    await mount(bridge);
    await act(async () => host.querySelector<HTMLButtonElement>(".compact-button")!.click());
    await act(async () => { matches = true; update(); });
    assert.doesNotMatch(host.querySelector<SVGPathElement>("[data-notch-path]")!.getAttribute("d")!, /NaN|Infinity/);
    assert.equal(host.querySelector("main")!.classList.contains("expanded"), true);
    await advance(30);
    assert.equal(calls.at(-1), "shape:640x280");
  } finally {
    if (root) { await act(async () => root!.unmount()); root = undefined; }
    Object.defineProperty(dom, "matchMedia", { configurable: true, value: original });
  }
});

test("evento de recolhimento após ocultar não reativa o mascote", async () => {
  const { bridge, listeners } = fakeBridge();
  bridge.loadSettings = async () => ({ ...defaults, motion: { reducedMotion: "on" } });
  await mount(bridge); await click("Abrir Heydesk"); await click("Ocultar");
  await act(async () => listeners.get("shell:collapse")!());
  assert.equal(host.querySelector("main")!.classList.contains("expanded"), false);
  assert.equal(host.querySelector(".compact-button .mascot")?.getAttribute("data-animated"), "false");
});

test("salvar por teclado mantém expansão e foco após gravar sem mouseenter", async () => {
  const { bridge } = fakeBridge(); let finish!: (value: AppSettings) => void;
  bridge.loadSettings = async () => ({ ...defaults, motion: { reducedMotion: "on" } });
  bridge.saveSettings = () => new Promise(resolve => { finish = resolve; });
  await mount(bridge);
  await act(async () => { const compact = host.querySelector<HTMLButtonElement>(".compact-button")!; compact.focus(); compact.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  await click("Aparência", "keyboard");
  const select = host.querySelector<HTMLInputElement>("#opacity")!;
  await act(async () => { select.focus(); reactChange(select, "90"); });
  const save = host.querySelector<HTMLButtonElement>('[aria-label="Salvar alterações"]')!;
  await act(async () => { save.focus(); save.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); save.click(); });
  assert.equal(save.getAttribute("aria-disabled"), "true");
  await act(async () => finish({ ...defaults, motion: { reducedMotion: "off" } }));
  await advance(30);
  assert.equal(host.querySelector("main")!.classList.contains("expanded"), true);
  assert.equal(document.activeElement, save);
  assert.match(host.textContent!, /Configurações salvas/);
});

test("salvar por mouse e sair durante gravação recolhe quando termina", async () => {
  const { bridge } = fakeBridge(); let finish!: (value: AppSettings) => void;
  bridge.loadSettings = async () => ({ ...defaults, motion: { reducedMotion: "on" } });
  bridge.saveSettings = () => new Promise(resolve => { finish = resolve; });
  await mount(bridge); await open();
  const select = host.querySelector<HTMLInputElement>("#opacity")!;
  await act(async () => { reactChange(select, "90"); });
  const save = host.querySelector<HTMLButtonElement>('[aria-label="Salvar alterações"]')!;
  await act(async () => { save.focus(); save.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true })); save.click(); });
  await hover(false); assert.equal(host.querySelector("main")!.classList.contains("expanded"), true);
  await act(async () => finish({ ...defaults, motion: { reducedMotion: "off" } }));
  await advance(30); assert.equal(host.querySelector("main")!.classList.contains("expanded"), false);
});

test("Escape por teclado recolhe sem esperar a mola e devolve o foco", async () => {
  const { bridge, calls } = fakeBridge(); await mount(bridge); await click("Abrir Heydesk");
  await act(async () => { host.querySelector("main")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(host.querySelector(".panel"), null);
  assert.equal(calls.at(-1), "shape:220x32");
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Abrir Heydesk");
});

test("preferências ficam fora do ciclo contextual e Escape fecha apenas seu menu", async () => {
  const { bridge } = fakeBridge(); await mount(bridge); await click("Abrir Heydesk", "keyboard");
  assert.deepEqual([...host.querySelectorAll('.page-ticks button, .page-dock button')].map(button => button.getAttribute('aria-label')), ["Fixar painel aberto", "Preferências", "Início", "Player", "Esportes", "Claude", "Sistema", "Tarefas", "Agenda", "Prateleira", "Teleprompter", "Água", "Nota", "Perguntar"]);
  assert.equal(host.querySelector('[role=menu]'), null);
  await click("Preferências", "keyboard");
  assert.ok(host.querySelector('[role=menu]'));
  assert.equal(document.activeElement?.textContent, "Aparência");
  await act(async () => document.activeElement!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(host.querySelector('[role=menu]'), null);
  assert.equal(host.querySelector('main')?.classList.contains('expanded'), true);
  assert.equal(document.activeElement?.getAttribute('aria-label'), "Preferências");
  await click("Aparência", "keyboard");
  await act(async () => host.querySelector("main")!.dispatchEvent(new dom.WheelEvent("wheel", { deltaY: 120, bubbles: true })));
  assert.equal(host.querySelector('h1')?.textContent, 'Aparência', 'roda não abandona a configuração em edição');
});

test("roda normaliza pixels, linhas e páginas sem trocar por ruído de touchpad", () => {
  const wheel = new WheelPaging();
  for (let index = 0; index < 8; index++) assert.equal(wheel.accept(10, 0, index * 5), 0);
  assert.equal(wheel.accept(10, 0, 45), 1);
  assert.equal(wheel.accept(120, 0, 60), 0, 'mesmo impulso fica travado');
  assert.equal(wheel.accept(-3, 1, 80), -1, 'gesto deliberado contrário não fica preso no anterior');
  assert.equal(wheel.accept(-3, 1, 100), 0);
  assert.equal(wheel.accept(1, 2, 300), 1);
  wheel.reset(); assert.equal(wheel.accept(.01, 0, 301), 0);
  assert.equal(wheel.accept(Number.NaN, 0, 302), 0);
});

test("mascote entra em repouso por sinal nativo sem esconder semanticamente os dados", async () => {
  const { bridge } = fakeBridge();
  bridge.getNotchInteraction = async () => ({ idleMs: 15000, look: { x: 0, y: 0 } });
  await mount(bridge); await advance(20);
  assert.equal(host.querySelector('main')?.getAttribute('data-mascot-phase'), 'rest');
  assert.equal(host.querySelector('.compact-button .mascot')?.getAttribute('data-expression'), 'sleep');
  assert.ok(host.querySelector('time')?.textContent?.includes(':'));
  await click('Abrir Heydesk', 'keyboard');
  assert.equal(host.querySelector('.compact-button .mascot')?.getAttribute('data-animated'), 'false');
  assert.equal(host.querySelector('h1')?.textContent, 'Início');
});

test("ocultar interrompe polling do frontend e reabrir retoma com leitura nova", async () => {
  const { bridge, listeners } = fakeBridge(); let reads = 0;
  bridge.getDesktopStatus = async () => { reads++; return desktopSnapshot(); };
  await mount(bridge); await click("Abrir Heydesk");
  await click("Ocultar"); const whenHidden = reads;
  await advance(2100);
  assert.equal(reads, whenHidden, "consulta de UI não deve seguir com janela oculta");
  await act(async () => listeners.get("shell:open")!());
  await advance(55);
  assert.equal(reads, whenHidden + 1, "reabrir inicia uma leitura atual, sem esperar intervalo antigo");
});

test("posição da faixa avança pelo relógio só enquanto toca e respeita a duração", () => {
  const base = { title: "Faixa", artist: "Artista", positionMs: 60_000, durationMs: 200_000, positionAtMs: 1_000_000 };
  assert.equal(mediaPosition({ ...base, state: "playing" }, 1_010_000), 70_000);
  assert.equal(mediaPosition({ ...base, state: "paused" }, 1_010_000), 60_000);
  assert.equal(mediaPosition({ ...base, state: "playing" }, 9_000_000), 200_000);
  assert.equal(mediaPosition({ ...base, state: "playing", durationMs: null }, 1_010_000), null);
});

test("player mostra progresso e envia comandos ao app de mídia do Windows", async () => {
  const { bridge } = fakeBridge(); const actions: string[] = [];
  bridge.mediaControl = async action => { actions.push(action); };
  bridge.getDesktopStatus = async () => desktopSnapshot({ media: { state: "playing", title: "Faixa de teste", artist: "Artista de teste", source: "Spotify",
    positionMs: 102_000, durationMs: 238_000, positionAtMs: Date.now(), canPrevious: true, canNext: true, canToggle: true } });
  await mount(bridge); await click("Abrir Heydesk"); await click("Player"); await advance(30);
  assert.match(host.textContent!, /Faixa de teste/); assert.match(host.textContent!, /Artista de teste · Spotify/);
  assert.match(host.textContent!, /1:4[2-9]/, "posição extrapolada a partir de 1:42"); assert.match(host.textContent!, /3:58/);
  assert.equal(host.querySelector('progress[aria-label="Progresso da faixa"]')?.getAttribute("max"), "238000");
  assert.ok(host.querySelector('.compact-button [aria-label="Música tocando"]'));
  await click("Próxima faixa"); await click("Pausar"); await click("Faixa anterior");
  assert.deepEqual(actions, ["next", "toggle", "previous"]);
});

test("comando de mídia recusado aparece no Player em vez de sumir", async () => {
  const { bridge } = fakeBridge();
  bridge.mediaControl = async () => { throw "O app de mídia não aceitou o comando."; };
  bridge.getDesktopStatus = async () => desktopSnapshot({ media: { state: "paused", title: "Faixa", artist: "Artista", canToggle: true } });
  await mount(bridge); await click("Abrir Heydesk"); await click("Player"); await advance(700);
  await act(async () => host.querySelector<HTMLButtonElement>('.player-page [aria-label="Tocar"]')!.click()); await advance(10);
  assert.match(host.querySelector('[role="status"]')?.textContent ?? "", /não aceitou/);
});

test("letra sincronizada mostra a linha do instante atual entre a anterior e a próxima", async () => {
  const lines = [{ atMs: 1000, text: "um" }, { atMs: 5000, text: "dois" }, { atMs: 9000, text: "três" }];
  assert.equal(lyricIndex(lines, 0), -1); assert.equal(lyricIndex(lines, 4800), 1); assert.equal(lyricIndex(lines, 60_000), 2);
  const { bridge } = fakeBridge(); const asked: string[] = [];
  bridge.getLyrics = async (title, artist) => { asked.push(`${title}/${artist}`); return { state: "synced", lines, plain: null }; };
  bridge.getDesktopStatus = async () => desktopSnapshot({ media: { state: "paused", title: "Faixa", artist: "Artista", positionMs: 5200, durationMs: 200_000, positionAtMs: Date.now(), canToggle: true } });
  await mount(bridge); await click("Abrir Heydesk"); await click("Player"); await advance(30);
  assert.deepEqual(asked, [], "nada sai antes de abrir a letra");
  await click("Letra"); await advance(30);
  assert.deepEqual(asked, ["Faixa/Artista"]);
  assert.equal(host.querySelector(".lyric-current")?.textContent, "dois");
  assert.deepEqual([...host.querySelectorAll(".lyric-side")].map(node => node.textContent), ["um", "três"]);
  await click("Letra"); assert.equal(host.querySelector(".lyric-current"), null);
});

test("pin mantém o painel aberto com o cursor fora; Escape fecha e desfaz o pin", async () => {
  const { bridge } = fakeBridge(); await mount(bridge); await hover(true); await advance(400);
  assert.ok(host.querySelector("h1"));
  await click("Fixar painel aberto");
  await hover(false); await advance(600);
  assert.ok(host.querySelector("h1"), "fixado não recolhe");
  await act(async () => { host.querySelector("main")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(await closed(), true);
  await hover(true); await advance(400); await hover(false);
  assert.equal(await closed(), true, "pin não sobrevive ao fechamento");
});

test("Sistema em linhas mostra disco livre, rede com curva e Keep Awake liga e desliga", async () => {
  assert.deepEqual([rate(512), rate(20_480), rate(1_258_291), rate(null)], ["512 B/s", "20 KB/s", "1,2 MB/s", "—"]);
  const { bridge } = fakeBridge(); const asked: boolean[] = []; let down = 1000;
  bridge.getKeepAwake = async () => false;
  bridge.setKeepAwake = async on => { asked.push(on); return on; };
  bridge.getDesktopStatus = async () => desktopSnapshot({ cpuPercent: 42, memory: { usedBytes: 8 * 1073741824, totalBytes: 16 * 1073741824 },
    disk: { usedBytes: 400 * 1073741824, totalBytes: 512 * 1073741824 }, network: { downBps: down += 50_000, upBps: 2048 },
    battery: { percent: 80, charging: false, plugged: false, hasBattery: true } });
  await mount(bridge); await click("Abrir Heydesk"); await click("Sistema"); await advance(2200);
  const text = host.querySelector(".system-rows")!.textContent!;
  assert.match(text, /CPU42%/); assert.match(text, /8 de 16 GB/); assert.match(text, /112 GB livres/); assert.match(text, /↑ 2 KB\/s/); assert.match(text, /80% · na bateria/);
  assert.ok(host.querySelector(".spark polyline"), "curva da rede depois de duas leituras");
  await click("Manter o PC acordado");
  assert.equal(host.querySelector('[aria-label="Manter o PC acordado"]')?.getAttribute("aria-checked"), "true");
  await click("Manter o PC acordado");
  assert.deepEqual(asked, [true, false]);
});

test("Início resume player, Claude e tarefas, e os cartões levam às páginas", async () => {
  const { bridge } = fakeBridge(); let saved: unknown;
  bridge.loadNotes = async () => ({ water: { ...defaultWater, reminders: false }, note: "", todos: [{ id: "a", text: "Ligar para o banco", done: false, starred: false, createdAt: 2 }, { id: "b", text: "Revisar PR", done: false, starred: true, createdAt: 3 }, { id: "c", text: "Feita", done: true, starred: false, createdAt: 1 }] });
  bridge.saveNotes = async notes => { saved = notes; return notes; };
  bridge.getClaudeLimits = async () => claudeSnapshot({ state: "available", limits: [claudeLimit({ percent: 45 })] });
  bridge.getDesktopStatus = async () => desktopSnapshot({ media: { state: "playing", title: "Faixa", artist: "Artista" } });
  await mount(bridge); await click("Abrir Heydesk"); await advance(30);
  const text = host.querySelector(".home-page")!.textContent!;
  assert.match(text, /FaixaArtista/); assert.match(text, /Revisar PR/, "favorita primeiro");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>(".home-section-head")].find(button => button.textContent === "Tarefas")!.click());
  assert.equal(host.querySelector("h1")?.textContent, "Tarefas");
  assert.deepEqual([...host.querySelectorAll(".task-text")].map(node => node.textContent), ["Revisar PR", "Ligar para o banco"]);
  await click("Concluir Revisar PR"); await advance(700);
  assert.deepEqual([...host.querySelectorAll(".task-text")].map(node => node.textContent), ["Ligar para o banco"]);
  assert.equal((saved as { todos: { id: string; done: boolean }[] }).todos.find(todo => todo.id === "b")?.done, true);
  await click("Limpar 2 concluídas");
  assert.equal((saved as { todos: unknown[] }).todos.length, 1);
});

// O happy-dom não dispara o onChange de campos controlados a partir de eventos
// sintéticos; chama-se o manipulador que o React registrou no elemento.
function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const key = Object.keys(field).find(name => name.startsWith("__reactProps$"))!;
  (field as unknown as Record<string, { onChange(event: { target: { value: string } }): void }>)[key].onChange({ target: { value } });
}

test("nova tarefa entra por Enter e a nota grava depois de parar de digitar", async () => {
  const { bridge } = fakeBridge(); const saves: { note: string; todos: { text: string }[] }[] = [];
  bridge.loadNotes = async () => ({ note: "", todos: [], water: { ...defaultWater, reminders: false } });
  bridge.saveNotes = async notes => { saves.push(notes); return notes; };
  await mount(bridge); await click("Abrir Heydesk"); await click("Tarefas");
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Nova tarefa"]')!;
  await act(async () => typeInto(input, "  Comprar café  "));
  const props = Object.entries(input).find(([name]) => name.startsWith("__reactProps$"))![1] as { onKeyDown(event: { key: string; preventDefault(): void }): void };
  await act(async () => props.onKeyDown({ key: "Enter", preventDefault() {} }));
  assert.deepEqual(saves.at(-1)?.todos.map(todo => todo.text), ["Comprar café"]);
  assert.equal(input.value, "");
  await click("Nota");
  const area = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Nota rápida"]')!;
  const count = saves.length;
  await act(async () => typeInto(area, "ideia"));
  assert.equal(saves.length, count, "não grava a cada tecla");
  await advance(700);
  assert.equal(saves.at(-1)?.note, "ideia");
});

test("Ask envia a pergunta com o contexto recente e mostra a resposta em pedaços", async () => {
  assert.equal(askPrompt([], "oi"), "oi");
  assert.match(askPrompt([{ question: "a", answer: "b" }, { question: "x", answer: "", error: "falhou" }], "c"), /Você: a\nAssistente: b\n\nPergunta: c/);
  const { bridge } = fakeBridge(); const prompts: string[] = [];
  bridge.ask = async (prompt, onText) => { prompts.push(prompt); onText("Olá, "); onText("tudo bem."); };
  await mount(bridge); await click("Abrir Heydesk"); await click("Perguntar");
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Pergunta ao Claude"]')!;
  await act(async () => typeInto(input, "Quanto é 2+2?"));
  const props = Object.entries(input).find(([name]) => name.startsWith("__reactProps$"))![1] as { onKeyDown(event: { key: string; preventDefault(): void }): void };
  await act(async () => props.onKeyDown({ key: "Enter", preventDefault() {} }));
  await advance(10);
  assert.deepEqual(prompts, ["Quanto é 2+2?"]);
  assert.equal(host.querySelector(".ask-text")?.textContent, "Olá, tudo bem.");
  assert.equal(host.querySelector(".ask-question")?.textContent, "Quanto é 2+2?");
});

test("Ask expandido mostra a conversa inteira; compacto, só a última troca", async () => {
  const { bridge } = fakeBridge(); let n = 0;
  bridge.ask = async (_prompt, onText) => { onText(`resposta ${++n}`); };
  await mount(bridge); await click("Abrir Heydesk"); await click("Perguntar");
  const input = () => host.querySelector<HTMLInputElement>('input[aria-label="Pergunta ao Claude"]')!;
  const send = async (text: string) => {
    await act(async () => typeInto(input(), text));
    const props = Object.entries(input()).find(([name]) => name.startsWith("__reactProps$"))![1] as { onKeyDown(event: { key: string; preventDefault(): void }): void };
    await act(async () => props.onKeyDown({ key: "Enter", preventDefault() {} })); await advance(10);
  };
  await send("um"); await send("dois");
  assert.deepEqual([...host.querySelectorAll(".ask-text")].map(node => node.textContent), ["resposta 2"]);
  await click("Expandir conversa");
  assert.deepEqual([...host.querySelectorAll(".ask-text")].map(node => node.textContent), ["resposta 1", "resposta 2"]);
  assert.equal(host.querySelector(".ask-page")?.hasAttribute("data-tall"), true);
  await click("Limpar conversa");
  assert.equal(host.querySelectorAll(".ask-turn").length, 0);
});

test("lembrete de água no compacto tem os dois botões, recusa conta e o mascote fica bravo", async () => {
  const { bridge } = fakeBridge(); const saves: { water?: { skips?: number[]; snoozeUntil?: number; log: unknown[] } }[] = [];
  // Período do dia inteiro, todos os dias, meta grande: há sempre um gole vencido (exceto nos 10 primeiros minutos do dia).
  const skips = [Date.now() - 60_000, Date.now() - 120_000];
  bridge.loadNotes = async () => ({ note: "", todos: [], water: { goalMl: 10000, cupMl: 50, reminders: true, intervalMin: 60, log: [], bottleMl: 750, bottleLeftMl: 750, startMin: 0, endMin: 1440, days: [0, 1, 2, 3, 4, 5, 6], snooze: true, skips } });
  bridge.saveNotes = async notes => { saves.push(notes); return notes; };
  await mount(bridge); await advance(40);
  const card = host.querySelector(".water-card");
  if (new Date().getHours() === 0 && new Date().getMinutes() < 11) return;
  assert.ok(card, "cartão aparece");
  assert.ok(Number(card!.getAttribute("data-level")) >= 2, "recusas e atraso: bravo");
  assert.ok(card!.querySelector(".mascot[data-expression=angry]"));
  const [no, yes] = [...card!.querySelectorAll("button")];
  assert.match(yes.textContent!, /bebi/i); assert.match(no.textContent!, /rim|bebo|Agora/);
  await act(async () => no.click()); await advance(10);
  assert.equal(saves.at(-1)?.water?.skips?.length, 3);
  assert.ok((saves.at(-1)?.water?.snoozeUntil ?? 0) > Date.now() + 14 * 60_000, "soneca de 15 min");
  assert.equal(host.querySelector(".water-card"), null, "some durante a soneca");
});

test("bebeu com o mascote bravo: ele se acalma, agradece e o cartão some", async () => {
  const { bridge } = fakeBridge();
  const skips = [Date.now() - 60_000, Date.now() - 120_000];
  bridge.loadNotes = async () => ({ note: "", todos: [], water: { ...defaultWater, goalMl: 10000, cupMl: 50, startMin: 0, endMin: 1440, days: [0, 1, 2, 3, 4, 5, 6], skips } });
  bridge.saveNotes = async notes => notes;
  await mount(bridge); await advance(40);
  if (new Date().getHours() === 0 && new Date().getMinutes() < 11) return;
  const yes = [...host.querySelectorAll<HTMLButtonElement>(".water-card button")].at(-1)!;
  await act(async () => yes.click()); await advance(10);
  const thanks = host.querySelector(".water-thanks");
  assert.ok(thanks, "agradecimento no lugar do lembrete");
  assert.ok(thanks!.querySelector(".mascot[data-expression=angry]"), "começa ainda bravo");
  await advance(1100);
  assert.ok(host.querySelector(".water-thanks .mascot[data-expression=happy]"), "termina feliz");
  await advance(2500);
  assert.equal(host.querySelector(".water-thanks"), null);
});

test("Água soma o dia contra a meta, registra o copo e desfaz", async () => {
  const { bridge } = fakeBridge(); const saves: { water?: { log: { ml: number }[] } }[] = [];
  bridge.loadNotes = async () => ({ note: "", todos: [], water: { goalMl: 2000, cupMl: 250, reminders: false, intervalMin: 60, log: [{ at: Date.now() - 60_000, ml: 500 }, { at: Date.now() - 3 * 86_400_000, ml: 900 }] } });
  bridge.saveNotes = async notes => { saves.push(notes); return notes; };
  await mount(bridge); await click("Abrir Heydesk"); await click("Água"); await advance(20);
  assert.match(host.querySelector(".water-ring")!.getAttribute("aria-label")!, /0,5 de 2,0 litros, 25%/);
  assert.match(host.querySelector(".water-title")!.textContent!, /25%/);
  await click("Beber 250 ml"); await advance(10);
  assert.deepEqual(saves.at(-1)?.water?.log.map(drink => drink.ml), [500, 900, 250]);
  assert.match(host.querySelector(".water-title")!.textContent!, /38%/);
  await click("Desfazer último gole");
  assert.deepEqual(saves.at(-1)?.water?.log.map(drink => drink.ml), [500, 900]);
});
