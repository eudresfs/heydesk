// Camada de realce (janela transparente sobre a tela): halo no cursor e anel a cada clique.
// A posição vem do Rust em pixels físicos; aqui vira CSS px.
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

interface Pointer { x: number; y: number; left: boolean; right: boolean }
interface Ripple { id: number; x: number; y: number; right: boolean }

export function CursorOverlay() {
  const halo = useRef<HTMLDivElement>(null);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const previous = useRef<Pointer | null>(null);
  useEffect(() => {
    let id = 0;
    const stop = listen<Pointer>("cursor:pointer", ({ payload }) => {
      const scale = window.devicePixelRatio || 1, x = payload.x / scale, y = payload.y / scale;
      // `translate` (não `transform`): o `scale` do clique encolhe o halo sem mover a posição.
      if (halo.current) halo.current.style.translate = `${x}px ${y}px`;
      halo.current?.toggleAttribute("data-down", payload.left || payload.right);
      const before = previous.current;
      if ((payload.left && !before?.left) || (payload.right && !before?.right)) {
        const ripple = { id: ++id, x, y, right: payload.right && !before?.right };
        setRipples(list => [...list.slice(-6), ripple]);
        window.setTimeout(() => setRipples(list => list.filter(item => item.id !== ripple.id)), 650);
      }
      previous.current = payload;
    });
    return () => { void stop.then(fn => fn()); };
  }, []);
  return <div className="cursor-overlay">
    <div className="cursor-halo" ref={halo} />
    {ripples.map(ripple => <span key={ripple.id} className="cursor-ripple" data-right={ripple.right || undefined} style={{ left: ripple.x, top: ripple.y }} />)}
  </div>;
}
