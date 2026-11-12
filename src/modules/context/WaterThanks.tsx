// Alívio depois do gole: o mascote estressado se acalma (bravo → surpreso → feliz),
// o vermelho some e ele agradece. Dura ~3 s no lugar do cartão do lembrete.
import { useEffect, useState } from "react";
import { Mascot, type EyeShape, type MascotAvatar, type MascotExpression } from "./Mascot";
import { moodImage, type ActiveTheme } from "../theme/useTheme";

const thanks: [string, string][] = [
  ["Isso! 💧", "Um gole a mais pro seu rim. Ele agradece."],
  ["Viu? Nem doeu.", "Obrigado. De verdade. Tô até mais calmo."],
  ["Ufa… obrigado 🥹", "Seu rim te perdoou. Eu também. Quase."],
  ["VOCÊ BEBEU!! 😭", "Eu sabia que você conseguia. Desculpa os gritos."],
];

export const THANKS_MS = 3200;

export function WaterThanks({ level, shape, color, reducedMotion, images = null, pixelated, avatar }: { level: number; shape: EyeShape; color: string; reducedMotion: boolean; images?: ActiveTheme["images"]; pixelated?: boolean; avatar?: MascotAvatar | null }) {
  // Bravo só no começo, se estava bravo; depois surpreso e, por fim, feliz.
  const [step, setStep] = useState(reducedMotion ? 2 : level >= 2 ? 0 : 1);
  useEffect(() => {
    if (reducedMotion) return;
    const timers = [window.setTimeout(() => setStep(value => Math.max(value, 1)), 450), window.setTimeout(() => setStep(2), 1000)];
    return () => timers.forEach(window.clearTimeout);
  }, [reducedMotion]);
  const expression: MascotExpression = step === 0 ? "angry" : step === 1 ? "wide" : "happy";
  const [title, sub] = thanks[Math.max(0, Math.min(3, level))];
  return <div className="water-card water-thanks" role="status" aria-live="polite" data-step={step} data-level={level}>
    <span className="water-card-face"><Mascot expression={expression} image={moodImage(expression, images)} pixelated={pixelated} avatar={avatar} active reducedMotion={reducedMotion} shape={shape} color={step === 0 ? "#ff453a" : color} bounce pace="lively" />
      {!reducedMotion && <span className="water-hearts" aria-hidden="true"><i>♥</i><i>♥</i><i>♥</i></span>}</span>
    <span className="toast-text"><b>{title}</b><span>{sub}</span></span>
  </div>;
}
