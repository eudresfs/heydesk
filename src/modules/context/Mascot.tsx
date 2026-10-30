import { useEffect, useRef, useState } from "react";
import type { MascotLook } from "./useMascotPresence";

export type MascotExpression = "normal" | "wide" | "happy" | "sleep" | "worried" | "sleepy" | "yawn" | "wink" | "laugh" | "angry";

// Mesmo desenho em dois tamanhos: no compacto (30 × 16) e na coluna do painel
// aberto (62 × 33). Os olhos do Nusa medem 8,4 × 12,4 com 15 px entre eles.
export type EyeShape = "oval" | "round" | "pixel" | "line" | "heart";
const heart = (x: number) => `M${x} 11.6c-3-1.9-4.6-3.6-4.6-5.4a2.4 2.4 0 0 1 4.6-1 2.4 2.4 0 0 1 4.6 1c0 1.8-1.6 3.5-4.6 5.4z`;
/** Olhos neutros/abertos no formato escolhido; as demais expressões são traços. */
function ShapedEyes({ shape, wide }: { shape: EyeShape; wide: boolean }) {
  if (shape === "round") { const r = wide ? 4.5 : 3.7; return <g><circle className="mascot-eye" cx="6.5" cy="8" r={r} fill="currentColor" /><circle className="mascot-eye" cx="23.5" cy="8" r={r} fill="currentColor" /></g>; }
  if (shape === "pixel") { const [w, h] = wide ? [7.4, 9.4] : [6.2, 7.6]; return <g>{[6.5, 23.5].map(x => <rect key={x} className="mascot-eye" x={x - w / 2} y={8 - h / 2} width={w} height={h} rx=".9" fill="currentColor" />)}</g>; }
  if (shape === "line") { const h = wide ? 4.2 : 2.8; return <g>{[6.5, 23.5].map(x => <rect key={x} className="mascot-eye" x={x - 4} y={8 - h / 2} width="8" height={h} rx={h / 2} fill="currentColor" />)}</g>; }
  if (shape === "heart") return <g transform={wide ? "translate(0 -.6) scale(1)" : undefined}>{[6.5, 23.5].map(x => <path key={x} className="mascot-eye" d={heart(x)} fill="currentColor" />)}</g>;
  const [rx, ry] = wide ? [4.2, 6.4] : [3.4, 5.2];
  return <g><ellipse className="mascot-eye" cx="6.5" cy="8" rx={rx} ry={ry} fill="currentColor" /><ellipse className="mascot-eye" cx="23.5" cy="8" rx={rx} ry={ry} fill="currentColor" /></g>;
}
function Eyes({ expression, shape }: { expression: MascotExpression; shape: EyeShape }) {
  if (expression === "happy") return <path className="mascot-happy" d="M3 10.5Q6.5 3.5 10 10.5M20 10.5Q23.5 3.5 27 10.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />;
  if (expression === "sleep") return <path d="M3 9h7M20 9h7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />;
  if (expression === "yawn") return <g className="mascot-yawn">
    <path d="M3 7.5q3.5 2 7 0M20 7.5q3.5 2 7 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <ellipse cx="15" cy="12.6" rx="2" ry="2.4" fill="currentColor" />
  </g>;
  // Pálpebra baixa: noite ou cansaço. Metade de cima dos olhos coberta.
  if (expression === "sleepy") return <g><path d="M3.1 8.6h6.8v.4a3.4 3.4 0 0 1-6.8 0zM20.1 8.6h6.8v.4a3.4 3.4 0 0 1-6.8 0z" fill="currentColor" /></g>;
  if (expression === "laugh") return <path d="M4 5l5 3.5-5 3.5M26 5l-5 3.5 5 3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />;
  if (expression === "wink") return <g>
    <ellipse className="mascot-eye" cx="6.5" cy="8" rx="3.4" ry="5.2" fill="currentColor" />
    <path d="M20 9.5Q23.5 6.5 27 9.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
  </g>;
  if (expression === "worried") return <g>
    <ellipse cx="6.5" cy="9.6" rx="3.5" ry="4.6" fill="currentColor" /><ellipse cx="23.5" cy="9.6" rx="3.5" ry="4.6" fill="currentColor" />
    <path d="M2.6 3.4l7 1.8M27.4 3.4l-7 1.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </g>;
  // Bravo (lembrete de água ignorado): topo dos olhos cortado em diagonal, descendo para o centro.
  if (expression === "angry") return <g>
    <path className="mascot-eye" d="M2.8 4.2L10.2 7.6v3a3.7 3.7 0 0 1-7.4 0z" fill="currentColor" />
    <path className="mascot-eye" d="M27.2 4.2L19.8 7.6v3a3.7 3.7 0 0 0 7.4 0z" fill="currentColor" />
  </g>;
  return <ShapedEyes shape={shape} wide={expression === "wide"} />;
}

export function Mascot({ expression, size = "small", active, reducedMotion, look = { x: 0, y: 0 }, reaction, shape = "oval", color, blink = true, bounce = true, pace = "calm" }: {
  expression: MascotExpression; size?: "small" | "large"; active: boolean; reducedMotion: boolean; look?: MascotLook;
  /** Animação curta de corpo (toque, cócegas, anúncio); a chave reinicia a animação. */
  shape?: EyeShape; color?: string; blink?: boolean; bounce?: boolean; pace?: "calm" | "lively";
  reaction?: { kind: "giggle" | "tickle" | "startle" | "announce" | "away" | "back"; key: number } | null;
}) {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const animated = active && visible && !reducedMotion;
  // Piscar por timer (180 ms a cada ~4 s) em vez de animação infinita: o renderizador
  // fica parado entre as piscadas, o dia todo.
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!animated || !blink) return;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        root.current?.setAttribute("data-blinking", "");
        timer = window.setTimeout(() => { root.current?.removeAttribute("data-blinking"); schedule(); }, 180);
      }, (pace === "lively" ? 2600 : 4200) * (.75 + Math.random() * .5));
    };
    schedule();
    return () => { window.clearTimeout(timer); root.current?.removeAttribute("data-blinking"); };
  }, [animated, blink, pace]);
  const x = animated && Number.isFinite(look.x) ? Math.max(-3.5, Math.min(3.5, look.x)) : 0;
  const y = animated && Number.isFinite(look.y) ? Math.max(-1, Math.min(2, look.y)) : 0;
  const scale = size === "large" ? 2.07 : 1;
  return <span className="mascot" ref={root} aria-hidden="true" data-size={size} data-expression={expression} data-animated={animated} data-reaction={animated && reaction ? reaction.kind : undefined} data-away={reaction?.kind === "away" && !animated ? "" : undefined} data-blink={blink} data-bounce={bounce} data-pace={pace} style={color ? { color } : undefined}>
    <svg key={animated && reaction ? reaction.key : undefined} width={30 * scale} height={16 * scale} viewBox="0 0 30 16">
      <g className="mascot-look" style={{ transform: `translate(${x}px, ${y}px)` }}><Eyes expression={expression} shape={shape} /></g>
    </svg>
  </span>;
}
