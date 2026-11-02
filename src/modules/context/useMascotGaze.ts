// Olhar que segue o cursor: ao acordar (sai do cochilo) por ~4 s e, de vez em quando
// (a cada 2–5 min, sorteado), por ~3 s. Fora dessas janelas não lê nada.
import { useEffect, useRef, useState } from "react";
import type { MascotLook, MascotPhase, NotchInteractionSnapshot } from "./useMascotPresence";
import { lookSource, type LookSource } from "./useMascotTouch";

interface GazeBridge { desktop: boolean; getNotchInteraction?(): Promise<NotchInteractionSnapshot> }
const WAKE_MS = 4000, PEEK_MS = 3000, STEP_MS = 120;
const nextPeek = () => (2 + Math.random() * 3) * 60_000;
const bound = (look: MascotLook) => ({ x: Math.max(-3.5, Math.min(3.5, look.x)), y: Math.max(-1, Math.min(2, look.y)) });

// Cada amostra (a cada 120 ms) vai direto para o mascote; o React só rerenderiza ao abrir e fechar a janela.
export function useMascotGaze(bridge: GazeBridge, phase: MascotPhase, enabled: boolean): LookSource | null {
  const [source] = useState(lookSource);
  const [following, setFollowing] = useState(false);
  const [until, setUntil] = useState(0);
  const previous = useRef(phase);
  // Acordou: estava dormindo/cochilando e voltou.
  useEffect(() => {
    const was = previous.current; previous.current = phase;
    if (enabled && (was === "rest" || was === "drowsy") && phase !== "rest" && phase !== "drowsy") setUntil(Date.now() + WAKE_MS);
  }, [phase, enabled]);
  // De vez em quando, acordado e parado no compacto.
  useEffect(() => {
    if (!enabled || phase === "rest" || phase === "drowsy") return;
    const timer = window.setTimeout(() => setUntil(Date.now() + PEEK_MS), nextPeek());
    return () => window.clearTimeout(timer);
  }, [enabled, phase, until]);
  // Durante a janela, acompanha o cursor; ao fim, volta ao olhar normal.
  useEffect(() => {
    if (!enabled || !bridge.getNotchInteraction || until <= Date.now()) { setFollowing(false); return; }
    let active = true, timer = 0;
    const step = async () => {
      if (!active) return;
      if (Date.now() >= until) { setFollowing(false); return; }
      try {
        const value = await bridge.getNotchInteraction!();
        if (active && value.look) {
          const next = bound(value.look), current = source.get();
          if (Math.abs(current.x - next.x) >= .15 || Math.abs(current.y - next.y) >= .15) source.set(next);
          setFollowing(true);
        }
      } catch { /* sem leitura, sem olhar */ }
      if (active) timer = window.setTimeout(() => void step(), STEP_MS);
    };
    void step();
    return () => { active = false; window.clearTimeout(timer); };
  }, [bridge, enabled, until, source]);
  return following ? source : null;
}
