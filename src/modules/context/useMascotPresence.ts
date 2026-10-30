import { useEffect, useRef, useState } from "react";

export type MascotPhase = "context" | "drowsy" | "rest" | "greeting" | "attention";
export interface MascotLook { x: number; y: number }
export interface NotchInteractionSnapshot { idleMs: number | null; look: MascotLook | null }
interface PresenceBridge { desktop: boolean; getNotchInteraction?(): Promise<NotchInteractionSnapshot> }
export interface MascotOptions { enabled: boolean; hovered: boolean; playing: boolean; reducedMotion: boolean }
export interface MascotPresence { phase: MascotPhase; look: MascotLook }
export interface MascotMachine extends MascotPresence { greetingUntil: number; rested: boolean }

const zero: MascotLook = { x: 0, y: 0 };
export const mascotIdleMs = 15_000;
/** Antes de cochilar o mascote boceja: humor, não estado de rede ou de foco. */
export const mascotDrowsyMs = 11_000;
export const initialMascotMachine: MascotMachine = { phase: "context", look: zero, greetingUntil: 0, rested: false };
function boundedLook(value: MascotLook | null): MascotLook {
  return value && Number.isFinite(value.x) && Number.isFinite(value.y)
    ? { x: Math.max(-3.5, Math.min(3.5, value.x)), y: Math.max(-1, Math.min(2, value.y)) } : zero;
}

// A direção é amostrada no retorno; não se presume rastreamento contínuo do Nusa.
export function advanceMascotPresence(previous: MascotMachine, sample: NotchInteractionSnapshot,
  options: MascotOptions, now: number): MascotMachine {
  if (!options.enabled) return initialMascotMachine;
  const knownIdle = sample.idleMs != null && Number.isFinite(sample.idleMs) && sample.idleMs >= 0;
  const idle = knownIdle && sample.idleMs! >= mascotIdleMs;
  let { greetingUntil, rested, look } = previous;
  if (options.playing) { greetingUntil = 0; rested = false; look = zero; }
  else if (idle && !options.hovered) { return { phase: "rest", look: zero, greetingUntil: 0, rested: true }; }
  else if (rested && ((knownIdle && !idle) || options.hovered)) {
    greetingUntil = now + 800; rested = false; look = boundedLook(sample.look);
  }
  // Hover só muda a expressão de um mascote que já está fora. Sobre o compacto
  // em contexto, relógio e clima continuam visíveis durante o pré-hover.
  const out = previous.phase !== "context" || greetingUntil > now;
  const drowsy = !options.playing && !options.hovered && knownIdle && sample.idleMs! >= mascotDrowsyMs;
  const phase = options.hovered && out ? "attention" : greetingUntil > now ? "greeting" : drowsy ? "drowsy" : "context";
  if (phase === "context" || options.reducedMotion) look = zero;
  return { phase, look, greetingUntil, rested };
}

export function useMascotPresence(bridge: PresenceBridge, options: MascotOptions): MascotPresence {
  const [visible, setVisible] = useState(() => !document.hidden);
  const [presence, setPresence] = useState<MascotPresence>({ phase: "context", look: zero });
  const published = useRef<MascotPresence>(presence);
  const current = useRef({ ...options, enabled: options.enabled && visible });
  current.current = { ...options, enabled: options.enabled && visible };
  const machine = useRef<MascotMachine>(initialMascotMachine);
  const latest = useRef<{ value: NotchInteractionSnapshot; at: number } | null>(null);
  const localInput = useRef<{ at: number; look: MascotLook } | null>(null);
  const visibilityEpoch = useRef({ enabled: false, startedAt: Date.now() });
  const pending = useRef<Promise<NotchInteractionSnapshot> | null>(null);
  const greetingTimer = useRef<number>();
  const evaluate = useRef<() => void>(() => {});
  evaluate.current = () => {
    const now = Date.now();
    if (!current.current.enabled) visibilityEpoch.current.enabled = false;
    else if (!visibilityEpoch.current.enabled) {
      // Reabrir o compacto inicia uma observação nova da UI. Tempo expandido
      // ou oculto não prova repouso nem uma nova entrada global do usuário.
      visibilityEpoch.current = { enabled: true, startedAt: now };
      latest.current = null; localInput.current = null;
      machine.current = initialMascotMachine;
    }
    const sensor = latest.current;
    const local = localInput.current;
    let idleMs = sensor?.value.idleMs;
    if (idleMs != null && Number.isFinite(idleMs) && idleMs >= 0) {
      idleMs += Math.max(0, now - sensor!.at);
      if (local) idleMs = Math.min(idleMs, Math.max(0, now - local.at));
    } else idleMs = Math.max(0, now - (local?.at ?? visibilityEpoch.current.startedAt));
    const look = local && (!sensor || local.at >= sensor.at) ? local.look : sensor?.value.look ?? zero;
    const next = advanceMascotPresence(machine.current, { idleMs, look }, current.current, now);
    machine.current = next;
    if (published.current.phase !== next.phase || published.current.look.x !== next.look.x || published.current.look.y !== next.look.y) {
      published.current = { phase: next.phase, look: next.look };
      setPresence(published.current);
    }
    window.clearTimeout(greetingTimer.current);
    if (current.current.enabled && next.greetingUntil > now) {
      greetingTimer.current = window.setTimeout(() => evaluate.current(), next.greetingUntil - now);
    }
  };

  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => { evaluate.current(); }, [options.enabled, options.hovered, options.playing, options.reducedMotion, visible]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    if (!options.enabled || !visible) return;
    function noteInput(event: Event) {
      const pointer = "clientX" in event && "clientY" in event ? event as PointerEvent : null;
      localInput.current = { at: Date.now(), look: pointer ? boundedLook({ x: (pointer.clientX - window.innerWidth / 2) / 60, y: pointer.clientY / 80 }) : zero };
      evaluate.current();
    }
    const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    events.forEach(event => window.addEventListener(event, noteInput, { capture: true, passive: true }));
    async function poll() {
      if (pending.current) { try { await pending.current; } catch {} }
      if (!active) return;
      if (bridge.desktop && bridge.getNotchInteraction) {
        const task = Promise.resolve().then(() => bridge.getNotchInteraction!());
        pending.current = task;
        try {
          const value = await task;
          if (active && value.idleMs != null && Number.isFinite(value.idleMs) && value.idleMs >= 0) {
            latest.current = { value, at: Date.now() };
          }
        } catch {
          // Falha da leitura não é nova entrada do usuário. Uma observação
          // aceita pode envelhecer; entrada local ainda provoca retorno real.
        } finally { if (pending.current === task) pending.current = null; }
      }
      if (!active) return;
      evaluate.current();
      timer = window.setTimeout(() => void poll(), 1500); // limiares de 11 s e 15 s não precisam de mais
    }
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer); window.clearTimeout(greetingTimer.current);
      events.forEach(event => window.removeEventListener(event, noteInput, true));
      latest.current = null;
    };
  }, [bridge, options.enabled, visible]);
  useEffect(() => () => window.clearTimeout(greetingTimer.current), []);
  return presence;
}
