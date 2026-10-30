import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { MascotExpression } from "./Mascot";
import type { MascotLook } from "./useMascotPresence";

export type MascotReaction = { kind: "giggle" | "tickle" | "startle" | "announce" | "away" | "back"; key: number };
export interface MascotTouch { expression: MascotExpression | null; reaction: MascotReaction | null; look: MascotLook }

const doubleClickMs = 260;
const zero: MascotLook = { x: 0, y: 0 };

/** Cócegas: o cursor vai e volta sobre o rosto várias vezes em pouco tempo. */
export function isTickle(reversals: number[], now: number) {
  return reversals.filter(at => now - at <= 700).length >= 4;
}

// Interações diretas com o mascote grande do painel: os olhos seguem o cursor,
// um toque faz rir, dois toques piscam e esfregar o cursor faz cócegas.
export function useMascotTouch(enabled: boolean) {
  const [touch, setTouch] = useState<MascotTouch>({ expression: null, reaction: null, look: zero });
  const key = useRef(0), reset = useRef<number>(), click = useRef<number>();
  const lastX = useRef<number | null>(null), direction = useRef(0), reversals = useRef<number[]>([]);
  const react = useCallback((expression: MascotExpression, kind: MascotReaction["kind"] | null, ms: number) => {
    window.clearTimeout(reset.current);
    setTouch(value => ({ ...value, expression, reaction: kind ? { kind, key: ++key.current } : null }));
    reset.current = window.setTimeout(() => setTouch(value => ({ ...value, expression: null, reaction: null })), ms);
  }, []);
  useEffect(() => () => { window.clearTimeout(reset.current); window.clearTimeout(click.current); }, []);
  useEffect(() => {
    if (enabled) return;
    window.clearTimeout(reset.current); window.clearTimeout(click.current);
    lastX.current = null; reversals.current = [];
    setTouch({ expression: null, reaction: null, look: zero });
  }, [enabled]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const look = { x: Math.max(-3.5, Math.min(3.5, (event.clientX - rect.left - rect.width / 2) / rect.width * 8)), y: Math.max(-1, Math.min(2, (event.clientY - rect.top - rect.height / 2) / rect.height * 4)) };
    setTouch(value => Math.abs(value.look.x - look.x) < .2 && Math.abs(value.look.y - look.y) < .2 ? value : { ...value, look });
    const now = performance.now();
    if (lastX.current != null) {
      const step = Math.sign(event.clientX - lastX.current);
      if (step && direction.current && step !== direction.current) {
        reversals.current = [...reversals.current.filter(at => now - at <= 700), now];
        if (isTickle(reversals.current, now)) { reversals.current = []; react("laugh", "tickle", 1400); }
      }
      if (step) direction.current = step;
    }
    lastX.current = event.clientX;
  }, [enabled, react]);
  const onPointerLeave = useCallback(() => {
    lastX.current = null; direction.current = 0; reversals.current = [];
    setTouch(value => ({ ...value, look: zero }));
  }, []);
  const onClick = useCallback(() => {
    if (!enabled) return;
    if (click.current) { window.clearTimeout(click.current); click.current = undefined; react("wink", null, 900); return; }
    click.current = window.setTimeout(() => { click.current = undefined; react("happy", "giggle", 1100); }, doubleClickMs);
  }, [enabled, react]);
  return { touch, react, handlers: { onPointerMove, onPointerLeave, onClick } };
}
