// Dicas do notch: o title nativo quase não aparece numa janela transparente sem foco,
// então todo botão com title ou aria-label ganha uma dica própria após uma pausa curta.
// Os ícones do dock têm a dica deles (CSS) e ficam de fora.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

const TARGET = "[title], [data-tip], button[aria-label], [role=button][aria-label], [role=separator][aria-label]";
interface Tip { text: string; x: number; y: number; below: boolean }

export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let timer = 0, current: HTMLElement | null = null;
    const hide = () => { window.clearTimeout(timer); current = null; setTip(null); };
    const over = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>(TARGET) : null;
      if (target === current) return;
      hide();
      if (!target || target.matches(".page-dock .tick")) return;
      current = target;
      // Sem o title, o navegador não mostra a dica nativa por cima da nossa.
      if (target.title) { target.dataset.tip = target.title; target.removeAttribute("title"); }
      const text = target.dataset.tip || target.getAttribute("aria-label");
      if (!text) return;
      timer = window.setTimeout(() => {
        if (!target.isConnected) return;
        const rect = target.getBoundingClientRect();
        const below = rect.top < 40;
        setTip({ text, x: rect.left + rect.width / 2, y: below ? rect.bottom + 6 : rect.top - 6, below });
      }, 450);
    };
    const out = (event: PointerEvent) => { if (!event.relatedTarget) hide(); };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("wheel", hide, { passive: true });
    window.addEventListener("blur", hide);
    return () => {
      hide();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("wheel", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);
  // Mantém a dica dentro da janela.
  useLayoutEffect(() => {
    const element = node.current;
    if (!element || !tip) return;
    const half = element.offsetWidth / 2;
    element.style.left = `${Math.min(window.innerWidth - half - 6, Math.max(half + 6, tip.x))}px`;
  }, [tip]);
  if (!tip) return null;
  return <div className="hd-tooltip" ref={node} role="tooltip" data-below={tip.below || undefined} style={{ left: tip.x, top: tip.y }}>{tip.text}</div>;
}
