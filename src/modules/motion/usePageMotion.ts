import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// Transição curta do conteúdo; não reutiliza a cauda da mola do corpo.
export function usePageMotion<T extends string>(initial: T, reducedMotion: boolean) {
  const [layers, setLayers] = useState<{ current: T; previous: T | null; direction: number }>({ current: initial, previous: null, direction: 1 });
  const current = useRef(initial);
  const container = useRef<HTMLDivElement>(null);
  const epoch = useRef(0);
  const running = useRef<Animation[]>([]);
  const cancel = useCallback(() => { epoch.current++; running.current.forEach(animation => animation.cancel()); running.current = []; }, []);
  const move = useCallback((next: T, direction = 1, immediate = false) => {
    if (next === current.current) return;
    const previous = current.current;
    const interrupt = running.current.length > 0;
    cancel(); current.current = next;
    setLayers({ current: next, previous: reducedMotion || immediate || interrupt ? null : previous, direction });
  }, [cancel, reducedMotion]);
  useLayoutEffect(() => {
    if (!layers.previous) return;
    const incoming = container.current?.querySelector<HTMLElement>('[data-page-layer="incoming"]');
    const outgoing = container.current?.querySelector<HTMLElement>('[data-page-layer="outgoing"]');
    if (!incoming || !outgoing || typeof incoming.animate !== "function" || reducedMotion) {
      setLayers(value => ({ ...value, previous: null })); return;
    }
    const id = epoch.current;
    const direction = Math.sign(layers.direction) || 1;
    // Paginação vertical: as duas páginas andam juntas a altura inteira do viewport,
    // que recorta. Com deslocamento curto elas se sobrepunham no mesmo lugar (medido
    // na janela real: textos das duas páginas misturados por ~50 ms).
    const timing = { duration: 280, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'forwards' as const };
    const enter = incoming.animate([{ opacity: .4, filter: 'blur(3px)', transform: `translateY(${direction * 100}%)` }, { opacity: 1, filter: 'blur(0)', transform: 'translateY(0)' }], timing);
    const leave = outgoing.animate([{ opacity: 1, filter: 'blur(0)', transform: 'translateY(0)' }, { opacity: .4, filter: 'blur(3px)', transform: `translateY(${-direction * 100}%)` }], timing);
    running.current = [enter, leave];
    // A camada que sai é desmontada com o fill ainda aplicado; cancelar antes a
    // devolvia ao lugar por um quadro (piscada medida na janela real).
    void Promise.all([enter.finished, leave.finished]).then(() => {
      if (id === epoch.current) { running.current = []; enter.cancel(); setLayers(value => ({ ...value, previous: null })); }
    }).catch(() => {});
    return () => { enter.cancel(); leave.cancel(); };
  }, [layers.current, layers.previous, layers.direction, reducedMotion]);
  useEffect(() => { if (reducedMotion) { cancel(); setLayers(value => ({ ...value, previous: null })); } }, [cancel, reducedMotion]);
  useEffect(() => () => cancel(), [cancel]);
  return { ...layers, ref: container, move };
}
