import { useCallback, useEffect, useRef, useState } from "react";
import { shellEvents, type ShellBridge } from "../lib/shellBridge";
import { BodySpringDriver, bodyTarget, compactBody, openBody, peekBody, type BodyGoal, type BodySize } from "../modules/motion/spring";
import { containsNotchPoint, notchEdgePath, notchGeometry, notchPath } from "../modules/motion/geometry";

export type IslandPhase = "compact" | "peek" | "open";
export interface IslandPointer { clientX: number; clientY: number }
/** Permanência do hover antes de abrir (timer5 do Nusa, caminho normal). */
export const hoverOpenDelayMs = 250;
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const editingFocus = () => Boolean(document.activeElement?.matches("input, select, textarea, [contenteditable]:not([contenteditable=false])"));

// A janela nativa tem tamanho fixo e é click-through fora da forma; o hover vem
// do hit-test nativo (`shell:pointer`). Sem RPC de tamanho não há fila, época nem
// troca de sistema de coordenadas durante o gesto: o estado é fase + ponteiro.
// `compactSize` alarga o compacto (e o peek) enquanto uma atividade está no ar.
// `openSize` troca o painel padrão por um maior (Ask expandido) enquanto aberto.
// `reach` estende só a área que recebe o mouse para baixo (alça do teleprompter sendo
// puxada: sem isso o cursor sai da forma, a janela vira click-through e o arrasto para).
export function useIsland(bridge: ShellBridge, preventAutoCollapse = false, reducedMotion = false, compactSize: BodySize | null = null, openSize: BodySize | null = null, reach = 0, hold = false) {
  const [phase, setPhase] = useState<IslandPhase>("compact");
  const [panelMounted, setPanelMounted] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState("");
  const [focusTarget, setFocusTarget] = useState<{ expanded: boolean; request: number }>();
  const surface = useRef<SVGSVGElement | null>(null), panel = useRef<HTMLElement | null>(null), compact = useRef<HTMLButtonElement | null>(null);
  const current = useRef<IslandPhase>("compact"), inside = useRef(false), suppressed = useRef(false), hiddenRef = useRef(false);
  const request = useRef(0), openTimer = useRef<number>(), keyboard = useRef(false);
  const published = useRef({ width: 0, height: 0, reach: 0 });
  const extra = useRef(reach);
  extra.current = reach;
  // `hold`: um cartão com botões no compacto (lembrete de água); passar o mouse não abre o painel.
  const holding = useRef(hold);
  holding.current = hold;
  const center = useRef(typeof window === "undefined" ? 340 : window.innerWidth / 2), origin = useRef({ x: 0, y: 0 });
  const blocked = useRef(preventAutoCollapse), previouslyBlocked = useRef(preventAutoCollapse), reduce = useRef(reducedMotion);
  blocked.current = preventAutoCollapse; reduce.current = reducedMotion;
  const wide = useRef<BodySize | null>(compactSize);
  const tall = useRef<BodySize | null>(openSize);
  const goal = useCallback((phase: IslandPhase): BodyGoal => {
    if (phase === "open") return tall.current ?? true;
    const size = wide.current;
    if (!size) return phase === "peek" ? "peek" : false;
    return phase === "peek" ? { width: Math.max(peekBody.width, size.width + 12), height: peekBody.height } : size;
  }, []);

  const paint = useCallback((width: number, height: number) => {
    const progress = (height - compactBody.height) / (openBody.height - compactBody.height), shape = notchGeometry(center.current, width, height);
    // Várias camadas seguem a mesma forma (superfície, arte do tema).
    const d = notchPath(shape);
    surface.current?.querySelectorAll("[data-notch-path]").forEach(path => path.setAttribute("d", d));
    const edge = surface.current?.querySelector("[data-notch-edge]") ? notchEdgePath(shape) : "";
    if (edge) surface.current?.querySelectorAll("[data-notch-edge]").forEach(path => path.setAttribute("d", edge));
    // Arte do painel e ornamentos do tema acompanham o retângulo real do notch.
    const left = shape.center - shape.width / 2;
    surface.current?.querySelectorAll("[data-notch-box]").forEach(box => {
      box.setAttribute("x", String(left - shape.wing)); box.setAttribute("y", "0");
      box.setAttribute("width", String(shape.width + shape.wing * 2)); box.setAttribute("height", String(Math.max(1, height)));
    });
    const ornaments = surface.current?.parentElement?.querySelector<HTMLElement>(".hud-ornaments");
    if (ornaments) {
      ornaments.style.setProperty("--notch-left", `${left}px`);
      ornaments.style.setProperty("--notch-width", `${shape.width}px`);
      ornaments.style.setProperty("--notch-height", `${height}px`);
      ornaments.style.setProperty("--notch-radius", `${shape.radius}px`);
      ornaments.style.setProperty("--notch-wing", `${shape.wing}px`);
    }
    if (panel.current) {
      panel.current.inert = current.current !== "open" || progress < .9;
      panel.current.style.opacity = String(clamp((progress - .6) / .3));
      const full = tall.current ?? openBody;
      panel.current.style.height = `${full.height}px`;
      const side = Math.max(0, (full.width - width) / 2);
      panel.current.style.clipPath = `inset(0 ${side}px ${Math.max(0, full.height - height)}px ${side}px round 0 0 ${shape.radius}px ${shape.radius}px)`;
    }
    if (compact.current) {
      // Fora do painel o compacto acompanha a largura do corpo: a atividade abre
      // para os lados levando hora e bateria junto com as bordas.
      const base = wide.current?.width ?? compactBody.width;
      // Avisos em meio-notch deixam o compacto mais alto; ele só some acima dessa altura.
      const rest = Math.max(compactBody.height, wide.current?.height ?? compactBody.height);
      const inner = current.current === "open" ? base : Math.max(compactBody.width, width);
      compact.current.style.width = `${inner}px`; compact.current.style.marginLeft = `${-inner / 2}px`;
      compact.current.style.height = `${rest}px`;
      compact.current.style.opacity = String(clamp(1 - Math.max(0, height - rest) / (openBody.height - rest) * 4));
      const side = Math.max(0, (inner - width) / 2);
      const radius = rest > compactBody.height ? Math.min(shape.radius, 24) : 15;
      compact.current.style.clipPath = `inset(0 ${side}px ${Math.max(0, rest - height)}px ${side}px round 0 0 ${radius}px ${radius}px)`;
    }
  }, []);
  const [body] = useState(() => new BodySpringDriver(paint));
  const measure = useCallback(() => {
    const rect = surface.current?.getBoundingClientRect();
    if (rect && rect.width > 0) { center.current = rect.width / 2; origin.current = { x: rect.left, y: rect.top }; }
    else { center.current = window.innerWidth / 2; origin.current = { x: 0, y: 0 }; }
    paint(body.width, body.height);
  }, [body, paint]);
  const surfaceRef = useCallback((node: SVGSVGElement | null) => { surface.current = node; measure(); }, [measure]);
  const panelRef = useCallback((node: HTMLElement | null) => { panel.current = node; paint(body.width, body.height); }, [body, paint]);
  const compactRef = useCallback((node: HTMLButtonElement | null) => { compact.current = node; paint(body.width, body.height); }, [body, paint]);

  // Em movimento o hit-test usa a maior forma entre a atual e o alvo; no repouso,
  // exatamente o alvo. Voltar ao painel que encolhe reverte o fechamento.
  const publish = useCallback((target: BodyGoal, settled: boolean) => {
    const goal = bodyTarget(target);
    const width = settled ? goal.width : Math.max(goal.width, published.current.width);
    const height = settled ? goal.height : Math.max(goal.height, published.current.height);
    if (width === published.current.width && height === published.current.height && extra.current === published.current.reach) return;
    published.current = { width, height, reach: extra.current };
    const { radius, wing } = notchGeometry(0, width, height);
    const hit = Math.min(440, height + extra.current);
    if (bridge.desktop) void Promise.resolve().then(() => bridge.setHitShape({ width, height: hit, radius, wing }))
      .catch(() => setError("Não foi possível ajustar a ilha. Tente novamente."));
  }, [bridge]);
  // Alça agarrada ou solta sem mudar o tamanho: só a área do mouse muda.
  useEffect(() => {
    const { width, height } = published.current;
    if (!width || reach === published.current.reach) return;
    published.current = { width, height, reach };
    const { radius, wing } = notchGeometry(0, width, height);
    if (bridge.desktop) void Promise.resolve().then(() => bridge.setHitShape({ width, height: Math.min(440, height + reach), radius, wing })).catch(() => {});
  }, [bridge, reach]);

  const go = useCallback((next: IslandPhase, focus = false, immediate = false, keepTimer = false) => {
    if (!keepTimer) window.clearTimeout(openTimer.current);
    const id = ++request.current, target = goal(next);
    current.current = next; setPhase(next);
    if (next === "open") setPanelMounted(true);
    else if (panel.current) panel.current.inert = true;
    publish(target, false);
    void body.animateTo(target, immediate || reduce.current).then(settled => {
      if (!settled || id !== request.current) return;
      publish(target, true);
      if (next !== "open") setPanelMounted(false);
      if (focus) setFocusTarget({ expanded: next === "open", request: id });
    });
  }, [body, goal, publish]);

  const autoCollapse = useCallback(() => {
    if (current.current !== "open" || inside.current || blocked.current || hiddenRef.current || editingFocus()) return;
    go("compact");
  }, [go]);

  const setPointer = useCallback((value: boolean) => {
    if (hiddenRef.current) value = false;
    if (inside.current === value) return;
    inside.current = value; setHovered(value);
    if (!value) {
      suppressed.current = false;
      if (current.current === "peek") go("compact"); else autoCollapse();
      return;
    }
    if (suppressed.current || current.current === "open" || holding.current) return;
    if (body.width > bodyTarget(goal("peek")).width + 1) { go("open"); return; }
    go("peek");
    openTimer.current = window.setTimeout(() => {
      if (inside.current && current.current === "peek" && !hiddenRef.current) go("open");
    }, hoverOpenDelayMs);
  }, [autoCollapse, body, go, goal]);

  // Pedido explícito vence o hover. Recolher com o cursor parado sobre a ilha não
  // reabre até o ponteiro sair da forma. Teclado troca sem mola, com foco imediato.
  const change = useCallback((next: boolean, focus = true, immediate = false) => {
    if (hiddenRef.current && !next) return;
    suppressed.current = !next && inside.current;
    go(next ? "open" : "compact", focus, immediate);
  }, [go]);
  // O blur chega antes de o foco pousar no destino; decidir no próximo turno. Foco
  // ainda dentro do painel, vindo do teclado, é navegação em curso. A desativação da
  // janela nativa (clique em outro app) chega como blur da window, tratado abaixo.
  const resumeAutoCollapse = useCallback(() => {
    window.setTimeout(() => { if (!(keyboard.current && panel.current?.contains(document.activeElement))) autoCollapse(); }, 0);
  }, [autoCollapse]);
  useEffect(() => {
    if (previouslyBlocked.current && !preventAutoCollapse) resumeAutoCollapse();
    previouslyBlocked.current = preventAutoCollapse;
  }, [preventAutoCollapse, resumeAutoCollapse]);

  const markHidden = useCallback(() => {
    request.current++; window.clearTimeout(openTimer.current);
    hiddenRef.current = true; current.current = "compact"; inside.current = false; suppressed.current = false;
    setHidden(true); setHovered(false); setPhase("compact"); setPanelMounted(false);
    void body.animateTo(false, true); publish(false, true);
  }, [body, publish]);
  const reveal = useCallback(() => { hiddenRef.current = false; setHidden(false); setError(""); }, []);

  // Preview no navegador: mesma regra, alimentada pelo DOM. No desktop o DOM não
  // recebe eventos fora da forma, então só o sinal nativo decide.
  const pointerMove = useCallback((event: IslandPointer) => {
    if (bridge.desktop) return;
    const shape = notchGeometry(center.current, published.current.width, published.current.height);
    setPointer(containsNotchPoint(shape, event.clientX - origin.current.x, event.clientY - origin.current.y, inside.current ? 3 : 0));
  }, [bridge.desktop, setPointer]);
  const pointerLeave = useCallback(() => { if (!bridge.desktop) setPointer(false); }, [bridge.desktop, setPointer]);

  async function hide() {
    if (!bridge.desktop) return;
    markHidden();
    try { await bridge.hide(); }
    catch { reveal(); setError("Não foi possível ocultar a ilha. Tente novamente."); }
  }

  useEffect(() => { publish(false, true); }, [publish]);
  useEffect(() => {
    const deactivated = (event: FocusEvent) => { if (event.target === window) autoCollapse(); };
    const typed = () => { keyboard.current = true; }, pointed = () => { keyboard.current = false; };
    window.addEventListener("blur", deactivated);
    window.addEventListener("keydown", typed, true);
    window.addEventListener("pointerdown", pointed, true);
    return () => { window.removeEventListener("blur", deactivated); window.removeEventListener("keydown", typed, true); window.removeEventListener("pointerdown", pointed, true); };
  }, [autoCollapse]);

  useEffect(() => { if (reducedMotion && body.moving) go(current.current); }, [body, go, reducedMotion]);
  // Atividade nova muda só o tamanho do compacto/peek; a fase e o timer de
  // abertura do hover seguem como estavam.
  useEffect(() => {
    const before = wide.current;
    wide.current = compactSize;
    if (before?.width === compactSize?.width && before?.height === compactSize?.height) return;
    if (current.current !== "open" && !hiddenRef.current) go(current.current, false, false, true);
  }, [compactSize?.width, compactSize?.height, go]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const before = tall.current;
    tall.current = openSize;
    if (before?.height === openSize?.height && before?.width === openSize?.width) return;
    if (current.current === "open" && !hiddenRef.current) go("open", false, false, true);
  }, [openSize?.width, openSize?.height, go]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (surface.current) observer?.observe(surface.current);
    return () => { window.removeEventListener("resize", measure); observer?.disconnect(); };
  }, [measure]);
  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const handlers: [typeof shellEvents[keyof typeof shellEvents], (payload: unknown) => void][] = [
      [shellEvents.open, () => { reveal(); keyboard.current = true; change(true, true); }],
      [shellEvents.collapse, () => change(false, false)],
      [shellEvents.hidden, () => markHidden()],
      [shellEvents.pointer, payload => setPointer(payload === true)],
    ];
    void (async () => {
      if (!bridge.desktop) return;
      try {
        for (const [event, handler] of handlers) {
          const cleanup = await bridge.listen(event, payload => { if (!disposed) handler(payload); });
          if (disposed) { cleanup(); return; }
          cleanups.push(cleanup);
        }
      } catch { if (!disposed) setError("Não foi possível conectar a bandeja. Reabra o aplicativo para tentar novamente."); }
    })();
    return () => { disposed = true; request.current++; window.clearTimeout(openTimer.current); body.cancel(); cleanups.forEach(cleanup => cleanup()); };
  }, [body, bridge, change, markHidden, reveal, setPointer]);

  return { phase, expanded: phase === "open", viewportExpanded: panelMounted, peeking: phase === "peek", hovered, hidden, error, focusTarget,
    change, hide, pointerMove, pointerLeave, resumeAutoCollapse, surfaceRef, panelRef, compactRef };
}
